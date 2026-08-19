import type { DeliveryCoordinatorPort } from "../../delivery/contracts.js";
import type { OutboundSendPayload } from "../payloads.js";

export interface OutboundSendDependencies {
  coordinator: Pick<DeliveryCoordinatorPort, "wake">;
}

/** Legacy queue compatibility: old jobs only wake the canonical coordinator. */
export function createOutboundSendHandler(
  dependencies: OutboundSendDependencies,
) {
  return async (
    payload: OutboundSendPayload,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    await dependencies.coordinator.wake(payload.outboundBatchId, signal);
  };
}
