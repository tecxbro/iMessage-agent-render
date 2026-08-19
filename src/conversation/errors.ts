import { z } from "zod";

export const CONVERSATION_ERROR_CODES = [
  "CONVERSATION_STATE_STALE",
  "INTERACTION_RUN_NOT_FOUND",
  "INTERACTION_RUN_STALE",
  "INTERACTION_START_REJECTED",
  "INTERACTION_STEER_REJECTED",
  "INTERACTION_RUNTIME_FAILED",
  "INTERACTION_TASK_FAILED",
  "INTERACTION_DELIVERY_FAILED",
] as const;

export const DELIVERY_ERROR_CODES = [
  "DELIVERY_BATCH_NOT_FOUND",
  "DELIVERY_BATCH_INVALID",
  "DELIVERY_CLAIM_LOST",
  "DELIVERY_TRANSPORT_FAILED",
] as const;

export const conversationErrorCodeSchema = z.enum(CONVERSATION_ERROR_CODES);
export const deliveryErrorCodeSchema = z.enum(DELIVERY_ERROR_CODES);

export type ConversationErrorCode = z.infer<
  typeof conversationErrorCodeSchema
>;
export type DeliveryErrorCode = z.infer<typeof deliveryErrorCodeSchema>;

export class ConversationActorError extends Error {
  public readonly code: ConversationErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: ConversationErrorCode,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(
      `${code}. Reload the authoritative conversation state before deciding whether to retry.`,
      options,
    );
    this.name = "ConversationActorError";
    this.code = conversationErrorCodeSchema.parse(code);
    this.retryable = retryable;
  }
}

export class DeliveryError extends Error {
  public readonly code: DeliveryErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: DeliveryErrorCode,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(
      `${code}. Reload the outbound batch and verify the current claim before retrying.`,
      options,
    );
    this.name = "DeliveryError";
    this.code = deliveryErrorCodeSchema.parse(code);
    this.retryable = retryable;
  }
}
