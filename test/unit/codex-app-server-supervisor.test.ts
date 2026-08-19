import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerAuth } from "../../src/agent/codex-app-server-auth.js";
import {
  CodexAppServerGenerationChangedError,
  CodexAppServerRequestTimeoutError,
} from "../../src/agent/codex-app-server/protocol.js";
import { authorizedUserDecision } from "../../src/agent/codex-app-server/request-router.js";
import { CodexAppServerSupervisor } from "../../src/agent/codex-app-server/supervisor.js";
import {
  type CodexAppServerConnection,
  StdioCodexAppServerConnection,
} from "../../src/agent/codex-app-server/transport.js";

const fakeExecutable = join(
  process.cwd(),
  "test/fixtures/fake-codex-app-server/fake-codex-app-server.mjs",
);
const temporaryDirectories: string[] = [];
const supervisors: CodexAppServerSupervisor[] = [];

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map(async (supervisor) => supervisor.close()),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixtureSupervisor(options: {
  requestHandlers?: ConstructorParameters<
    typeof CodexAppServerSupervisor
  >[0]["requestHandlers"];
} = {}): Promise<{ supervisor: CodexAppServerSupervisor; codexHome: string }> {
  const codexHome = await mkdtemp(join(tmpdir(), "shared-codex-supervisor-"));
  temporaryDirectories.push(codexHome);
  await chmod(codexHome, 0o700);
  const supervisor = new CodexAppServerSupervisor({
    codexHome,
    parentEnvironment: { PATH: process.env["PATH"] },
    executablePath: fakeExecutable,
    requestTimeoutMs: 2_000,
    ...(options.requestHandlers === undefined
      ? {}
      : { requestHandlers: options.requestHandlers }),
  });
  supervisors.push(supervisor);
  return { supervisor, codexHome };
}

async function readFixtureState(codexHome: string): Promise<{
  pids: number[];
  requests: Array<{ method: string; params: unknown }>;
  serverResponses: unknown[];
}> {
  return JSON.parse(
    await readFile(join(codexHome, "fake-codex-app-server-state.json"), "utf8"),
  );
}

const textInput = (text: string) => ({
  type: "text" as const,
  text,
  text_elements: [],
});

