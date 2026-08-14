import { describe, expect, it, vi } from "vitest";

import type { OutboundPartToSend } from "../../src/db/repositories/outbound.js";
import { createOutboundSendHandler } from "../../src/queue/handlers/outbound-send.js";

const batchId = "00000000-0000-4000-8000-000000000010";
const spaceId = "00000000-0000-4000-8000-000000000011";

function part(position: number): OutboundPartToSend {
  return {
    batchId,
    spaceId,
    position,
    clientGuid: `stable-guid-${position}`,
    contentCiphertext: `cipher-${position}`,
  };
}

describe("outbound partial-send recovery", () => {
  it.each([0, 1, 2])(
    "retries the same GUID after acknowledgement before cursor persistence at part %i",
    async (crashPosition) => {
      const parts = [part(0), part(1), part(2)];
      let cursor = 0;
      let crashOnce = true;
      const sentGuids: string[] = [];
      const failures: string[] = [];
      const outbound = {
        claimNextPart: vi.fn(async () => parts[cursor] ?? null),
        checkpointSentPart: vi.fn(
          async (_batchId: string, position: number) => {
            expect(position).toBe(cursor);
            cursor += 1;
            return { batchComplete: cursor === parts.length, nextIndex: cursor };
          },
        ),
      };
      const transport = {
        send: vi.fn(async ({ clientGuid }: { clientGuid: string }) => {
          sentGuids.push(clientGuid);
          return { externalMessageId: `external-${clientGuid}` };
        }),
      };
      const failuresRepository = {
        recordFailureFailSafe: vi.fn(async (event: { errorCode: string }) => {
          failures.push(event.errorCode);
          return true;
        }),
      };

      const handler = createOutboundSendHandler({
        outbound,
        transport,
        failures: failuresRepository,
        decrypt: (ciphertext) => `plain:${ciphertext}`,
        failureRetentionDays: 14,
        afterAcknowledgement: (acknowledgedPart) => {
          if (
            acknowledgedPart.position === crashPosition &&
            crashOnce
          ) {
            crashOnce = false;
            throw new Error(
              "simulated process death after provider acknowledgement",
            );
          }
        },
      });

      await expect(
        handler({ outboundBatchId: batchId, expectedState: "sending" }),
      ).rejects.toThrow("simulated process death");
      expect(cursor).toBe(crashPosition);

      await handler({ outboundBatchId: batchId, expectedState: "sending" });

      expect(cursor).toBe(3);
      const expected = parts.flatMap((item) =>
        item.position === crashPosition
          ? [item.clientGuid, item.clientGuid]
          : [item.clientGuid],
      );
      expect(sentGuids).toEqual(expected);
      expect(failures).toEqual(["OUTBOUND_SEND_FAILED"]);
    },
  );
});
