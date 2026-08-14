export const DEFAULT_MAXIMUM_BUBBLE_CHARACTERS = 1_200;

export interface BubbleSplitOptions {
  maxCharacters?: number;
}

interface MessageBlock {
  kind: "plain" | "code";
  text: string;
}

const fenceStart = /^\s*(`{3,}|~{3,})[^\n]*$/u;
const urlToken = /^https?:\/\/\S+$/iu;

function splitBlocks(input: string): MessageBlock[] {
  const lines = input.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: MessageBlock[] = [];
  let plain: string[] = [];

  const flushPlain = () => {
    const text = plain.join("\n").trim();
    if (text.length > 0) {
      blocks.push({ kind: "plain", text });
    }
    plain = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const opening = fenceStart.exec(line);
    if (opening === null) {
      plain.push(line);
      continue;
    }

    flushPlain();
    const marker = opening[1] ?? "```";
    const code = [line];
    for (index += 1; index < lines.length; index += 1) {
      const codeLine = lines[index] ?? "";
      code.push(codeLine);
      const closing = /^\s*(`{3,}|~{3,})\s*$/u.exec(codeLine);
      if (
        closing !== null &&
        closing[1]?.charAt(0) === marker.charAt(0) &&
        closing[1].length >= marker.length
      ) {
        break;
      }
    }
    blocks.push({ kind: "code", text: code.join("\n").trim() });
  }

  flushPlain();
  return blocks;
}

function splitGraphemes(input: string, maximum: number): string[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const chunks: string[] = [];
  let current = "";
  for (const { segment } of segmenter.segment(input)) {
    if (current.length > 0 && current.length + segment.length > maximum) {
      chunks.push(current);
      current = "";
    }
    if (segment.length > maximum) {
      // This can only occur when a single grapheme contains many joined code
      // points. Preserve UTF-16 boundaries even when the configured limit is
      // too small to preserve the whole grapheme.
      for (const point of Array.from(segment)) {
        if (current.length > 0 && current.length + point.length > maximum) {
          chunks.push(current);
          current = "";
        }
        current += point;
      }
      continue;
    }
    current += segment;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function splitOversizedToken(token: string, maximum: number): string[] {
  if (token.length <= maximum) {
    return [token];
  }
  return splitGraphemes(token, maximum);
}

function splitPlain(input: string, maximum: number): string[] {
  if (input.length <= maximum) {
    return [input.trim()];
  }

  const tokens = input.match(/https?:\/\/\S+|\s+|[^\s]+/giu) ?? [input];
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const normalized = current.trim();
    if (normalized.length > 0) {
      chunks.push(normalized);
    }
    current = "";
  };

  for (const token of tokens) {
    if (/^\s+$/u.test(token)) {
      if (current.length > 0) {
        const whitespace = token.includes("\n") ? "\n" : " ";
        if (current.length + whitespace.length <= maximum) {
          current += whitespace;
        } else {
          flush();
        }
      }
      continue;
    }

    const pieces = splitOversizedToken(token, maximum);
    for (const piece of pieces) {
      if (current.length > 0 && current.length + piece.length > maximum) {
        flush();
      }
      current += piece;
      if (current.length === maximum || (urlToken.test(piece) && piece.length > maximum)) {
        flush();
      }
    }
  }
  flush();
  return chunks;
}

function splitCodeBlock(input: string, maximum: number): string[] {
  if (input.length <= maximum) {
    return [input];
  }

  const lines = input.split("\n");
  const opening = lines[0] ?? "```";
  const openingMatch = fenceStart.exec(opening);
  const possibleClosing = lines.at(-1) ?? "";
  const closingMatch = /^\s*(`{3,}|~{3,})\s*$/u.exec(possibleClosing);
  const isClosed =
    openingMatch !== null &&
    closingMatch !== null &&
    openingMatch[1]?.[0] === closingMatch[1]?.[0];
  const closing = isClosed ? possibleClosing : openingMatch?.[1] ?? "```";
  const body = lines.slice(1, isClosed ? -1 : undefined).join("\n");
  const available = maximum - opening.length - closing.length - 2;
  if (available < 1) {
    return splitGraphemes(input, maximum);
  }

  return splitPlain(body, available).map(
    (part) => `${opening}\n${part}\n${closing}`,
  );
}

export function splitMessageBubbles(
  input: string,
  options: BubbleSplitOptions = {},
): string[] {
  const maximum = options.maxCharacters ?? DEFAULT_MAXIMUM_BUBBLE_CHARACTERS;
  if (!Number.isInteger(maximum) || maximum < 16) {
    throw new Error("maxCharacters must be an integer of at least 16.");
  }

  const normalized = input.trim();
  if (normalized.length === 0) {
    return [];
  }

  return splitBlocks(normalized)
    .flatMap((block) =>
      block.kind === "code"
        ? splitCodeBlock(block.text, maximum)
        : block.text
            .split(/\n{2,}/u)
            .flatMap((paragraph) => splitPlain(paragraph, maximum)),
    )
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}
