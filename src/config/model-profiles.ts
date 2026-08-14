import { z } from "zod";

export const MODEL_PROFILE_NAMES = [
  "fast",
  "main",
  "balanced",
  "hard",
  "deep",
] as const;

export const modelProfileNameSchema = z.enum(MODEL_PROFILE_NAMES);

export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

export const modelIdentifierSchema = z
  .string()
  .trim()
  .min(1, "model identifier is required")
  .max(128, "model identifier must be at most 128 characters")
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/i,
    "model identifier may contain only letters, numbers, dots, underscores, and hyphens",
  );

export const modelProfileSchema = z
  .object({
    model: modelIdentifierSchema,
    effort: reasoningEffortSchema,
  })
  .strict();

export const modelProfilesSchema = z
  .object({
    fast: modelProfileSchema,
    main: modelProfileSchema,
    balanced: modelProfileSchema,
    hard: modelProfileSchema,
    deep: modelProfileSchema,
  })
  .strict();

export type ModelProfileName = z.infer<typeof modelProfileNameSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export type ModelProfiles = z.infer<typeof modelProfilesSchema>;

export const DEFAULT_MODEL_PROFILES = modelProfilesSchema.parse({
  fast: { model: "gpt-5.6-luna", effort: "medium" },
  main: { model: "gpt-5.6-luna", effort: "high" },
  balanced: { model: "gpt-5.6-terra", effort: "high" },
  hard: { model: "gpt-5.6-luna", effort: "max" },
  deep: { model: "gpt-5.6-sol", effort: "max" },
});

export function parseModelProfiles(input: unknown): ModelProfiles {
  return modelProfilesSchema.parse(input);
}
