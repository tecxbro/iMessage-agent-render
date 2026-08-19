export const UNTRUSTED_MEMORY_TRUST = "untrusted_context" as const;

export interface MemoryContent {
  text: string;
}

export interface MemoryBudget {
  maxItems: number;
  maxItemCharacters: number;
  maxTotalCharacters: number;
}

export interface UntrustedMemoryContent {
  text: string;
  trust: typeof UNTRUSTED_MEMORY_TRUST;
}

export interface BoundedMemoryContent {
  items: readonly UntrustedMemoryContent[];
  totalCharacters: number;
  truncated: boolean;
}

export const DEFAULT_CACHED_OWNER_PROFILE_BUDGET: MemoryBudget = {
  maxItems: 8,
  maxItemCharacters: 1_000,
  maxTotalCharacters: 4_000,
};

export const DEFAULT_REMOTE_MEMORY_BUDGET: MemoryBudget = {
  maxItems: 8,
  maxItemCharacters: 1_000,
  maxTotalCharacters: 4_000,
};

function assertNonnegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }
}

export function validateMemoryBudget(budget: MemoryBudget): MemoryBudget {
  assertNonnegativeInteger(budget.maxItems, "maxItems");
  assertNonnegativeInteger(
    budget.maxItemCharacters,
    "maxItemCharacters",
  );
  assertNonnegativeInteger(
    budget.maxTotalCharacters,
    "maxTotalCharacters",
  );
  return { ...budget };
}

function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function truncateText(text: string, maximumCharacters: number): string {
  if (text.length <= maximumCharacters) {
    return text;
  }
  if (maximumCharacters <= 1) {
    return text.slice(0, maximumCharacters);
  }
  return `${text.slice(0, maximumCharacters - 1)}…`;
}

/**
 * Converts provider/cache text into prompt-safe context metadata while
 * enforcing count, per-item, and aggregate character limits. The trust label
 * is code-owned; callers cannot promote memory into policy or authorization.
 */
export function boundUntrustedMemory(
  content: readonly unknown[],
  configuredBudget: MemoryBudget,
): BoundedMemoryContent {
  const budget = validateMemoryBudget(configuredBudget);
  const items: UntrustedMemoryContent[] = [];
  let totalCharacters = 0;
  let truncated = false;
  const maximumCandidates = Math.max(1, budget.maxItems) * 4;

  if (
    content.length === 0 ||
    budget.maxItems === 0 ||
    budget.maxItemCharacters === 0 ||
    budget.maxTotalCharacters === 0
  ) {
    return {
      items,
      totalCharacters,
      truncated: content.length > 0,
    };
  }

  for (const [index, candidate] of content.entries()) {
    if (index >= maximumCandidates) {
      truncated = true;
      break;
    }
    const remainingCharacters = budget.maxTotalCharacters - totalCharacters;
    if (items.length >= budget.maxItems || remainingCharacters <= 0) {
      truncated = true;
      break;
    }
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("text" in candidate) ||
      typeof candidate.text !== "string"
    ) {
      truncated = true;
      continue;
    }
    const maximumCharacters = Math.min(
      budget.maxItemCharacters,
      remainingCharacters,
    );
    const maximumRawCharacters = Math.max(maximumCharacters + 1, 1) * 4;
    const rawText = candidate.text.slice(0, maximumRawCharacters);
    const text = normalizeMemoryText(rawText);
    if (text.length === 0) {
      truncated = true;
      continue;
    }
    const boundedText = truncateText(text, maximumCharacters);
    items.push({ text: boundedText, trust: UNTRUSTED_MEMORY_TRUST });
    totalCharacters += boundedText.length;
    truncated ||=
      rawText.length < candidate.text.length || boundedText.length < text.length;
  }

  return { items, totalCharacters, truncated };
}
