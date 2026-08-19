import type {
  DeliveryCoordinatorPort,
  DeliveryWakePublisherPort,
} from "./contracts.js";

export interface CompatibilityDeliveryRouterOptions {
  coordinator: Pick<DeliveryCoordinatorPort, "wake">;
  publisher: DeliveryWakePublisherPort;
}

/**
 * Starts delivery in-process while also publishing the durable recovery wake.
 * The coordinator registry and database claim make duplicate direct/queue wakes
 * converge on the same materialized batch.
 */
export class CompatibilityDeliveryRouter {
  readonly #coordinator: Pick<DeliveryCoordinatorPort, "wake">;
  readonly #publisher: DeliveryWakePublisherPort;

  public constructor(options: CompatibilityDeliveryRouterOptions) {
    this.#coordinator = options.coordinator;
    this.#publisher = options.publisher;
  }

  public async route(
    outboundBatchId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const directWake = this.#coordinator.wake(outboundBatchId, signal);
    const durableWake = this.#publisher.publish({ outboundBatchId });
    await Promise.all([directWake, durableWake]);
  }
}
