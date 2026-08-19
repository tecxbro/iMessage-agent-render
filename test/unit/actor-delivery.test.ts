import { describe, expect, it, vi } from "vitest";

import { ActorDelivery } from "../../src/conversation/actor-delivery.js";

describe("actor delivery", () => {
  it("materializes before direct and durable wakes and accepts wake failures", async () => {
    const events: string[] = [];
    const directFailure = new Error("direct delivery wake failed");
    const durableFailure = new Error("durable delivery wake failed");
    const onWakeFailure = vi.fn();
    const materializeInteractionBatch = vi.fn(async (input: unknown) => {
      events.push("materialize");
      expect(input).toMatchObject({
        interactionRunId: "40000000-0000-4000-8000-000000000001",
        spaceId: "40000000-0000-4000-8000-000000000002",
        generation: 7,
        encryptedParts: ["cipher:First answer bubble.", "cipher:Second answer bubble."],
      });
      return "40000000-0000-4000-8000-000000000003";
    });
    const wake = vi.fn(() => {
      events.push("direct");
      return Promise.reject(directFailure);
    });
    const enqueueOutboundCoordinate = vi.fn(async (payload: unknown) => {
      events.push("durable");
      expect(payload).toEqual({
        outboundBatchId: "40000000-0000-4000-8000-000000000003",
      });
      throw durableFailure;
    });
    const delivery = new ActorDelivery({
      repository: { materializeInteractionBatch },
      coordinator: { wake },
      publisher: { enqueueOutboundCoordinate },
      cipher: { encrypt: (plaintext) => `cipher:${plaintext}` },
      onWakeFailure,
    });

    await expect(
      delivery.prepare({
        interactionRunId: "40000000-0000-4000-8000-000000000001",
        spaceId: "40000000-0000-4000-8000-000000000002",
        generation: 7,
        draftOutput: "First answer bubble.\n\nSecond answer bubble.",
      }),
    ).resolves.toEqual({
      outboundBatchId: "40000000-0000-4000-8000-000000000003",
    });
    await Promise.resolve();

    expect(events).toEqual(["materialize", "direct", "durable"]);
    expect(onWakeFailure).toHaveBeenCalledWith({
      outboundBatchId: "40000000-0000-4000-8000-000000000003",
      trigger: "direct",
      error: directFailure,
    });
    expect(onWakeFailure).toHaveBeenCalledWith({
      outboundBatchId: "40000000-0000-4000-8000-000000000003",
      trigger: "durable",
      error: durableFailure,
    });
  });
});
