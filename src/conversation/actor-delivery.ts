import type { InteractionDeliveryPort } from "./contracts.js";
import type { DataCipher } from "../security/data-cipher.js";
import type { OutboundDeliveryRepository } from "../db/repositories/outbound-delivery.js";
import type { DeliveryCoordinator } from "../delivery/delivery-coordinator.js";
import type { QueuePublisher } from "../queue/publisher.js";
import { splitMessageBubbles } from "../messaging/bubble-splitter.js";
import { assertUserFacingMessageSafe } from "../messaging/user-visible-policy.js";

export interface ActorDeliveryOptions {
  repository: Pick<OutboundDeliveryRepository, "materializeInteractionBatch">;
  coordinator: Pick<DeliveryCoordinator, "wake">;
  publisher: Pick<QueuePublisher, "enqueueOutboundCoordinate">;
  cipher: Pick<DataCipher, "encrypt">;
  onWakeFailure?: (input: {
    outboundBatchId: string;
    trigger: "direct" | "durable";
    error: unknown;
  }) => void;
}

/** Fenced actor batch materialization followed by direct and durable wakes. */
export class ActorDelivery implements InteractionDeliveryPort {
  public constructor(private readonly options: ActorDeliveryOptions) {}

  public async prepare(input: {
    interactionRunId: string;
    spaceId: string;
    generation: number;
    draftOutput: string;
  }): Promise<{ outboundBatchId: string }> {
    assertUserFacingMessageSafe(input.draftOutput);
    const bubbles = splitMessageBubbles(input.draftOutput);
    if (bubbles.length === 0) {
      throw new Error("Actor finalization produced no sendable message bubbles.");
    }
    const outboundBatchId = await this.options.repository.materializeInteractionBatch({
      interactionRunId: input.interactionRunId,
      spaceId: input.spaceId,
      generation: input.generation,
      encryptedParts: bubbles.map((bubble) => this.options.cipher.encrypt(bubble)),
    });

    let direct: Promise<void>;
    try {
      direct = Promise.resolve(this.options.coordinator.wake(outboundBatchId));
    } catch (error) {
      this.options.onWakeFailure?.({ outboundBatchId, trigger: "direct", error });
      direct = Promise.resolve();
    }
    void direct.catch((error: unknown) => {
      this.options.onWakeFailure?.({ outboundBatchId, trigger: "direct", error });
    });
    try {
      await this.options.publisher.enqueueOutboundCoordinate({ outboundBatchId });
    } catch (error) {
      this.options.onWakeFailure?.({ outboundBatchId, trigger: "durable", error });
    }
    return { outboundBatchId };
  }
}
