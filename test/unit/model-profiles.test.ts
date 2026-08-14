import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_PROFILES,
  MODEL_PROFILE_NAMES,
  REASONING_EFFORTS,
  modelProfileNameSchema,
  modelProfilesSchema,
  reasoningEffortSchema,
} from "../../src/config/model-profiles.js";

describe("model profile contracts", () => {
  it("freezes every documented profile and default", () => {
    expect(MODEL_PROFILE_NAMES).toEqual([
      "fast",
      "main",
      "balanced",
      "hard",
      "deep",
    ]);
    expect(DEFAULT_MODEL_PROFILES).toEqual({
      fast: { model: "gpt-5.6-luna", effort: "medium" },
      main: { model: "gpt-5.6-luna", effort: "high" },
      balanced: { model: "gpt-5.6-terra", effort: "high" },
      hard: { model: "gpt-5.6-luna", effort: "max" },
      deep: { model: "gpt-5.6-sol", effort: "max" },
    });
    expect(modelProfilesSchema.parse(DEFAULT_MODEL_PROFILES)).toEqual(
      DEFAULT_MODEL_PROFILES,
    );
  });

  it("accepts only documented profile names and known effort values", () => {
    for (const profile of MODEL_PROFILE_NAMES) {
      expect(modelProfileNameSchema.parse(profile)).toBe(profile);
    }
    for (const effort of REASONING_EFFORTS) {
      expect(reasoningEffortSchema.parse(effort)).toBe(effort);
    }

    expect(modelProfileNameSchema.safeParse("auto").success).toBe(false);
    expect(reasoningEffortSchema.safeParse("ultra").success).toBe(false);
  });
});
