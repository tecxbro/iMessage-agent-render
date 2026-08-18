import { z } from "zod";

export const APPROVAL_QUEUE_NAMES = {
  request: "approval.request",
  execute: "approval.execute",
} as const;

export const approvalRequestPayloadSchema = z
  .object({
    executionTaskId: z.uuid(),
  })
  .strict();

export const approvalExecutePayloadSchema = z
  .object({
    actionExecutionId: z.uuid(),
  })
  .strict();

export type ApprovalRequestPayload = z.infer<
  typeof approvalRequestPayloadSchema
>;
export type ApprovalExecutePayload = z.infer<
  typeof approvalExecutePayloadSchema
>;

export interface ApprovalQueuePublisher {
  enqueueApprovalRequest(payload: ApprovalRequestPayload): Promise<void>;
  enqueueApprovalExecute(payload: ApprovalExecutePayload): Promise<void>;
}

export function parseApprovalQueuePayload(
  queueName: typeof APPROVAL_QUEUE_NAMES.request,
  payload: unknown,
): ApprovalRequestPayload;
export function parseApprovalQueuePayload(
  queueName: typeof APPROVAL_QUEUE_NAMES.execute,
  payload: unknown,
): ApprovalExecutePayload;
export function parseApprovalQueuePayload(
  queueName: (typeof APPROVAL_QUEUE_NAMES)[keyof typeof APPROVAL_QUEUE_NAMES],
  payload: unknown,
): ApprovalRequestPayload | ApprovalExecutePayload {
  return queueName === APPROVAL_QUEUE_NAMES.request
    ? approvalRequestPayloadSchema.parse(payload)
    : approvalExecutePayloadSchema.parse(payload);
}
