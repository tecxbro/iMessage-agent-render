export const DEFAULT_SIMPLE_TURN_THRESHOLD_MS = 3_000;
export const DEFAULT_STATUS_COOLDOWN_MS = 45_000;
export const DEFAULT_STATUS_DUPLICATE_WINDOW_MS = 15 * 60_000;
export const DEFAULT_MAXIMUM_STATUS_CHARACTERS = 280;

export interface StatusHistoryEntry {
  chainId: string;
  message: string;
  sentAt: Date;
}

export interface StatusPolicyInput {
  chainId: string;
  now: Date;
  estimatedDurationMs: number;
  contactsExternalDependency: boolean;
  proposedMessage?: string;
  priorMessages: readonly StatusHistoryEntry[];
  simpleTurnThresholdMs?: number;
  cooldownMs?: number;
  duplicateWindowMs?: number;
  maximumCharacters?: number;
}

export type StatusPolicyReason =
  | "send"
  | "simple_turn"
  | "missing_message"
  | "unsafe_message"
  | "already_sent_for_chain"
  | "rate_limited"
  | "duplicate";

export interface StatusPolicyDecision {
  send: boolean;
  reason: StatusPolicyReason;
  message?: string;
}

const internalLanguage =
  /(?:\b(?:codex|gpt-[a-z0-9.-]+|sub[ -]?agents?|workers?|job queues?|queue jobs?|tool calls?|raw (?:codex )?events?|internal (?:agent|execution) runtime|unrestricted logs?|chain[- ]of[- ]thought|reasoning tokens?|model (?:id|effort|internals?))\b|\bitem\.(?:started|updated|completed)\b)/iu;

function normalizeMessage(message: string, maximumCharacters: number): string {
  return message
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumCharacters);
}

function duplicateKey(message: string): string {
  return message.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

/**
 * The model may suggest status wording; this code alone decides whether it can
 * be sent. The history is expected to come from durable application state.
 */
export function decideStatusMessage(
  input: StatusPolicyInput,
): StatusPolicyDecision {
  const threshold =
    input.simpleTurnThresholdMs ?? DEFAULT_SIMPLE_TURN_THRESHOLD_MS;
  if (
    Math.max(0, input.estimatedDurationMs) < threshold &&
    !input.contactsExternalDependency
  ) {
    return { send: false, reason: "simple_turn" };
  }

  if (input.proposedMessage === undefined) {
    return { send: false, reason: "missing_message" };
  }
  const message = normalizeMessage(
    input.proposedMessage,
    input.maximumCharacters ?? DEFAULT_MAXIMUM_STATUS_CHARACTERS,
  );
  if (message.length === 0) {
    return { send: false, reason: "missing_message" };
  }
  if (internalLanguage.test(message)) {
    return { send: false, reason: "unsafe_message" };
  }

  if (input.priorMessages.some((entry) => entry.chainId === input.chainId)) {
    return { send: false, reason: "already_sent_for_chain" };
  }

  const now = input.now.getTime();
  const cooldown = input.cooldownMs ?? DEFAULT_STATUS_COOLDOWN_MS;
  const mostRecent = input.priorMessages.reduce<number | undefined>(
    (latest, entry) => {
      const value = entry.sentAt.getTime();
      return latest === undefined || value > latest ? value : latest;
    },
    undefined,
  );
  if (mostRecent !== undefined && now - mostRecent < cooldown) {
    return { send: false, reason: "rate_limited" };
  }

  const key = duplicateKey(message);
  const duplicateWindow =
    input.duplicateWindowMs ?? DEFAULT_STATUS_DUPLICATE_WINDOW_MS;
  if (
    input.priorMessages.some(
      (entry) =>
        now - entry.sentAt.getTime() <= duplicateWindow &&
        duplicateKey(entry.message) === key,
    )
  ) {
    return { send: false, reason: "duplicate" };
  }

  return { send: true, reason: "send", message };
}
