import { describe, expect, it, vi } from "vitest";

import { DeliveryError } from "../../src/conversation/errors.js";
import type {
  DeliveryCheckpoint,
  DeliveryClaim,
  DeliveryRepositoryPort,
} from "../../src/delivery/contracts.js";
import { DeliveryCoordinator } from "../../src/delivery/delivery-coordinator.js";
import { DeliveryRegistry } from "../../src/delivery/delivery-registry.js";
import { SpectrumDeliveryTransport } from "../../src/delivery/spectrum-delivery-transport.js";
import { createOutboundCoordinateHandler } from "../../src/queue/handlers/outbound-coordinate.js";

const batch1 = "00000000-0000-4000-8000-000000000010";
const batch2 = "00000000-0000-4000-8000-000000000011";
const spaceId = "00000000-0000-4000-8000-000000000020";
const baseTime = new Date("2026-08-18T20:00:00.000Z");

interface MemoryBatch {
  spaceId: string;
  parts: string[];
  cursor: number;
  claim:
    | {
        owner: string;
        token: string;
        expiresAt: Date;
      }
    | undefined;
}

class MemoryDeliveryRepository implements DeliveryRepositoryPort {
  readonly batches = new Map<string, MemoryBatch>();
  readonly claimAttempts: string[] = [];
  readonly releases: string[] = [];
  releaseError: Error | undefined;
  #tokenSequence = 1;

  public addBatch(id: string, parts: string[], batchSpaceId = spaceId): void {
    this.batches.set(id, {
      spaceId: batchSpaceId,
      parts,
      cursor: 0,
      claim: undefined,
    });
  }

