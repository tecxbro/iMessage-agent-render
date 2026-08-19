import { describe, expect, it, vi } from "vitest";

import { CodexAppServerActorRuntime } from "../../src/agent/codex-app-server/actor-runtime.js";
import { CodexAppServerEventRouter } from "../../src/agent/codex-app-server/event-router.js";
import { CodexAppServerInteractionClient } from "../../src/agent/codex-app-server/interaction-client.js";
import { loadPromptBundle } from "../../src/config/prompt-bundle.js";
import type { InteractionRunRecord } from "../../src/conversation/state.js";
import type {
  SecureInteractionPermitTarget,
  SecureInteractionStartGate,
} from "../../src/security/secure-interaction-start-gate.js";

const ids = {
  space: "40000000-0000-4000-8000-000000000001",
  run: "40000000-0000-4000-8000-000000000002",
  message: "40000000-0000-4000-8000-000000000003",
} as const;

function activeRun(): InteractionRunRecord {
  return {
    id: ids.run,
    spaceId: ids.space,
    generation: 3,
    state: "starting",
    threadId: null,
    turnId: null,
    startedThroughSequence: 1,
    acceptedThroughSequence: 1,
    modelId: "gpt-5.6-luna",
    reasoningEffort: "high",
    promptVersion: "conversation-v1",
    promptSha256: "a".repeat(64),
    decisionMetadataJson: null,
    draftOutputCiphertext: null,
    terminalReason: null,
    lastObservedEventJson: null,
    startedAt: new Date("2026-08-19T10:00:00Z"),
    completedAt: null,
    updatedAt: new Date("2026-08-19T10:00:00Z"),
  };
}