describe("CodexAppServerSupervisor", () => {
  it("shares one fake process across authentication and concurrent actors", async () => {
    const { supervisor, codexHome } = await fixtureSupervisor();
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      supervisor,
    });

    await expect(auth.initialize()).resolves.toEqual({ state: "connected" });
    const [first, second] = await Promise.all([
      supervisor.interactionClient.threadStart({ model: "gpt-5.6-luna" }),
      supervisor.interactionClient.threadStart({ model: "gpt-5.6-luna" }),
    ]);
    const firstEvent = vi.fn();
    const secondEvent = vi.fn();
    const [firstRun, secondRun] = await Promise.all([
      supervisor.interactionClient.turnStartInteraction(
        {
          threadId: first.thread.id,
          clientUserMessageId: "first-start",
          input: [textInput("first")],
        },
        {
          interactionRunId: "first-run",
          generation: supervisor.generation(),
          onEvent: firstEvent,
          onProcessClosed() {},
        },
      ),
      supervisor.interactionClient.turnStartInteraction(
        {
          threadId: second.thread.id,
          clientUserMessageId: "second-start",
          input: [textInput("second")],
        },
        {
          interactionRunId: "second-run",
          generation: supervisor.generation(),
          onEvent: secondEvent,
          onProcessClosed() {},
        },
      ),
    ]);

    expect(first.thread.id).not.toBe(second.thread.id);
    expect(firstEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionRunId: "first-run",
        threadId: first.thread.id,
        turnId: firstRun.response.turn.id,
      }),
    );
    expect(secondEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionRunId: "second-run",
        threadId: second.thread.id,
        turnId: secondRun.response.turn.id,
      }),
    );
    expect(supervisor.capabilitySource.snapshot()).toMatchObject({
      state: "available",
      planType: "plus",
    });
    const state = await readFixtureState(codexHome);
    expect(state.pids).toHaveLength(1);
    expect(state.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "model/list",
      "thread/start",
      "thread/start",
      "turn/start",
      "turn/start",
    ]);
  });

  it("notifies every active actor, then starts only one replacement generation", async () => {
    const { supervisor, codexHome } = await fixtureSupervisor();
    await supervisor.initialize();
    const [firstThread, secondThread] = await Promise.all([
      supervisor.interactionClient.threadStart({}),
      supervisor.interactionClient.threadStart({}),
    ]);
    const [firstTurn, secondTurn] = await Promise.all([
      supervisor.interactionClient.turnStart({
        threadId: firstThread.thread.id,
        clientUserMessageId: "first-start",
        input: [textInput("first")],
      }, { expectedGeneration: supervisor.generation() }),
      supervisor.interactionClient.turnStart({
        threadId: secondThread.thread.id,
        clientUserMessageId: "second-start",
        input: [textInput("second")],
      }, { expectedGeneration: supervisor.generation() }),
    ]);
    const closed = [
      vi.fn(() => {
        throw new Error("first actor close callback failed");
      }),
      vi.fn(),
    ];
    supervisor.interactionClient.registerInteraction({
      interactionRunId: "run-first",
      threadId: firstThread.thread.id,
      turnId: firstTurn.turn.id,
      generation: supervisor.generation(),
      onEvent() {},
      onProcessClosed: closed[0]!,
    });
    supervisor.interactionClient.registerInteraction({
      interactionRunId: "run-second",
      threadId: secondThread.thread.id,
      turnId: secondTurn.turn.id,
      generation: supervisor.generation(),
      onEvent() {},
      onProcessClosed: closed[1]!,
    });

    await expect(
      supervisor.interactionClient.turnSteer({
        threadId: firstThread.thread.id,
        expectedTurnId: firstTurn.turn.id,
        clientUserMessageId: "accepted-but-unacknowledged",
        input: [textInput("fixture-accepted-steer")],
      }, { expectedGeneration: 1 }),
    ).resolves.toMatchObject({ state: "uncertain_submission", generation: 1 });

    expect(closed[0]).toHaveBeenCalledOnce();
    expect(closed[1]).toHaveBeenCalledOnce();
    await vi.waitFor(async () => {
      expect((await readFixtureState(codexHome)).pids).toHaveLength(2);
      expect(supervisor.generation()).toBe(2);
      expect(supervisor.processIsInitialized()).toBe(true);
    });

    await expect(
      supervisor.interactionClient.turnSteer(
        {
          threadId: firstThread.thread.id,
          expectedTurnId: firstTurn.turn.id,
          clientUserMessageId: "must-not-cross-generation",
          input: [textInput("must not be written")],
        },
        { expectedGeneration: 1 },
      ),
    ).rejects.toBeInstanceOf(CodexAppServerGenerationChangedError);
    expect(
      (await readFixtureState(codexHome)).requests.filter(
        (request) => request.method === "turn/steer",
      ),
    ).toHaveLength(1);
  });

  it("bounds automatic reconnects when every replacement immediately closes", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "bounded-reconnects-"));
    temporaryDirectories.push(codexHome);
    await chmod(codexHome, 0o700);
    let created = 0;
    const connectionFactory = async (): Promise<CodexAppServerConnection> => {
      created += 1;
      let closed = false;
      const closedListeners = new Set<() => void>();
      const emitClosed = () => {
        if (closed) return;
        closed = true;
        for (const listener of closedListeners) listener();
      };
      return {
        async request(method) {
          if (method === "initialize") return { codexHome };
          if (method === "account/read") {
            return {
              account: { type: "chatgpt", email: null, planType: "plus" },
              requiresOpenaiAuth: true,
            };
          }
          if (method === "model/list") {
            return { data: [], nextCursor: null };
          }
          throw new Error(`Unexpected request: ${method}`);
        },
        notify(method) {
          if (method === "initialized") queueMicrotask(emitClosed);
        },
        onNotification() {
          return () => undefined;
        },
        onClosed(listener) {
          if (closed) queueMicrotask(listener);
          else closedListeners.add(listener);
          return () => closedListeners.delete(listener);
        },
        async close() {
          emitClosed();
        },
      };
    };
    const supervisor = new CodexAppServerSupervisor({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory,
    });
    supervisors.push(supervisor);

    await supervisor.initialize().catch(() => undefined);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 900));

    expect(created).toBe(4);
    expect(supervisor.generation()).toBe(4);
    expect(supervisor.processIsInitialized()).toBe(false);
  });

  it("terminates and drains a child before reporting an oversized line closed", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "oversized-app-server-"));
    temporaryDirectories.push(codexHome);
    await chmod(codexHome, 0o700);
    const executablePath = join(codexHome, "oversized-app-server.mjs");
    const terminatedPath = join(codexHome, "terminated.txt");
    await writeFile(
      executablePath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(terminatedPath)}, "terminated\\n", "utf8");
  process.exit(0);
});
process.stdout.write("x".repeat(1_048_577));
setInterval(() => undefined, 1_000);
`,
      { encoding: "utf8", mode: 0o700 },
    );
    const connection = await StdioCodexAppServerConnection.connect({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      executablePath,
      requestTimeoutMs: 1_000,
    });

    await new Promise<void>((resolveClosed, rejectWait) => {
      const timeout = setTimeout(
        () => rejectWait(new Error("transport did not close")),
        3_000,
      );
      connection.onClosed(() => {
        clearTimeout(timeout);
        resolveClosed();
      });
    });

    await expect(readFile(terminatedPath, "utf8")).resolves.toBe(
      "terminated\n",
    );
    await connection.close();
  });

  it("preserves written state when a request times out", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "timed-out-app-server-"));
    temporaryDirectories.push(codexHome);
    await chmod(codexHome, 0o700);
    const executablePath = join(codexHome, "timed-out-app-server.mjs");
    await writeFile(
      executablePath,
      `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => undefined, 1_000);
