import {
  MODEL_PROFILE_NAMES,
  type ModelProfileName,
} from "../config/model-profiles.js";
import type { ParsedSlashCommand } from "./parse.js";

export interface CommandContext {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  currentChainId?: string;
}

export type ComponentStatus = "ready" | "degraded" | "unavailable" | "unknown";

export interface CommandStatusSnapshot {
  messaging: ComponentStatus;
  signIn: ComponentStatus;
  work: ComponentStatus;
  memory: ComponentStatus | "disabled";
  activeTaskCount: number;
  modelProfile: ModelProfileName | "auto";
}

export interface NamedAgentSummary {
  name: string;
  status: "active" | "idle" | "reset" | "disabled";
  summary?: string;
}

export interface CommandHandlersDependencies {
  getStatus(context: CommandContext): Promise<CommandStatusSnapshot>;
  getModelProfile(
    context: CommandContext,
  ): Promise<ModelProfileName | "auto">;
  setModelProfile(
    context: CommandContext,
    profile: ModelProfileName | null,
  ): Promise<void>;
  cancelActive(context: CommandContext): Promise<{ canceledCount: number }>;
  resetInteractionThread(context: CommandContext): Promise<void>;
  listAgents(context: CommandContext): Promise<readonly NamedAgentSummary[]>;
}

export interface CommandResult {
  handled: true;
  message: string;
}

const profiles = new Set<string>(MODEL_PROFILE_NAMES);

function noArguments(
  command: ParsedSlashCommand,
  usage: string,
): CommandResult | undefined {
  if (command.args.length === 0) {
    return undefined;
  }
  return { handled: true, message: `Usage: ${usage}` };
}

function statusLabel(value: ComponentStatus | "disabled"): string {
  switch (value) {
    case "ready":
      return "ready";
    case "degraded":
      return "limited";
    case "unavailable":
      return "unavailable";
    case "disabled":
      return "off";
    case "unknown":
      return "checking";
  }
}

function safeDisplayText(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function helpMessage(): string {
  return [
    "I can answer directly or do bounded work in an approved workspace.",
    "",
    "/status — check service readiness and active work",
    "/model [auto|fast|main|balanced|hard|deep] — view or set the mode for future turns",
    "/cancel — cancel active work in this conversation",
    "/new — start a fresh conversation thread while keeping your saved memory",
    "/agents — list your named work contexts",
    "",
    "External sends, destructive changes, purchases, and permission changes still require exact approval.",
  ].join("\n");
}

export async function handleSlashCommand(
  command: ParsedSlashCommand,
  context: CommandContext,
  dependencies: CommandHandlersDependencies,
): Promise<CommandResult> {
  switch (command.name) {
    case "help": {
      const usage = noArguments(command, "/help");
      return usage ?? { handled: true, message: helpMessage() };
    }
    case "status": {
      const usage = noArguments(command, "/status");
      if (usage !== undefined) {
        return usage;
      }
      const status = await dependencies.getStatus(context);
      const activeTaskCount = Math.max(0, Math.trunc(status.activeTaskCount));
      return {
        handled: true,
        message: [
          `Messaging: ${statusLabel(status.messaging)}`,
          `Sign-in: ${statusLabel(status.signIn)}`,
          `Work: ${statusLabel(status.work)}${activeTaskCount === 0 ? "" : ` (${activeTaskCount} active)`}`,
          `Memory: ${statusLabel(status.memory)}`,
          `Model mode: ${status.modelProfile}`,
        ].join("\n"),
      };
    }
    case "model": {
      if (command.args.length === 0) {
        const current = await dependencies.getModelProfile(context);
        return {
          handled: true,
          message: `Model mode: ${current}. Available: auto, ${MODEL_PROFILE_NAMES.join(", ")}.`,
        };
      }
      if (command.args.length !== 1) {
        return {
          handled: true,
          message: "Usage: /model [auto|fast|main|balanced|hard|deep]",
        };
      }
      const requested = command.args[0]?.toLowerCase();
      if (requested === "auto") {
        await dependencies.setModelProfile(context, null);
        return {
          handled: true,
          message: "Model mode set to auto for future turns.",
        };
      }
      if (requested === undefined || !profiles.has(requested)) {
        return {
          handled: true,
          message: "Unknown model mode. Choose auto, fast, main, balanced, hard, or deep.",
        };
      }
      const profile = requested as ModelProfileName;
      await dependencies.setModelProfile(context, profile);
      return {
        handled: true,
        message: `Model mode set to ${profile} for future turns.`,
      };
    }
    case "cancel": {
      const usage = noArguments(command, "/cancel");
      if (usage !== undefined) {
        return usage;
      }
      const { canceledCount } = await dependencies.cancelActive(context);
      return {
        handled: true,
        message:
          canceledCount > 0
            ? "Canceled the active work in this conversation."
            : "There’s no active work to cancel in this conversation.",
      };
    }
    case "new": {
      const usage = noArguments(command, "/new");
      if (usage !== undefined) {
        return usage;
      }
      await dependencies.resetInteractionThread(context);
      return {
        handled: true,
        message: "Started a fresh conversation thread. Your saved memory is unchanged.",
      };
    }
    case "agents": {
      const usage = noArguments(command, "/agents");
      if (usage !== undefined) {
        return usage;
      }
      const agents = (await dependencies.listAgents(context)).slice(0, 20);
      if (agents.length === 0) {
        return {
          handled: true,
          message: "No named work contexts yet.",
        };
      }
      const rows = agents.map((agent) => {
        const name = safeDisplayText(agent.name, 80) || "unnamed";
        const summary =
          agent.summary === undefined
            ? ""
            : ` — ${safeDisplayText(agent.summary, 160)}`;
        return `• ${name} (${agent.status})${summary}`;
      });
      return {
        handled: true,
        message: ["Named work contexts:", ...rows].join("\n"),
      };
    }
    case "unknown":
      return {
        handled: true,
        message: "Unknown command. Try /help.",
      };
  }
}
