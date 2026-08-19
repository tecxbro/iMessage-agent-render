import { describe, expect, it, vi } from "vitest";

import { createOutboundSendHandler } from "../../src/queue/handlers/outbound-send.js";

const batchId = "00000000-0000-4000-8000-000000000010";

describe("legacy outbound job restart compatibility", () => {
  it("retries by waking the same canonical batch after a worker failure", async () => {
    const outage = new Error("simulated coordinator outage");
    const wake = vi
      .fn()
      .mockRejectedValueOnce(outage)
      .mockResolvedValueOnce(undefined);
    const handler = createOutboundSendHandler({ coordinator: { wake } });
    const payload = {
      outboundBatchId: batchId,
      expectedState: "sending" as const,
    };

    await expect(handler(payload)).rejects.toBe(outage);
    await expect(handler(payload)).resolves.toBeUndefined();

    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls.map(([id]) => id)).toEqual([batchId, batchId]);
  });
});
