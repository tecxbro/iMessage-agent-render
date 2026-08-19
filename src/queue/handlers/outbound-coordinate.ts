import type { DeliveryCoordinatorPort } from "../../delivery/contracts.js";
import type { OutboundCoordinatePayload } from "../payloads.js";

export interface OutboundCoordinateDependencies {
  coordinator: DeliveryCoordinatorPort;
}

/** Queue recovery is a wake source only; all sending stays in the coordinator. */
export function createOutboundCoordinateHandler(
  dependencies: OutboundCoordinateDependencies,
) {
  return async (
    payload: OutboundCoordinatePayload,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    await dependencies.coordinator.coordinate(payload, signal);
  };
}
