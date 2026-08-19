import type { ConversationActorWakeRegistry } from "../../conversation/coordinator.js";
import type { InteractionCoordinatePayload } from "../payloads.js";

export function createInteractionCoordinateHandler(
  actorRegistry: ConversationActorWakeRegistry,
) {
  return async (payload: InteractionCoordinatePayload): Promise<void> => {
    await actorRegistry.wake(payload.spaceId, payload.reason);
  };
}
