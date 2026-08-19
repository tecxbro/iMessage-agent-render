import { describe, expect, it } from "vitest";

import { DeliveryError } from "../../src/conversation/errors.js";
import type {
  DeliveryCheckpoint,
  DeliveryClaim,
  DeliveryRepositoryPort,
} from "../../src/delivery/contracts.js";
import { DeliveryCoordinator } from "../../src/delivery/delivery-coordinator.js";
import {
  DeliveryRecovery,
  UncertainDeliveryError,
} from "../../src/delivery/recovery.js";
import { createOutboundCoordinateHandler } from "../../src/queue/handlers/outbound-coordinate.js";

const batchId = "13000000-0000-4000-8000-000000000001";
const spaceId = "13000000-0000-4000-8000-000000000002";
const start = new Date("2026-08-18T20:00:00.000Z");

interface DurableClaim {
  owner: string;
  token: string;
  expiresAt: Date;
}

class DurableMemoryDeliveryRepository implements DeliveryRepositoryPort {
  cursor = 0;
  claim: DurableClaim | undefined;
  failCheckpointOnceAt: number | undefined;
  readonly parts: string[];
  #tokenSequence = 1;

  public constructor(parts: string[]) {
    this.parts = parts;
  }

  public async claimNext(input: {
    outboundBatchId: string;
    claimOwner: string;
    leaseDurationMs: number;
    now: Date;
  }): Promise<DeliveryClaim | null> {
    if (input.outboundBatchId !== batchId) {
      throw new DeliveryError("DELIVERY_BATCH_NOT_FOUND", false);
    }
    if (this.cursor === this.parts.length) {
      return null;
    }
    if (
      this.claim !== undefined &&
      this.claim.expiresAt.getTime() > input.now.getTime()
    ) {
      throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
    }

    const sequence = String(this.#tokenSequence).padStart(12, "0");
    this.#tokenSequence += 1;
    const token = `13000000-0000-4000-8000-${sequence}`;
    const expiresAt = new Date(input.now.getTime() + input.leaseDurationMs);
    this.claim = { owner: input.claimOwner, token, expiresAt };
    const part = this.parts[this.cursor];
    if (part === undefined) {
      throw new Error("durable memory cursor invariant failed");
    }
    return {
      outboundBatchId: batchId,
      spaceId,
      claimOwner: input.claimOwner,
      claimToken: token,
      claimExpiresAt: expiresAt,
      position: this.cursor,
      clientGuid: `stable-guid-${this.cursor}`,
      text: `cipher:${part}`,
    };
  }

  public async checkpointSent(input: {
    outboundBatchId: string;
    claimToken: string;
    position: number;
    externalMessageId: string | null;
    sentAt: Date;
  }): Promise<DeliveryCheckpoint> {
    if (this.failCheckpointOnceAt === input.position) {
      this.failCheckpointOnceAt = undefined;
      throw new Error("simulated checkpoint outage after acknowledgement");
    }
    if (
      input.outboundBatchId !== batchId ||
      this.claim?.token !== input.claimToken ||
      this.cursor !== input.position ||
      this.claim.expiresAt.getTime() <= input.sentAt.getTime()
    ) {
      throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
    }
    this.cursor += 1;
    this.claim = undefined;
    return {
      batchComplete: this.cursor === this.parts.length,
      nextIndex: this.cursor,
    };
  }

  public async release(input: {
    outboundBatchId: string;
    claimToken: string;
    now: Date;
  }): Promise<void> {
    if (
      input.outboundBatchId === batchId &&
      this.claim?.token === input.claimToken
    ) {
      this.claim = undefined;
    }
  }

  public async findRecoverableBatchIds(input: {
    now: Date;
    limit: number;
  }): Promise<string[]> {
    if (
      input.limit > 0 &&
      this.cursor < this.parts.length &&
      (this.claim === undefined ||
        this.claim.expiresAt.getTime() <= input.now.getTime())
    ) {
      return [batchId];
    }
    return [];
  }
}

class IdempotentProvider {
  readonly attempts: string[] = [];
  readonly delivered: string[] = [];
  readonly #receipts = new Map<string, string>();
  failOnceFor: string | undefined;

