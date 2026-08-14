import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const ACTION_TYPES = [
  "filesystem.destructive",
  "external.send",
  "purchase",
  "authentication.change",
  "permission.change",
  "deployment.change",
  "secret.access",
  "network.broad",
  "dependency.install",
  "other.consequential",
] as const;

export const actionTypeSchema = z.enum(ACTION_TYPES);

const boundedTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

export const proposedActionSchema = z
  .object({
    actionType: actionTypeSchema,
    target: boundedTextSchema(512),
    normalizedPayload: jsonValueSchema,
    humanSummary: boundedTextSchema(1_000),
  })
  .strict();

export type ActionType = z.infer<typeof actionTypeSchema>;
export type ProposedAction = z.infer<typeof proposedActionSchema>;
