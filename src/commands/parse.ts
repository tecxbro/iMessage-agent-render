export const SLASH_COMMAND_NAMES = [
  "help",
  "status",
  "model",
  "cancel",
  "new",
  "agents",
] as const;

export type SlashCommandName = (typeof SLASH_COMMAND_NAMES)[number];

export type ParsedSlashCommand =
  | {
      name: SlashCommandName;
      args: readonly string[];
    }
  | {
      name: "unknown";
      command: string;
      args: readonly string[];
    };

const commandNames = new Set<string>(SLASH_COMMAND_NAMES);

/**
 * Parses commands before prompt construction. Arguments are deliberately split
 * only on Unicode whitespace: quotes, escapes, substitutions, and pipes never
 * acquire shell semantics.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const normalized = input.trim();
  if (!normalized.startsWith("/")) {
    return null;
  }

  const tokens = normalized.slice(1).split(/\s+/u);
  const rawCommand = tokens.shift() ?? "";
  const command = rawCommand.toLowerCase();

  if (commandNames.has(command)) {
    return {
      name: command as SlashCommandName,
      args: tokens,
    };
  }

  return {
    name: "unknown",
    command,
    args: tokens,
  };
}