  public async send(
    input: { clientGuid: string },
    sentAt: Date,
  ): Promise<{ externalMessageId: string; sentAt: Date }> {
    this.attempts.push(input.clientGuid);
    if (this.failOnceFor === input.clientGuid) {
      this.failOnceFor = undefined;
      throw new Error("simulated Spectrum outage");
    }
    let externalMessageId = this.#receipts.get(input.clientGuid);
    if (externalMessageId === undefined) {
      externalMessageId = `provider:${input.clientGuid}`;
      this.#receipts.set(input.clientGuid, externalMessageId);
      this.delivered.push(input.clientGuid);
    }
    return { externalMessageId, sentAt };
  }
}

function coordinator(input: {
  repository: DurableMemoryDeliveryRepository;
  provider: IdempotentProvider;
  owner: string;
  now: () => Date;
  leaseDurationMs?: number;
}): DeliveryCoordinator {
  return new DeliveryCoordinator({
    repository: input.repository,
    transport: {
      send: async (request) => await input.provider.send(request, input.now()),
    },
    decrypt: (ciphertext) => ciphertext.replace(/^cipher:/u, ""),
    claimOwner: input.owner,
    leaseDurationMs: input.leaseDurationMs ?? 1_000,
    now: input.now,
  });
}

describe("durable delivery recovery", () => {
  it("recovers an abandoned claim only after its lease expires", async () => {
    let now = start;
    const repository = new DurableMemoryDeliveryRepository(["one"]);
    const abandoned = await repository.claimNext({
      outboundBatchId: batchId,
      claimOwner: "dead-process",
      leaseDurationMs: 1_000,
      now,
    });
    expect(abandoned?.position).toBe(0);
    const published: string[] = [];
    const recovery = new DeliveryRecovery({
      repository,
      publisher: {
        async publish(payload) {
          published.push(payload.outboundBatchId);
        },
      },
      now: () => now,
    });

    await expect(recovery.recover()).resolves.toBe(0);
    now = new Date(start.getTime() + 1_000);
    await expect(recovery.recover()).resolves.toBe(1);
    expect(published).toEqual([batchId]);

    const provider = new IdempotentProvider();
    await coordinator({
      repository,
      provider,
      owner: "replacement-process",
      now: () => now,
    }).wake(batchId);
    expect(repository.cursor).toBe(1);
    expect(provider.delivered).toEqual(["stable-guid-0"]);
  });

  it("classifies acknowledgement without checkpoint and waits for recovery", async () => {
    let now = start;
    const repository = new DurableMemoryDeliveryRepository(["one", "two"]);
    repository.failCheckpointOnceAt = 0;
    const provider = new IdempotentProvider();
    const firstProcess = coordinator({
      repository,
      provider,
      owner: "delivery-process-a",
      now: () => now,
    });

    await expect(firstProcess.wake(batchId)).rejects.toBeInstanceOf(
      UncertainDeliveryError,
    );
    expect(repository.cursor).toBe(0);
    expect(repository.claim).toBeDefined();
    expect(provider.delivered).toEqual(["stable-guid-0"]);

    const restarted = coordinator({
      repository,
      provider,
      owner: "delivery-process-b",
      now: () => now,
    });
    await expect(restarted.wake(batchId)).rejects.toMatchObject({
      code: "DELIVERY_CLAIM_LOST",
      retryable: true,
    });
    expect(provider.attempts).toEqual(["stable-guid-0"]);

    const payloads: Array<{ outboundBatchId: string }> = [];
    const recovery = new DeliveryRecovery({
      repository,
      publisher: {
        async publish(payload) {
          payloads.push(payload);
        },
      },
      now: () => now,
    });
    await expect(recovery.recover()).resolves.toBe(0);

    now = new Date(start.getTime() + 1_000);
    await expect(recovery.recover()).resolves.toBe(1);
    const handler = createOutboundCoordinateHandler({ coordinator: restarted });
    const payload = payloads[0];
    expect(payload).toEqual({ outboundBatchId: batchId });
    if (payload === undefined) {
      throw new Error("expected recovery wake payload");
    }
    await handler(payload, new AbortController().signal);

    expect(provider.attempts).toEqual([
      "stable-guid-0",
      "stable-guid-0",
      "stable-guid-1",
    ]);
    expect(provider.delivered).toEqual(["stable-guid-0", "stable-guid-1"]);
    expect(repository.cursor).toBe(2);
  });

  it("releases provider failures and restarts at the first unsent part", async () => {
    const repository = new DurableMemoryDeliveryRepository([
      "one",
      "two",
      "three",
    ]);
    const provider = new IdempotentProvider();
    provider.failOnceFor = "stable-guid-1";
    const firstProcess = coordinator({
      repository,
      provider,
      owner: "delivery-process-a",
      now: () => start,
    });

    await expect(firstProcess.wake(batchId)).rejects.toMatchObject({
      code: "DELIVERY_TRANSPORT_FAILED",
      retryable: true,
    });
    expect(repository.cursor).toBe(1);
    expect(repository.claim).toBeUndefined();

    const restarted = coordinator({
      repository,
      provider,
      owner: "delivery-process-b",
      now: () => start,
    });
    await restarted.wake(batchId);

    expect(provider.attempts).toEqual([
      "stable-guid-0",
      "stable-guid-1",
      "stable-guid-1",
      "stable-guid-2",
    ]);
    expect(provider.delivered).toEqual([
      "stable-guid-0",
      "stable-guid-1",
      "stable-guid-2",
    ]);
    expect(repository.cursor).toBe(3);
  });
});
