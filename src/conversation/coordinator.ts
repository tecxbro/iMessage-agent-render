import type {
  InteractionCoordinatePayload,
  InteractionCoordinateReason,
} from "../queue/payloads.js";

export interface ConversationActorWakeRegistry {
  wake(spaceId: string, reason: InteractionCoordinateReason): Promise<void>;
}

/**
 * Thin queue boundary. Wake payloads contain identifiers and a scheduling hint
 * only; the actor behind the registry is responsible for reloading PostgreSQL.
 */
export class ConversationCoordinator {
  public constructor(
    private readonly actorRegistry: ConversationActorWakeRegistry,
  ) {}

  public async coordinate(
    payload: InteractionCoordinatePayload,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.actorRegistry.wake(payload.spaceId, payload.reason);
  }
}
