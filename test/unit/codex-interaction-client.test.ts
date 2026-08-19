import { describe, expect, it, vi } from "vitest";

import { CodexAppServerEventRouter } from "../../src/agent/codex-app-server/event-router.js";
import { CodexAppServerInteractionClient } from "../../src/agent/codex-app-server/interaction-client.js";
import { CodexAppServerRequestTimeoutError } from "../../src/agent/codex-app-server/protocol.js";

const thread = (id: string) => ({ id, turns: [] });
const turn = (id: string) => ({
  id,
  status: "inProgress",
  items: [],
  itemsView: "full",
  error: null,
  startedAt: 1,
  completedAt: null,
  durationMs: null,
});
const textInput = (text: string) => ({
  type: "text" as const,
  text,
  text_elements: [],
});

describe("CodexAppServerInteractionClient", () => {
  it("implements the six typed thread and turn methods", async () => {
    const requests: Array<{
      method: string;
      params: unknown;
      options: { expectedGeneration?: number } | undefined;
    }> = [];
    const responses: Record<string, unknown> = {
      "thread/start": { thread: thread("thread-started") },
      "thread/resume": { thread: thread("thread-resumed") },
      "thread/read": { thread: thread("thread-read") },
      "turn/start": { turn: turn("turn-started") },
      "turn/steer": { turnId: "turn-started" },
      "turn/interrupt": {},
    };
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(4);
    const client = new CodexAppServerInteractionClient(
      {
        async request(method, params, options) {
          requests.push({ method, params, options });
          return responses[method];
        },
        generation: () => 4,
      },
      eventRouter,
    );

    await expect(client.threadStart({ model: "gpt-5.6-luna" })).resolves.toMatchObject({
      thread: { id: "thread-started" },
    });
    await expect(
      client.threadResume({ threadId: "thread-resumed" }),
    ).resolves.toMatchObject({ thread: { id: "thread-resumed" } });
    await expect(
      client.threadRead({ threadId: "thread-read", includeTurns: true }),
    ).resolves.toMatchObject({ thread: { id: "thread-read" } });
    await expect(
      client.turnStart({
        threadId: "thread-started",
        clientUserMessageId: "message-start",
        input: [textInput("start")],
      }, { expectedGeneration: 4 }),
    ).resolves.toMatchObject({ turn: { id: "turn-started" } });
    await expect(
      client.turnSteer({
        threadId: "thread-started",
        expectedTurnId: "turn-started",
        clientUserMessageId: "message-steer",
        input: [textInput("steer")],
      }, { expectedGeneration: 4 }),
    ).resolves.toEqual({
      state: "accepted",
      response: { turnId: "turn-started" },
    });
    await expect(
      client.turnInterrupt({
        threadId: "thread-started",
        turnId: "turn-started",
      }, { expectedGeneration: 4 }),
    ).resolves.toEqual({});

    expect(requests.map((request) => request.method)).toEqual([
      "thread/start",
      "thread/resume",
      "thread/read",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ]);
    expect(requests[4]).toEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-started",
        expectedTurnId: "turn-started",
        clientUserMessageId: "message-steer",
        input: [textInput("steer")],
      },
      options: { expectedGeneration: 4 },
    });
  });

  it("routes events by thread, turn, interaction run, and generation", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(7);
    const client = new CodexAppServerInteractionClient(
      {
        async request() {
          throw new Error("not used");
        },
        generation: () => 7,
      },
      eventRouter,
    );
    const first = vi.fn();
    const second = vi.fn();
    client.registerInteraction({
      interactionRunId: "interaction-first",
      threadId: "thread-first",
      turnId: "turn-first",
      generation: 7,
      onEvent: first,
      onProcessClosed() {},
    });
    client.registerInteraction({
      interactionRunId: "interaction-second",
      threadId: "thread-second",
      turnId: "turn-second",
      generation: 7,
      onEvent: second,
      onProcessClosed() {},
    });

    eventRouter.route(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-second",
          turn: { ...turn("turn-second"), status: "completed" },
        },
      },
      7,
    );
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionRunId: "interaction-second",
        threadId: "thread-second",
        turnId: "turn-second",
        generation: 7,
      }),
    );
  });

  it("isolates two turns on the same thread", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(7);
    const first = vi.fn();
    const second = vi.fn();
    eventRouter.register({
      interactionRunId: "interaction-first",
      threadId: "shared-thread",
      turnId: "turn-first",
      generation: 7,
      onEvent: first,
      onProcessClosed() {},
    });
    eventRouter.register({
      interactionRunId: "interaction-second",
      threadId: "shared-thread",
      turnId: "turn-second",
      generation: 7,
      onEvent: second,
      onProcessClosed() {},
    });

    eventRouter.route(
      {
        method: "turn/completed",
        params: {
          threadId: "shared-thread",
          turn: { ...turn("turn-second"), status: "completed" },
        },
      },
      7,
    );

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("buffers a completion that arrives before turn/start resolves", async () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(9);
    const completed = vi.fn();
    const completedTurn = {
      ...turn("turn-fast"),
      status: "completed" as const,
      completedAt: 2,
      durationMs: 1_000,
    };
    const client = new CodexAppServerInteractionClient(
      {
        async request(method) {
          expect(method).toBe("turn/start");
          eventRouter.route(
            {
              method: "turn/completed",
              params: { threadId: "thread-fast", turn: completedTurn },
            },
            9,
          );
          return { turn: completedTurn };
        },
        generation: () => 9,
      },
      eventRouter,
    );

    const started = await client.turnStartInteraction(
      {
        threadId: "thread-fast",
        clientUserMessageId: "message-fast",
        input: [textInput("start")],
      },
      {
        interactionRunId: "interaction-fast",
        generation: 9,
        onEvent: completed,
        onProcessClosed() {},
      },
    );

    expect(started.response.turn.id).toBe("turn-fast");
    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionRunId: "interaction-fast",
        turnId: "turn-fast",
        generation: 9,
      }),
    );
  });

  it("does not bind a delayed old-turn completion to a pending start", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(6);
    const completed = vi.fn();
    const pending = eventRouter.register({
      interactionRunId: "pending-run",
      threadId: "shared-thread",
      generation: 6,
      onEvent: completed,
      onProcessClosed() {},
    });

    eventRouter.route(
      {
        method: "turn/completed",
        params: {
          threadId: "shared-thread",
          turn: { ...turn("old-turn"), status: "completed" },
        },
      },
      6,
    );
    pending.bindTurn("new-turn");

    expect(completed).not.toHaveBeenCalled();
    expect(eventRouter.diagnostics().at(-1)).toMatchObject({
      method: "turn/completed",
      threadId: "shared-thread",
      turnId: "old-turn",
      generation: 6,
      reason: "unknown_interaction",
    });
  });

  it("rejects duplicate interaction routes", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(6);
    eventRouter.register({
      interactionRunId: "first-run",
      threadId: "thread",
      turnId: "turn",
      generation: 6,
      onEvent() {},
      onProcessClosed() {},
    });

    expect(() =>
      eventRouter.register({
        interactionRunId: "second-run",
        threadId: "thread",
        turnId: "turn",
        generation: 6,
        onEvent() {},
        onProcessClosed() {},
      }),
    ).toThrow("Interaction route is already registered.");
  });

  it("isolates a throwing event callback from other actors", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(6);
    const second = vi.fn();
    eventRouter.register({
      interactionRunId: "first-run",
      threadId: "thread",
      turnId: "first-turn",
      generation: 6,
      onEvent() {
        throw new Error("first actor failed");
      },
      onProcessClosed() {},
    });
    eventRouter.register({
      interactionRunId: "second-run",
      threadId: "thread",
      turnId: "second-turn",
      generation: 6,
      onEvent: second,
      onProcessClosed() {},
    });

    eventRouter.route(
      {
        method: "thread/status/changed",
        params: { threadId: "thread" },
      },
      6,
    );

    expect(second).toHaveBeenCalledOnce();
  });

  it("records a diagnostic when the pending-event buffer overflows", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(6);
    eventRouter.register({
      interactionRunId: "pending-run",
      threadId: "thread",
      generation: 6,
      onEvent() {},
      onProcessClosed() {},
    });

    for (let index = 0; index < 129; index += 1) {
      eventRouter.route(
        {
          method: "item/started",
          params: { threadId: "thread", turnId: `turn-${index}` },
        },
        6,
      );
    }

    expect(eventRouter.diagnostics()).toContainEqual({
      method: "item/started",
      threadId: "thread",
      turnId: "turn-0",
      generation: 6,
      reason: "unknown_interaction",
    });
  });

  it("records buffered pending events when their process closes", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(6);
    eventRouter.register({
      interactionRunId: "pending-run",
      threadId: "thread",
      generation: 6,
      onEvent() {},
      onProcessClosed() {},
    });
    eventRouter.route(
      {
        method: "item/started",
        params: { threadId: "thread", turnId: "turn" },
      },
      6,
    );

    eventRouter.processClosed(6);

    expect(eventRouter.diagnostics()).toContainEqual({
      method: "item/started",
      threadId: "thread",
      turnId: "turn",
      generation: 6,
      reason: "unknown_interaction",
    });
  });

  it("records and ignores a stale-generation completion", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(8);
    const completed = vi.fn();
    eventRouter.register({
      interactionRunId: "interaction-current",
      threadId: "thread-current",
      turnId: "turn-current",
      generation: 8,
      onEvent: completed,
      onProcessClosed() {},
    });

    eventRouter.route(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-current",
          turn: {
            ...turn("turn-current"),
            status: "completed",
          },
        },
      },
      7,
    );

    expect(completed).not.toHaveBeenCalled();
    expect(eventRouter.diagnostics()).toContainEqual({
      method: "turn/completed",
      threadId: "thread-current",
      turnId: "turn-current",
      generation: 7,
      reason: "stale_generation",
    });
  });

  it("records and ignores a malformed current-generation completion", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(8);
    const completed = vi.fn();
    eventRouter.register({
      interactionRunId: "interaction-current",
      threadId: "thread-current",
      turnId: "turn-current",
      generation: 8,
      onEvent: completed,
      onProcessClosed() {},
    });

    eventRouter.route(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-current",
          turn: turn("turn-current"),
        },
      },
      8,
    );

    expect(completed).not.toHaveBeenCalled();
    expect(eventRouter.diagnostics().at(-1)).toMatchObject({
      method: "turn/completed",
      reason: "malformed_notification",
    });
  });

  it("does not cross-route an ambiguous unbound turn", () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(5);
    const first = vi.fn();
    const second = vi.fn();
    for (const [interactionRunId, onEvent] of [
      ["first", first],
      ["second", second],
    ] as const) {
      eventRouter.register({
        interactionRunId,
        threadId: "shared-thread",
        generation: 5,
        onEvent,
        onProcessClosed() {},
      });
    }

    eventRouter.route(
      {
        method: "turn/started",
        params: {
          threadId: "shared-thread",
          turn: turn("unbound-turn"),
        },
      },
      5,
    );

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(eventRouter.diagnostics()).toEqual([]);
  });

  it("rejects malformed interaction responses at the runtime boundary", async () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(1);
    const client = new CodexAppServerInteractionClient(
      {
        async request() {
          return { thread: { id: "thread", turns: "not-an-array" } };
        },
        generation: () => 1,
      },
      eventRouter,
    );

    await expect(client.threadRead({ threadId: "thread" })).rejects.toThrow(
      "CODEX_APP_SERVER_PROTOCOL_ERROR",
    );
  });

  it("rejects a steer acknowledgement for a different turn", async () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(3);
    const client = new CodexAppServerInteractionClient(
      {
        async request() {
          return { turnId: "different-turn" };
        },
        generation: () => 3,
      },
      eventRouter,
    );

    await expect(
      client.turnSteer({
        threadId: "thread",
        expectedTurnId: "expected-turn",
        clientUserMessageId: "message",
        input: [textInput("steer")],
      }, { expectedGeneration: 3 }),
    ).rejects.toThrow("CODEX_APP_SERVER_PROTOCOL_ERROR");
  });

  it("treats a written steer timeout as uncertain without retrying", async () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(3);
    const request = vi.fn(async () => {
      throw new CodexAppServerRequestTimeoutError(true);
    });
    const client = new CodexAppServerInteractionClient(
      { request, generation: () => 3 },
      eventRouter,
    );

    await expect(
      client.turnSteer(
        {
          threadId: "thread",
          expectedTurnId: "turn",
          clientUserMessageId: "message",
          input: [textInput("steer")],
        },
        { expectedGeneration: 3 },
      ),
    ).resolves.toMatchObject({
      state: "uncertain_submission",
      clientUserMessageId: "message",
      generation: 3,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a thread/read response for another thread", async () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(3);
    const client = new CodexAppServerInteractionClient(
      {
        async request() {
          return { thread: thread("wrong-thread") };
        },
        generation: () => 3,
      },
      eventRouter,
    );

    await expect(
      client.threadRead({ threadId: "expected-thread", includeTurns: true }),
    ).rejects.toThrow("CODEX_APP_SERVER_PROTOCOL_ERROR");
  });
});
