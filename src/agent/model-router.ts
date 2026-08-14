import type {
  ModelProfile,
  ModelProfileName,
  ModelProfiles,
} from "../config/model-profiles.js";

export type ModelProfileOverride = "auto" | ModelProfileName;

export type RoutingIntentKind =
  | "command"
  | "conversation"
  | "multi_document"
  | "repository"
  | "debugging"
  | "architecture_review";

export interface RoutingIntent {
  kind: RoutingIntentKind;
  contextCharacters?: number;
  documentCount?: number;
  repositoryCount?: number;
  failedAttempts?: number;
  ambiguous?: boolean;
  highStakes?: boolean;
}

export type ModelProfileSource =
  | "default"
  | "router"
  | "user_override"
  | "escalation";

export interface ResolvedModelProfile {
  name: ModelProfileName;
  profile: ModelProfile;
  source: ModelProfileSource;
}

function automaticallyRoute(intent: RoutingIntent): ModelProfileName {
  if (intent.kind === "command") {
    return "fast";
  }

  if (
    intent.highStakes === true ||
    intent.kind === "architecture_review" ||
    (intent.repositoryCount ?? 0) >= 3 ||
    (intent.failedAttempts ?? 0) >= 2
  ) {
    return "deep";
  }

  if (intent.kind === "debugging" && intent.ambiguous === true) {
    return "hard";
  }

  if (
    intent.kind === "multi_document" ||
    (intent.documentCount ?? 0) >= 3 ||
    (intent.contextCharacters ?? 0) >= 64_000
  ) {
    return "balanced";
  }

  if (
    intent.kind === "repository" &&
    (intent.contextCharacters ?? 0) >= 32_000
  ) {
    return "balanced";
  }

  return "main";
}

export function resolveModelProfile(
  intent: RoutingIntent,
  override: ModelProfileOverride,
  profiles: ModelProfiles,
): ResolvedModelProfile {
  if (override !== "auto") {
    return {
      name: override,
      profile: profiles[override],
      source: "user_override",
    };
  }

  const name = automaticallyRoute(intent);
  return {
    name,
    profile: profiles[name],
    source: name === "main" ? "default" : "router",
  };
}
const escalationTarget: Readonly<
  Partial<Record<ModelProfileName, ModelProfileName>>
> = {
  fast: "main",
  main: "hard",
  balanced: "hard",
  hard: "deep",
};

export function escalateModelProfile(
  current: ResolvedModelProfile,
  profiles: ModelProfiles,
  alreadyEscalated: boolean,
): ResolvedModelProfile | undefined {
  if (alreadyEscalated) {
    return undefined;
  }
  const target = escalationTarget[current.name];
  if (target === undefined) {
    return undefined;
  }
  return {
    name: target,
    profile: profiles[target],
    source: "escalation",
  };
}