`,
      { encoding: "utf8", mode: 0o700 },
    );
    const connection = await StdioCodexAppServerConnection.connect({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      executablePath,
      requestTimeoutMs: 25,
    });

    const error = await connection.request("fixture/timeout", {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CodexAppServerRequestTimeoutError);
    expect(error).toMatchObject({ requestWasWritten: true });
    await connection.close();
  });

  it("routes typed requests through code-owned reviewers and fails closed", async () => {
    const approval = vi.fn(async () =>
      authorizedUserDecision({ decision: "decline" as const }),
    );
    const elicitation = vi.fn(async () =>
      authorizedUserDecision({
        action: "decline" as const,
        content: null,
        _meta: null,
      }),
    );
    const userInput = vi.fn(async () =>
      authorizedUserDecision({
        answers: { question: { answers: ["No"] } },
      }),
    );
    const { supervisor } = await fixtureSupervisor({
      requestHandlers: { approval, elicitation, userInput },
    });

    await expect(
      supervisor.requestRouter.route({
        id: 1,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          startedAtMs: 1,
        },
      }),
    ).resolves.toEqual({ result: { decision: "decline" } });
    await expect(
      supervisor.requestRouter.route({
        id: 2,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread",
          turnId: "turn",
          serverName: "fixture",
          mode: "form",
          message: "Choose whether to proceed.",
          _meta: null,
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    ).resolves.toEqual({
      result: { action: "decline", content: null, _meta: null },
    });
    await expect(
      supervisor.requestRouter.route({
        id: 3,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          questions: [
            {
              id: "question",
              header: "Confirm",
              question: "Proceed?",
              isOther: false,
              isSecret: false,
              options: [{ label: "No", description: "Do not proceed." }],
            },
          ],
          isBlocking: true,
          autoResolutionMs: null,
        },
      }),
    ).resolves.toEqual({
      result: { answers: { question: { answers: ["No"] } } },
    });
    await expect(
      supervisor.requestRouter.route({
        id: "unknown-1",
        method: "fixture/unknown",
        params: {},
      }),
    ).resolves.toEqual({
      error: {
        code: -32_601,
        message: "Unsupported Codex App Server request: fixture/unknown",
      },
    });
  });

  it("rejects an approval result without code-issued provenance", async () => {
    const { supervisor } = await fixtureSupervisor({
      requestHandlers: {
        approval: async () =>
          ({
            result: { decision: "accept" },
          }) as never,
      },
    });

    await expect(
      supervisor.requestRouter.route({
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          startedAtMs: 1,
          environmentId: null,
        },
      }),
    ).resolves.toEqual({
      error: {
        code: -32_000,
        message: "Server request decision failed validation.",
      },
    });
  });

  it("accepts every pinned approval request shape with an exact response", async () => {
    const approval = vi.fn(async (request: { method: string }) => {
      if (request.method === "item/permissions/requestApproval") {
        return authorizedUserDecision({
          permissions: {},
          scope: "turn" as const,
        }) as never;
      }
      if (
        request.method === "applyPatchApproval" ||
        request.method === "execCommandApproval"
      ) {
        return authorizedUserDecision({ decision: "abort" as const }) as never;
      }
      return authorizedUserDecision({ decision: "decline" as const }) as never;
    });
    const { supervisor } = await fixtureSupervisor({
      requestHandlers: { approval },
    });

    const requests = [
      {
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item-command",
          startedAtMs: 1,
          approvalId: null,
          environmentId: null,
          reason: null,
          networkApprovalContext: { host: "example.com", protocol: "https" },
          command: "pwd",
          cwd: "/tmp",
          commandActions: [{ type: "unknown", command: "pwd" }],
          proposedExecpolicyAmendment: ["prefix_rule(pattern=[\"pwd\"])"],
          proposedNetworkPolicyAmendments: [
            { host: "example.com", action: "allow" },
          ],
        },
      },
      {
        id: 2,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item-file",
          startedAtMs: 1,
          reason: null,
          grantRoot: null,
        },
      },
      {
        id: 3,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item-permissions",
          startedAtMs: 1,
          environmentId: null,
          cwd: "/tmp",
          reason: null,
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp"],
              write: null,
              entries: [
                {
                  path: { type: "special", value: { kind: "tmpdir" } },
                  access: "read",
                },
              ],
            },
          },
        },
      },
      {
        id: 4,
        method: "applyPatchApproval",
        params: {
          conversationId: "thread",
          callId: "call-patch",
          fileChanges: {
            "/tmp/file": { type: "add", content: "contents" },
          },
          reason: null,
          grantRoot: null,
        },
      },
      {
        id: 5,
        method: "execCommandApproval",
        params: {
          conversationId: "thread",
          callId: "call-command",
          approvalId: null,
          command: ["pwd"],
          cwd: "/tmp",
          reason: null,
          parsedCmd: [{ type: "unknown", cmd: "pwd" }],
        },
      },
    ];

    for (const request of requests) {
      await expect(
        supervisor.requestRouter.route(request),
      ).resolves.toHaveProperty("result");
    }
    expect(approval).toHaveBeenCalledTimes(requests.length);
  });

  it("rejects malformed method-specific requests before invoking handlers", async () => {
    const approval = vi.fn(async () =>
      authorizedUserDecision({ decision: "decline" as const }),
    );
    const elicitation = vi.fn(async () =>
      authorizedUserDecision({
        action: "decline" as const,
        content: null,
        _meta: null,
      }),
    );
    const userInput = vi.fn(async () =>
      authorizedUserDecision({ answers: {} }),
    );
    const { supervisor } = await fixtureSupervisor({
      requestHandlers: { approval, elicitation, userInput },
    });

    const malformedApprovalRequests = [
      {
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          startedAtMs: 1,
        },
      },
      {
        id: 2,
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread", turnId: "turn", itemId: "item" },
      },
      {
        id: 3,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          startedAtMs: 1,
          environmentId: null,
          cwd: "/tmp",
          reason: null,
        },
      },
      {
        id: 4,
        method: "applyPatchApproval",
        params: { conversationId: "thread", callId: "call" },
      },
      {
        id: 5,
        method: "execCommandApproval",
        params: { conversationId: "thread", callId: "call" },
      },
    ];
    for (const request of malformedApprovalRequests) {
      await expect(supervisor.requestRouter.route(request)).resolves.toEqual({
        error: { code: -32_000, message: "Approval request was malformed." },
      });
    }
    await expect(
      supervisor.requestRouter.route({
        id: 6,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread",
          turnId: "turn",
          serverName: "fixture",
          mode: "form",
          message: "Missing its schema.",
          _meta: null,
        },
      }),
    ).resolves.toEqual({
      error: { code: -32_000, message: "Elicitation request was malformed." },
    });
    await expect(
      supervisor.requestRouter.route({
        id: 7,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          isBlocking: true,
          autoResolutionMs: null,
        },
      }),
    ).resolves.toEqual({
      error: { code: -32_000, message: "User-input request was malformed." },
    });

    expect(approval).not.toHaveBeenCalled();
    expect(elicitation).not.toHaveBeenCalled();
    expect(userInput).not.toHaveBeenCalled();
  });

  it("rejects a code-issued response that is not exact JSON", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const { supervisor } = await fixtureSupervisor({
      requestHandlers: {
        elicitation: async () =>
          authorizedUserDecision({
            action: "accept",
            content: cyclic,
            _meta: null,
          }) as never,
      },
    });

    await expect(
      supervisor.requestRouter.route({
        id: 1,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread",
          turnId: "turn",
          serverName: "fixture",
          mode: "form",
          message: "Provide input.",
          _meta: null,
          requestedSchema: { type: "object", properties: {} },
        },
      }),
    ).resolves.toEqual({
      error: {
        code: -32_000,
        message: "Server request decision failed validation.",
      },
    });
  });

  it("returns an explicit fail-closed response to an unknown wire request", async () => {
    const { supervisor, codexHome } = await fixtureSupervisor();
    await supervisor.initialize();

    await supervisor.request("fixture/serverRequest", {
      serverRequestId: "unknown-wire-request",
      method: "fixture/unknown-wire-method",
      params: {},
    });

    await vi.waitFor(async () => {
      expect((await readFixtureState(codexHome)).serverResponses).toContainEqual({
        id: "unknown-wire-request",
        error: {
          code: -32_601,
          message:
            "Unsupported Codex App Server request: fixture/unknown-wire-method",
        },
      });
    });
  });
});
