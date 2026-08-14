import { describe, expect, it, vi } from "vitest";

import {
  OutboundTransport,
  STABLE_GUID_OPERATOR_GUIDANCE,
  type NativeStableGuidSender,
  type RespondingSpace,
} from "../../../src/transport/outbound.js";
import { SpaceResolver } from "../../../src/transport/space-resolver.js";

interface FakeSpace extends RespondingSpace {
  typing: boolean;
}

function fakeSpace(): FakeSpace {
  return {
    typing: false,
    async responding<Result>(callback: () => Result | Promise<Result>) {
      this.typing = true;
      try {
        return await callback();
      } finally {
        this.typing = false;
      }
    },
  };
}

const route = {
  routePhone: "+15559999999",
  spaceGuid: "opaque-space-guid",
  spaceType: "dm",
} as const;

describe("Spectrum outbound transport", () => {
  it("fails closed with operator guidance when native stable GUID support is absent", async () => {
    const get = vi.fn(async () => fakeSpace());
    const transport = new OutboundTransport({
      resolver: new SpaceResolver({ get }),
    });

    await expect(
      transport.sendBatch(
        {
          bubbles: [{ clientGuid: "stable-guid-0", text: "hello" }],
          route,
          startIndex: 0,
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      code: "SPECTRUM_STABLE_CLIENT_GUID_UNAVAILABLE",
      message: expect.stringContaining(STABLE_GUID_OPERATOR_GUIDANCE),
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("retries an acknowledged-but-uncheckpointed bubble with the identical GUID", async () => {
    const space = fakeSpace();
    const attempts: string[] = [];
    const sender: NativeStableGuidSender<FakeSpace> = {
      sendText: vi.fn(async (_resolvedSpace, bubble) => {
        attempts.push(bubble.clientGuid);
        return { externalMessageId: "provider-message-id" };
      }),
    };
    const transport = new OutboundTransport({
      resolver: new SpaceResolver({ get: async () => space }),
      stableGuidSender: sender,
    });
    const batch = {
      bubbles: [{ clientGuid: "stable-guid-0", text: "hello" }],
      route,
      startIndex: 0,
    } as const;
    const failedCheckpoint = vi.fn(async () => {
      throw new Error("database checkpoint failed");
    });

    await expect(
      transport.sendBatch(batch, failedCheckpoint),
    ).rejects.toThrow("database checkpoint failed");
    expect(space.typing).toBe(false);

    const successfulCheckpoint = vi.fn(async () => undefined);
    await transport.sendBatch(batch, successfulCheckpoint);

    expect(attempts).toEqual(["stable-guid-0", "stable-guid-0"]);
    expect(successfulCheckpoint).toHaveBeenCalledWith(1);
    expect(space.typing).toBe(false);
  });

  it("resumes a partial batch at its persisted cursor without changing GUIDs", async () => {
    const space = fakeSpace();
    const attempts: string[] = [];
    let failSecond = true;
    const sender: NativeStableGuidSender<FakeSpace> = {
      async sendText(_resolvedSpace, bubble) {
        attempts.push(bubble.clientGuid);
        if (bubble.clientGuid === "stable-guid-1" && failSecond) {
          failSecond = false;
          throw new Error("transient transport failure");
        }
        return undefined;
      },
    };
    const transport = new OutboundTransport({
      resolver: new SpaceResolver({ get: async () => space }),
      stableGuidSender: sender,
    });
    const bubbles = [
      { clientGuid: "stable-guid-0", text: "one" },
      { clientGuid: "stable-guid-1", text: "two" },
      { clientGuid: "stable-guid-2", text: "three" },
    ] as const;
    const cursors: number[] = [];

    await expect(
      transport.sendBatch(
        { bubbles, route, startIndex: 0 },
        async (cursor) => {
          cursors.push(cursor);
        },
      ),
    ).rejects.toThrow("transient transport failure");

    await transport.sendBatch(
      { bubbles, route, startIndex: 1 },
      async (cursor) => {
        cursors.push(cursor);
      },
    );

    expect(attempts).toEqual([
      "stable-guid-0",
      "stable-guid-1",
      "stable-guid-1",
      "stable-guid-2",
    ]);
    expect(cursors).toEqual([1, 2, 3]);
    expect(space.typing).toBe(false);
  });

  it("rejects duplicate client GUIDs before resolving a space", async () => {
    const get = vi.fn(async () => fakeSpace());
    const transport = new OutboundTransport({
      resolver: new SpaceResolver({ get }),
      stableGuidSender: { sendText: async () => undefined },
    });

    await expect(
      transport.sendBatch(
        {
          bubbles: [
            { clientGuid: "same-guid", text: "one" },
            { clientGuid: "same-guid", text: "two" },
          ],
          route,
          startIndex: 0,
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "SPECTRUM_OUTBOUND_BATCH_INVALID" });
    expect(get).not.toHaveBeenCalled();
  });
});
