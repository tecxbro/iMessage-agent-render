import { randomUUID } from "node:crypto";

import { DeliveryError } from "../conversation/errors.js";
import type {
  DeliveryClaim,
  DeliveryCoordinatorPort,
  DeliveryRepositoryPort,
} from "./contracts.js";
import { DeliveryRegistry } from "./delivery-registry.js";
import { UncertainDeliveryError } from "./recovery.js";

export interface ClaimBoundDeliveryTransportPort {
  send(input: {
    spaceId: string;
    clientGuid: string;
    claimToken: string;
    text: string;
    signal: AbortSignal;
  }): Promise<{ externalMessageId: string | null; sentAt: Date }>;
}

export interface DeliveryCoordinatorOptions {
  repository: DeliveryRepositoryPort;
  transport: ClaimBoundDeliveryTransportPort;
  registry?: DeliveryRegistry;
  decrypt(ciphertext: string): Promise<string> | string;
  claimOwner?: string;
  leaseDurationMs?: number;
  now?: () => Date;
}

type DeliveryStage = "decrypt" | "send" | "checkpoint";

/** One lease-aware sending loop shared by direct and recovery wakes. */
export class DeliveryCoordinator implements DeliveryCoordinatorPort {
  readonly #repository: DeliveryRepositoryPort;
  readonly #transport: ClaimBoundDeliveryTransportPort;
  readonly #registry: DeliveryRegistry;
  readonly #decrypt: (ciphertext: string) => Promise<string> | string;
  readonly #claimOwner: string;
  readonly #leaseDurationMs: number;
  readonly #now: () => Date;

  public constructor(options: DeliveryCoordinatorOptions) {
    const leaseDurationMs = options.leaseDurationMs ?? 60_000;
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new Error("Delivery claim lease duration must be a positive integer.");
    }

    this.#repository = options.repository;
    this.#transport = options.transport;
    this.#registry = options.registry ?? new DeliveryRegistry();
    this.#decrypt = options.decrypt;
    this.#claimOwner = options.claimOwner ?? `delivery:${randomUUID()}`;
    this.#leaseDurationMs = leaseDurationMs;
    this.#now = options.now ?? (() => new Date());
  }

  public coordinate(
    payload: { outboundBatchId: string },
    signal: AbortSignal,
  ): Promise<void> {
    return this.wake(payload.outboundBatchId, signal);
  }

  public wake(
    outboundBatchId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    return this.#registry.wake(outboundBatchId, async () => {
      await this.#run(outboundBatchId, signal);
    });
  }

  async #run(outboundBatchId: string, signal: AbortSignal): Promise<void> {
    while (true) {
      signal.throwIfAborted();
      const claim = await this.#repository.claimNext({
        outboundBatchId,
        claimOwner: this.#claimOwner,
        leaseDurationMs: this.#leaseDurationMs,
        now: this.#now(),
      });
      if (claim === null) {
        return;
      }

      const checkpoint = await this.#deliverClaim(claim, signal);
      if (checkpoint.batchComplete) {
        return;
      }
    }
  }

  async #deliverClaim(
    claim: DeliveryClaim,
    signal: AbortSignal,
  ): Promise<{ batchComplete: boolean; nextIndex: number }> {
    let acknowledged = false;
    let checkpointed = false;
    let uncertain = false;
    let primaryFailure = false;
    let stage: DeliveryStage = "decrypt";

    try {
      const text = await this.#decrypt(claim.text);
      stage = "send";
      return await this.#registry.withSpaceSlot(claim.spaceId, async () => {
        signal.throwIfAborted();
        if (claim.claimExpiresAt.getTime() <= this.#now().getTime()) {
          throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
        }

        const receipt = await this.#transport.send({
          spaceId: claim.spaceId,
          clientGuid: claim.clientGuid,
          claimToken: claim.claimToken,
          text,
          signal,
        });
        acknowledged = true;
        stage = "checkpoint";
        const result = await this.#repository.checkpointSent({
          outboundBatchId: claim.outboundBatchId,
          claimToken: claim.claimToken,
          position: claim.position,
          externalMessageId: receipt.externalMessageId,
          sentAt: receipt.sentAt,
        });
        checkpointed = true;
        return result;
      });
    } catch (error) {
      primaryFailure = true;
      if (acknowledged && !checkpointed) {
        uncertain = true;
        throw new UncertainDeliveryError({
          outboundBatchId: claim.outboundBatchId,
          position: claim.position,
          clientGuid: claim.clientGuid,
          claimToken: claim.claimToken,
          cause: error,
        });
      }
      if (error instanceof DeliveryError) {
        throw error;
      }
      if (signal.aborted && error === signal.reason) {
        throw error;
      }
      throw new DeliveryError(
        stage === "decrypt"
          ? "DELIVERY_BATCH_INVALID"
          : "DELIVERY_TRANSPORT_FAILED",
        stage !== "decrypt",
        { cause: error },
      );
    } finally {
      if (!checkpointed && !uncertain) {
        try {
          await this.#repository.release({
            outboundBatchId: claim.outboundBatchId,
            claimToken: claim.claimToken,
            now: this.#now(),
          });
        } catch (error) {
          if (!primaryFailure) {
            throw new DeliveryError("DELIVERY_CLAIM_LOST", true, {
              cause: error,
            });
          }
        }
      }
    }
  }
}
