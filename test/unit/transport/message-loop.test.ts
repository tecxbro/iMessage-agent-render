import type { Message, Space } from "spectrum-ts";
import { describe, expect, it, vi } from "vitest";

import { SpectrumReadiness } from "../../../src/http/readiness.js";
import {
  handleSpectrumMessage,
  runSpectrumMessageLoop,
  SpectrumMessageLoopError,
  type AuthorizeAndIngest,
} from "../../../src/transport/message-loop.js";

function fakeSpace(
  overrides: Partial<Record<"id" | "phone" | "type", string>> = {},
): Space {
  return {
    __platform: "imessage",
    id: overrides.id ?? "opaque-space-guid",
    phone: overrides.phone ?? "+15559999999",
    send: vi.fn(async () => undefined),
    type: overrides.type ?? "dm",
  } as unknown as Space;
}

function fakeMessage(
  space: Space,
  overrides: {
    content?: unknown;
    direction?: "inbound" | "outbound";
    id?: string;
    platform?: string;
    sender?: unknown;
  } = {},
): Message {
  return {
    content: overrides.content ?? { type: "text", text: "hello" },
    direction: overrides.direction ?? "inbound",
    id: overrides.id ?? "external-message-id",
    platform: overrides.platform ?? "imessage",
    sender:
      "sender" in overrides
        ? overrides.sender
        : {
            __platform: "imessage",
            address: "Owner@Example.com",
            id: "Owner@Example.com",
            service: "iMessage",
          },
    space,
    timestamp: new Date("2026-08-14T12:00:00.000Z"),
  } as unknown as Message;
}

function ingestion(
  implementation: AuthorizeAndIngest["authorizeAndIngest"] = async () =>
    "accepted",
): AuthorizeAndIngest {
  return { authorizeAndIngest: vi.fn(implementation) };
}

describe("Spectrum message handling", () => {
  it("normalizes one inbound text event and hands it to authorization/ingestion", async () => {
    const authorizeAndIngest = ingestion();
    const space = fakeSpace();

    await expect(
      handleSpectrumMessage(space, fakeMessage(space), { authorizeAndIngest }),
    ).resolves.toBe("accepted");

    expect(authorizeAndIngest.authorizeAndIngest).toHaveBeenCalledTimes(1);
    expect(authorizeAndIngest.authorizeAndIngest).toHaveBeenCalledWith(
      {
        externalMessageId: "external-message-id",
        receivedAt: new Date("2026-08-14T12:00:00.000Z"),
        sender: {
          address: "owner@example.com",
          kind: "email",
          service: "iMessage",
        },
        space: {
          routePhone: "+15559999999",
          spaceGuid: "opaque-space-guid",
          spaceType: "dm",
        },
        text: "hello",
      },
      {},
    );
  });

  it("treats a duplicate external message disposition as harmless", async () => {
    const authorizeAndIngest = ingestion(async () => "duplicate");
    const space = fakeSpace();

    await expect(
      handleSpectrumMessage(space, fakeMessage(space), { authorizeAndIngest }),
    ).resolves.toBe("duplicate");
  });

  it.each([
    ["outbound echo", { direction: "outbound" }, "outbound-echo"],
    [
      "reaction",
      { content: { type: "reaction", emoji: "like" } },
      "unsupported-content",
    ],
    [
      "read receipt",
      { content: { type: "read", target: {} } },
      "unsupported-content",
    ],
    [
      "attachment",
      { content: { type: "attachment", name: "photo.jpg" } },
      "unsupported-content",
    ],
    ["other platform", { platform: "telegram" }, "non-imessage"],
  ] as const)("ignores %s events", async (_name, overrides, expected) => {
    const authorizeAndIngest = ingestion();
    const onIgnored = vi.fn();
    const space = fakeSpace();

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, overrides), {
        authorizeAndIngest,
        onIgnored,
      }),
    ).resolves.toBe(expected);

    expect(authorizeAndIngest.authorizeAndIngest).not.toHaveBeenCalled();
    expect(onIgnored).toHaveBeenCalledWith(expected);
  });

  it("ignores a missing sender before authorization handoff", async () => {
    const authorizeAndIngest = ingestion();
    const space = fakeSpace();

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, { sender: null }), {
        authorizeAndIngest,
      }),
    ).resolves.toBe("invalid-sender");
    expect(authorizeAndIngest.authorizeAndIngest).not.toHaveBeenCalled();
  });
});

describe("supervised Spectrum receive loop", () => {
  it("marks readiness degraded and stops after the bounded restart limit", async () => {
    const readiness = new SpectrumReadiness();
    const messages = vi.fn(() => {
      async function* disconnected(): AsyncIterable<readonly [Space, Message]> {
        throw new Error("provider disconnected for +15559999999");
      }
      return disconnected();
    });
    const wait = vi.fn(
      async (_milliseconds: number, _signal?: AbortSignal) => undefined,
    );

    await expect(
      runSpectrumMessageLoop({
        authorizeAndIngest: ingestion(),
        messages,
        readiness,
        restartPolicy: {
          initialDelayMs: 5,
          maximumDelayMs: 10,
          maxRestarts: 2,
        },
        wait,
      }),
    ).rejects.toMatchObject({
      code: "SPECTRUM_STREAM_RESTART_EXHAUSTED",
    } satisfies Partial<SpectrumMessageLoopError>);

    expect(messages).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([5, 10]);
    expect(readiness.snapshot()).toEqual({
      component: "spectrum",
      failureCode: "SPECTRUM_STREAM_RESTART_EXHAUSTED",
      ready: false,
      restartAttempt: 3,
      state: "degraded",
    });
    expect(JSON.stringify(readiness.snapshot())).not.toContain("+15559999999");
  });

  it("reconnects after a failure and stops cleanly when aborted", async () => {
    const controller = new AbortController();
    const readiness = new SpectrumReadiness();
    const space = fakeSpace();
    let sourceNumber = 0;
    const messages = vi.fn(() => {
      sourceNumber += 1;
      if (sourceNumber === 1) {
        return (async function* disconnected(): AsyncIterable<
          readonly [Space, Message]
        > {
          throw new Error("temporary disconnect");
        })();
      }

      return (async function* recovered(): AsyncIterable<
        readonly [Space, Message]
      > {
        yield [space, fakeMessage(space)] as const;
      })();
    });
    const authorizeAndIngest = ingestion(async () => {
      controller.abort();
      return "accepted";
    });

    await expect(
      runSpectrumMessageLoop({
        authorizeAndIngest,
        messages,
        readiness,
        restartPolicy: {
          initialDelayMs: 1,
          maximumDelayMs: 1,
          maxRestarts: 1,
        },
        signal: controller.signal,
        wait: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(messages).toHaveBeenCalledTimes(2);
    expect(authorizeAndIngest.authorizeAndIngest).toHaveBeenCalledTimes(1);
    expect(readiness.snapshot()).toEqual({
      component: "spectrum",
      ready: false,
      state: "stopped",
    });
  });
});
