import { DeliveryError } from "../conversation/errors.js";
import type { DeliveryWakePublisherPort } from "./contracts.js";

export const UNCERTAIN_DELIVERY_CLASSIFICATION = "uncertain_delivery" as const;

/**
 * The provider acknowledged a logical part, but PostgreSQL did not confirm its
 * cursor checkpoint. The active lease is intentionally left in place so an
 * immediate duplicate wake cannot resend before recovery examines it.
 */
export class UncertainDeliveryError extends DeliveryError {
  public readonly classification = UNCERTAIN_DELIVERY_CLASSIFICATION;
  public readonly outboundBatchId: string;
  public readonly position: number;
  public readonly clientGuid: string;
  public readonly claimToken: string;

  public constructor(input: {
    outboundBatchId: string;
    position: number;
    clientGuid: string;
    claimToken: string;
    cause: unknown;
  }) {
    super("DELIVERY_TRANSPORT_FAILED", true, { cause: input.cause });
    this.name = "UncertainDeliveryError";
    this.outboundBatchId = input.outboundBatchId;
    this.position = input.position;
    this.clientGuid = input.clientGuid;
    this.claimToken = input.claimToken;
  }
}

export interface DeliveryRecoveryRepository {
  findRecoverableBatchIds(input: {
    now: Date;
    limit: number;
  }): Promise<string[]>;
}

export interface DeliveryRecoveryOptions {
  repository: DeliveryRecoveryRepository;
  publisher: DeliveryWakePublisherPort;
  now?: () => Date;
}

/** Republishes identifier-only wakes from authoritative, resumable rows. */
export class DeliveryRecovery {
  readonly #repository: DeliveryRecoveryRepository;
  readonly #publisher: DeliveryWakePublisherPort;
  readonly #now: () => Date;

  public constructor(options: DeliveryRecoveryOptions) {
    this.#repository = options.repository;
    this.#publisher = options.publisher;
    this.#now = options.now ?? (() => new Date());
  }

  public async recover(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Delivery recovery limit must be a positive integer.");
    }

    const outboundBatchIds = await this.#repository.findRecoverableBatchIds({
      now: this.#now(),
      limit,
    });
    for (const outboundBatchId of outboundBatchIds) {
      await this.#publisher.publish({ outboundBatchId });
    }
    return outboundBatchIds.length;
  }
}