  public async claimNext(input: {
    outboundBatchId: string;
    claimOwner: string;
    leaseDurationMs: number;
    now: Date;
  }): Promise<DeliveryClaim | null> {
    this.claimAttempts.push(input.outboundBatchId);
    const batch = this.batches.get(input.outboundBatchId);
    if (batch === undefined || batch.cursor === batch.parts.length) {
      return null;
    }
    if (
      batch.claim !== undefined &&
      batch.claim.expiresAt.getTime() > input.now.getTime()
    ) {
      return null;
    }

    const sequence = String(this.#tokenSequence).padStart(12, "0");
    this.#tokenSequence += 1;
    const token = `00000000-0000-4000-8000-${sequence}`;
    const expiresAt = new Date(input.now.getTime() + input.leaseDurationMs);
    batch.claim = { owner: input.claimOwner, token, expiresAt };
    const ciphertext = batch.parts[batch.cursor];
    if (ciphertext === undefined) {
      throw new Error("memory batch cursor invariant failed");
    }
    return {
      outboundBatchId: input.outboundBatchId,
      spaceId: batch.spaceId,
      claimOwner: input.claimOwner,
      claimToken: token,
      claimExpiresAt: expiresAt,
      position: batch.cursor,
      clientGuid: `${input.outboundBatchId}:${batch.cursor}`,
      text: ciphertext,
    };
  }

  public async checkpointSent(input: {
    outboundBatchId: string;
    claimToken: string;
    position: number;
    externalMessageId: string | null;
    sentAt: Date;
  }): Promise<DeliveryCheckpoint> {
    const batch = this.batches.get(input.outboundBatchId);
    if (
      batch?.claim?.token !== input.claimToken ||
      batch.cursor !== input.position ||
      batch.claim.expiresAt.getTime() <= input.sentAt.getTime()
    ) {
      throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
    }
    batch.cursor += 1;
    batch.claim = undefined;
    return {
      batchComplete: batch.cursor === batch.parts.length,
      nextIndex: batch.cursor,
    };
  }

  public async release(input: {
    outboundBatchId: string;
    claimToken: string;
    now: Date;
  }): Promise<void> {
    if (this.releaseError !== undefined) {
      throw this.releaseError;
    }
    const batch = this.batches.get(input.outboundBatchId);
    if (batch?.claim?.token === input.claimToken) {
      batch.claim = undefined;
      this.releases.push(input.claimToken);
    }
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DeliveryCoordinator", () => {
  it("coalesces duplicate direct and queue wakes into one send loop", async () => {
    const repository = new MemoryDeliveryRepository();
    repository.addBatch(batch1, ["cipher:one", "cipher:two"]);
    const firstSend = deferred();
    const sent: Array<{ guid: string; token: string; text: string }> = [];
    let activeSends = 0;
    let maximumActiveSends = 0;
    const transport = {
      send: vi.fn(async (input: {
        clientGuid: string;
        claimToken: string;
        text: string;
      }) => {
        activeSends += 1;
        maximumActiveSends = Math.max(maximumActiveSends, activeSends);
        sent.push({
          guid: input.clientGuid,
          token: input.claimToken,
          text: input.text,
        });
        if (sent.length === 1) {
          await firstSend.promise;
        }
        activeSends -= 1;
        return {
          externalMessageId: `provider:${input.clientGuid}`,
          sentAt: new Date(baseTime.getTime() + 1),
        };
      }),
    };
    const coordinator = new DeliveryCoordinator({
      repository,
      transport,
      decrypt: (ciphertext) => ciphertext.replace(/^cipher:/u, ""),
      claimOwner: "delivery-process-1",
      leaseDurationMs: 60_000,
      now: () => baseTime,
    });
    const queueHandler = createOutboundCoordinateHandler({ coordinator });

    const directWake = coordinator.wake(batch1);
    const queueWake = queueHandler(
      { outboundBatchId: batch1 },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
    expect(repository.claimAttempts).toEqual([batch1]);

    firstSend.resolve();
    await Promise.all([directWake, queueWake]);

    expect(sent.map((attempt) => attempt.text)).toEqual(["one", "two"]);
    expect(new Set(sent.map((attempt) => attempt.token)).size).toBe(2);
    expect(repository.batches.get(batch1)?.cursor).toBe(2);
    expect(maximumActiveSends).toBe(1);
  });

  it("serializes different batches for the same space", async () => {
    const repository = new MemoryDeliveryRepository();
    repository.addBatch(batch1, ["cipher:one"]);
    repository.addBatch(batch2, ["cipher:two"]);
    const releaseFirst = deferred();
    const attempts: string[] = [];
    const coordinator = new DeliveryCoordinator({
      repository,
      registry: new DeliveryRegistry(2),
      transport: {
        async send(input) {
          attempts.push(input.clientGuid);
          if (input.clientGuid.startsWith(batch1)) {
            await releaseFirst.promise;
          }
          return {
            externalMessageId: null,
            sentAt: new Date(baseTime.getTime() + 1),
          };
        },
      },
      decrypt: (ciphertext) => ciphertext,
      claimOwner: "delivery-process-1",
      now: () => baseTime,
    });

    const first = coordinator.wake(batch1);
    const second = coordinator.wake(batch2);
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    expect(attempts[0]).toContain(batch1);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(attempts).toEqual([`${batch1}:0`, `${batch2}:0`]);
  });

  it("releases a failed provider claim so the same part is recoverable", async () => {
    const repository = new MemoryDeliveryRepository();
    repository.addBatch(batch1, ["cipher:one"]);
    let fail = true;
    const attempts: string[] = [];
    const coordinator = new DeliveryCoordinator({
      repository,
      transport: {
        async send(input) {
          attempts.push(input.clientGuid);
          if (fail) {
            fail = false;
            throw new Error("Spectrum unavailable");
          }
          return {
            externalMessageId: "provider-message-1",
            sentAt: new Date(baseTime.getTime() + 1),
          };
        },
      },
      decrypt: (ciphertext) => ciphertext,
      claimOwner: "delivery-process-1",
      now: () => baseTime,
    });

    await expect(coordinator.wake(batch1)).rejects.toMatchObject({
      code: "DELIVERY_TRANSPORT_FAILED",
      retryable: true,
    });
    expect(repository.batches.get(batch1)?.cursor).toBe(0);
    expect(repository.releases).toHaveLength(1);

    await coordinator.wake(batch1);
    expect(attempts).toEqual([`${batch1}:0`, `${batch1}:0`]);
    expect(repository.batches.get(batch1)?.cursor).toBe(1);
  });

  it("preserves the provider failure when claim cleanup also fails", async () => {
    const repository = new MemoryDeliveryRepository();
    repository.addBatch(batch1, ["cipher:one"]);
    repository.releaseError = new Error("database cleanup unavailable");
    const coordinator = new DeliveryCoordinator({
      repository,
      transport: {
        async send() {
          throw new Error("Spectrum unavailable");
        },
      },
      decrypt: (ciphertext) => ciphertext,
      claimOwner: "delivery-process-1",
      now: () => baseTime,
    });

    await expect(coordinator.wake(batch1)).rejects.toMatchObject({
      code: "DELIVERY_TRANSPORT_FAILED",
      retryable: true,
      cause: expect.objectContaining({ message: "Spectrum unavailable" }),
    });
  });

  it("adapts one native Spectrum acknowledgement to a claim-bound receipt", async () => {
    const sender = {
      send: vi.fn(async () => ({ externalMessageId: "provider-message-1" })),
    };
    const sentAt = new Date("2026-08-18T20:00:01.000Z");
    const transport = new SpectrumDeliveryTransport(sender, () => sentAt);

    await expect(
      transport.send({
        spaceId,
        clientGuid: "stable-guid",
        claimToken: "00000000-0000-4000-8000-000000000099",
        text: "hello",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ externalMessageId: "provider-message-1", sentAt });
    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});
