import { describe, expect, it } from "vitest";

import {
  escalateModelProfile,
  resolveModelProfile,
  type RoutingIntent,
} from "../../src/agent/model-router.js";
import { DEFAULT_MODEL_PROFILES } from "../../src/config/model-profiles.js";

describe("deterministic model router", () => {
  it.each<[
    string,
    RoutingIntent,
    "fast" | "main" | "balanced" | "hard" | "deep",
  ]>([
    ["/status", { kind: "command" }, "fast"],
    ["durable preference", { kind: "conversation" }, "main"],
    [
      "six design docs",
      { kind: "multi_document", documentCount: 6 },
      "balanced",
    ],
    ["bounded package fix", { kind: "repository", contextCharacters: 8_000 }, "main"],
    [
      "ambiguous debugging",
      { kind: "debugging", ambiguous: true },
      "hard",
    ],
    [
      "repeated cross-service failure",
      { kind: "debugging", failedAttempts: 2 },
      "deep",
    ],
    [
      "formal multi-repo review",
      { kind: "architecture_review", repositoryCount: 3 },
      "deep",
    ],
  ])("routes %s without profile drift", (_name, intent, expected) => {
    expect(
      resolveModelProfile(intent, "auto", DEFAULT_MODEL_PROFILES).name,
    ).toBe(expected);
  });

  it("honors an explicit override and allows at most one escalation", () => {
    const selected = resolveModelProfile(
      { kind: "command" },
      "balanced",
      DEFAULT_MODEL_PROFILES,
    );
    expect(selected).toMatchObject({ name: "balanced", source: "user_override" });

    const escalated = escalateModelProfile(
      selected,
      DEFAULT_MODEL_PROFILES,
      false,
    );
    expect(escalated).toMatchObject({ name: "hard", source: "escalation" });
    expect(
      escalateModelProfile(selected, DEFAULT_MODEL_PROFILES, true),
    ).toBeUndefined();
  });
});