describe("Codex App Server actor runtime", () => {
  it("authorizes before creating a thread and returns a separated structured draft", async () => {
    const events: string[] = [];
    const requests: Array<{ method: string; params: unknown }> = [];
    const decision = {
      mode: "direct",
      userMessage: "The direct actor answer.",
      statusMessage: null,
      tasks: [],
      waitForTasks: false,
      memoryCandidates: [],
    };
    const completedTurn = {
      id: "turn-actor",
      status: "completed",
      items: [
        {
          type: "agentMessage",
          id: "item-actor",
          text: JSON.stringify(decision),
          phase: null,
          memoryCitation: null,
        },
      ],
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(9);
    const client = new CodexAppServerInteractionClient(
      {
        async request(method, params) {
          events.push(method);
          requests.push({ method, params });
          if (method === "thread/start") {
            return { thread: { id: "thread-actor", turns: [] } };
          }
          if (method === "turn/start") {
            return { turn: completedTurn };
          }
          throw new Error(`Unexpected App Server method: ${method}`);
        },
        generation: () => 9,
      },
      eventRouter,
    );
    const issuePermit = vi.fn(async () => {
      events.push("permit");
      return {
        async execute<Value>(
          _target: SecureInteractionPermitTarget,
          operation: () => Promise<Value>,
        ): Promise<Value> {
          events.push("permit.execute");
          return await operation();
        },
        dispose: vi.fn(),
      };
    });
    const threadStore = {
      load: vi.fn(async () => null),
      store: vi.fn(async () => undefined),
    };
    const runtime = new CodexAppServerActorRuntime({
      supervisor: { interactionClient: client, generation: () => 9 },
      gate: { issuePermit } as unknown as Pick<
        SecureInteractionStartGate,
        "issuePermit"
      >,
      threads: threadStore,
      promptBundle: await loadPromptBundle(),
      workingDirectory: "/tmp/actor-workspace",
    });
    const signal = new AbortController().signal;
    const run = activeRun();

    const session = await runtime.start({
      run,
      context: {
        spaceId: ids.space,
        interactionRunId: ids.run,
        fromSequence: 1,
        throughSequence: 1,
        messages: [
          { messageId: ids.message, inputSequence: 1, text: "Answer this." },
        ],
        conversationHistory: [],
        taskResults: [],
      },
      signal,
    });
    const completion = await runtime.waitForCompletion({
      interactionRunId: ids.run,
      session,
      signal,
    });

    expect(events).toEqual([
      "permit",
      "permit.execute",
      "thread/start",
      "turn/start",
    ]);
    expect(issuePermit).toHaveBeenCalledWith({
      action: "turn/start",
      spaceId: ids.space,
      interactionRunId: ids.run,
      generation: 3,
      selectedModelId: "gpt-5.6-luna",
      selectedReasoningEffort: "high",
    });
    expect(requests[0]?.params).toMatchObject({
      model: "gpt-5.6-luna",
      cwd: "/tmp/actor-workspace",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(threadStore.store).toHaveBeenCalledWith(ids.space, "thread-actor");
    expect(requests[1]?.params).toMatchObject({
      threadId: "thread-actor",
      clientUserMessageId: ids.message,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: "gpt-5.6-luna",
      effort: "high",
      outputSchema: expect.any(Object),
    });
    expect(completion).toMatchObject({
      threadId: "thread-actor",
      turnId: "turn-actor",
      decisionMetadataJson: {
        mode: "direct",
        statusMessage: null,
        tasks: [],
        waitForTasks: false,
        memoryCandidates: [],
      },
      draftOutput: "The direct actor answer.",
    });
    expect(completion.decisionMetadataJson).not.toHaveProperty("userMessage");
  });

  it("resumes the durable per-space thread for a later actor run", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(4);
    const client = new CodexAppServerInteractionClient(
      {
        async request(method, params) {
          requests.push({ method, params });
          if (method === "thread/resume") {
            return { thread: { id: "thread-existing", turns: [] } };
          }
          if (method === "turn/start") {
            return {
              turn: {
                id: "turn-later",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    id: "item-later",
                    text: JSON.stringify({
                      mode: "direct",
                      userMessage: "The later answer.",
                      statusMessage: null,
                      tasks: [],
                      waitForTasks: false,
                      memoryCandidates: [],
                    }),
                    phase: null,
                    memoryCitation: null,
                  },
                ],
                itemsView: "full",
                error: null,
                startedAt: 3,
                completedAt: 4,
                durationMs: 1,
              },
            };
          }
          throw new Error(`Unexpected App Server method: ${method}`);
        },
        generation: () => 4,
      },
      eventRouter,
    );
    const gate = {
      issuePermit: async () => ({
        execute: async <Value>(
          _target: SecureInteractionPermitTarget,
          operation: () => Promise<Value>,
        ) => await operation(),
        dispose: vi.fn(),
      }),
    } as unknown as Pick<SecureInteractionStartGate, "issuePermit">;
    const threads = {
      load: vi.fn(async () => "thread-existing"),
      store: vi.fn(async () => undefined),
    };
    const runtime = new CodexAppServerActorRuntime({
      supervisor: { interactionClient: client, generation: () => 4 },
      gate,
      threads,
      promptBundle: await loadPromptBundle(),
      workingDirectory: "/tmp/actor-workspace",
    });
    const signal = new AbortController().signal;
    const session = await runtime.start({
      run: activeRun(),
      context: {
        spaceId: ids.space,
        interactionRunId: ids.run,
        fromSequence: 2,
        throughSequence: 2,
        messages: [
          { messageId: ids.message, inputSequence: 2, text: "Follow up." },
        ],
        conversationHistory: ["Do not replay this stored-thread history."],
        taskResults: [],
      },
      signal,
    });
    await runtime.waitForCompletion({
      interactionRunId: ids.run,
      session,
      signal,
    });

    expect(requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    expect(requests[0]?.params).toMatchObject({
      threadId: "thread-existing",
    });
    expect(JSON.stringify(requests[1]?.params)).not.toContain(
      "Do not replay this stored-thread history.",
    );
    expect(threads.store).toHaveBeenCalledWith(ids.space, "thread-existing");
  });

  it("interrupts an in-progress App Server turn when the actor stops waiting", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(6);
    const client = new CodexAppServerInteractionClient(
      {
        async request(method, params) {
          requests.push({ method, params });
          if (method === "thread/start") {
            return { thread: { id: "thread-cancel", turns: [] } };
          }
          if (method === "turn/start") {
            return {
              turn: {
                id: "turn-cancel",
                status: "inProgress",
                items: [],
                itemsView: "full",
                error: null,
                startedAt: 1,
                completedAt: null,
                durationMs: null,
              },
            };
          }
          if (method === "turn/interrupt") return {};
          throw new Error(`Unexpected App Server method: ${method}`);
        },
        generation: () => 6,
      },
      eventRouter,
    );
    const gate = {
      issuePermit: vi.fn(async () => ({
        execute: async <Value>(
          _target: SecureInteractionPermitTarget,
          operation: () => Promise<Value>,
        ) => await operation(),
        dispose: vi.fn(),
      })),
    } as unknown as Pick<SecureInteractionStartGate, "issuePermit">;
    const runtime = new CodexAppServerActorRuntime({
      supervisor: { interactionClient: client, generation: () => 6 },
      gate,
      threads: {
        load: vi.fn(async () => null),
        store: vi.fn(async () => undefined),
      },
      promptBundle: await loadPromptBundle(),
      workingDirectory: "/tmp/actor-workspace",
    });
    const controller = new AbortController();
    const session = await runtime.start({
      run: activeRun(),
      context: {
        spaceId: ids.space,
        interactionRunId: ids.run,
        fromSequence: 1,
        throughSequence: 1,
        messages: [
          { messageId: ids.message, inputSequence: 1, text: "Keep working." },
        ],
        conversationHistory: [],
        taskResults: [],
      },
      signal: controller.signal,
    });
    const waiting = runtime.waitForCompletion({
      interactionRunId: ids.run,
      session,
      signal: controller.signal,
    });

    controller.abort(new DOMException("Actor disposed.", "AbortError"));

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
      "turn/interrupt",
    ]);
    expect(gate.issuePermit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "turn/interrupt" }),
    );
  });
});
