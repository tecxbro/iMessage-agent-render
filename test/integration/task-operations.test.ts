import { resolve } from "node:path";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { executionResultSchema } from "../../src/agent/schemas.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { ChainAuthorizationRepository } from "../../src/db/repositories/chain-authorization.js";
import { OrchestrationCodec } from "../../src/db/repositories/orchestration-codec.js";
import { TaskExecutionRepository } from "../../src/db/repositories/task-execution.js";
import {
  TaskLifecycleError,
  TaskOperationsRepository,
} from "../../src/db/repositories/task-operations.js";
import {
  interactionAuthorizationReferences,
  interactionRuns,
} from "../../src/db/schema-fragments/conversation-actors.js";
import {
  chains,
  channelIdentities,
  deployments,
  executionTasks,
  owners,
  spaces,
} from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  deployment: "72000000-0000-4000-8000-000000000001",
  owner: "72000000-0000-4000-8000-000000000002",
  identity: "72000000-0000-4000-8000-000000000003",
  space: "72000000-0000-4000-8000-000000000004",
  run1: "72000000-0000-4000-8000-000000000005",
  run2: "72000000-0000-4000-8000-000000000006",
} as const;

const encryptFixture = (plaintext: string) =>
  `secure:${Buffer.from(plaintext, "utf8").toString("base64")}`;
const decryptFixture = (ciphertext: string) =>
  ciphertext.startsWith("secure:")
    ? Buffer.from(ciphertext.slice("secure:".length), "base64").toString(
        "utf8",
      )
    : ciphertext;

const task = (
  id: string,
  dependsOn: readonly string[] = [],
) => ({
  id,
  agentName: "reviewer",
  purpose: `Complete ${id}.`,
  instructions: `Original instructions for ${id}.`,
  workspaceBinding: "personal",
  permissionProfile: "read" as const,
  dependsOn: [...dependsOn],
});

describeDatabase("explicit task operations", () => {
  let client: DatabaseClient;
  let repository: TaskOperationsRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    repository = new TaskOperationsRepository(client.database, {
      encrypt: encryptFixture,
      decrypt: decryptFixture,
    });
  });

  beforeEach(async () => {
    await client.pool.query(
      "truncate table deployments restart identity cascade",
    );
    await client.database.insert(deployments).values({
      id: ids.deployment,
      name: "task-operations-integration",
      defaultModelProfile: "main",
    });
    await client.database.insert(owners).values({
      id: ids.owner,
      deploymentId: ids.deployment,
      timezone: "UTC",
    });
    await client.database.insert(channelIdentities).values({
      id: ids.identity,
      deploymentId: ids.deployment,
      ownerId: ids.owner,
      normalizedHandleCiphertext: "cipher:owner",
      handleFingerprint: "task-operations-owner",
      role: "owner",
      verifiedAt: new Date("2026-08-18T00:00:00Z"),
    });
    await client.database.insert(spaces).values({
      id: ids.space,
      deploymentId: ids.deployment,
      externalSpaceGuid: "task-operations-space",
      type: "dm",
      lastMessageAt: new Date("2026-08-18T00:00:00Z"),
    });
    await createRun(ids.run1, 1);
  });

  afterAll(async () => {
    await client?.close();
  });

  async function createRun(runId: string, generation: number): Promise<void> {
    await client.database.insert(interactionRuns).values({
      id: runId,
      spaceId: ids.space,
      generation,
      state: "active",
      threadId: `thread-${generation}`,
      turnId: `turn-${generation}`,
      startedThroughSequence: generation,
      acceptedThroughSequence: generation,
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
      promptVersion: "conversation-v1",
      promptSha256: "a".repeat(64),
    });
    await client.database.insert(interactionAuthorizationReferences).values({
      interactionRunId: runId,
      deploymentId: ids.deployment,
      ownerId: ids.owner,
      identityId: ids.identity,
      authorizationRevision: generation,
    });
  }

  it("creates a source-linked chain only for durable delegated work", async () => {
    await expect(
      repository.createDelegatedChain(ids.run1, []),
    ).rejects.toMatchObject({ code: "TASK_DELEGATION_EMPTY" });
    expect(await client.database.select().from(chains)).toHaveLength(0);

    const tasks = [task("inspect"), task("summarize", ["inspect"])];
    const created = await repository.createDelegatedChain(ids.run1, tasks);
    await client.database
      .update(interactionRuns)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(interactionRuns.id, ids.run1));
    const repeated = await repository.createDelegatedChain(ids.run1, tasks);

    expect(created).toMatchObject({
      created: true,
      chainVersion: 1,
      sourceInteractionRunId: ids.run1,
    });
    expect(created.rootTasks).toHaveLength(1);
    expect(repeated).toMatchObject({
      created: false,
      chainId: created.chainId,
    });
    expect(await client.database.select().from(chains)).toHaveLength(1);
    expect(await client.database.select().from(executionTasks)).toHaveLength(2);
    await expect(
      new ChainAuthorizationRepository(client.database).load(created.chainId),
    ).resolves.toMatchObject({
      chainId: created.chainId,
      principalIdentityId: ids.identity,
      contributorIdentityIds: [],
    });
  });

  it("cancels only the selected task and rejects a later successful result", async () => {
    const delegated = await repository.createDelegatedChain(ids.run1, [
      task("first"),
      task("second"),
    ]);
    const persisted = await client.database
      .select({ id: executionTasks.id, name: executionTasks.name })
      .from(executionTasks)
      .orderBy(asc(executionTasks.name));
    const first = persisted.find((row) => row.name === "first");
    const second = persisted.find((row) => row.name === "second");
    if (first === undefined || second === undefined) {
      throw new Error("task fixtures were not created");
    }
    await client.database
      .update(executionTasks)
      .set({ state: "running", startedAt: new Date() })
      .where(eq(executionTasks.id, first.id));
    await client.database
      .update(executionTasks)
      .set({ state: "running", startedAt: new Date() })
      .where(eq(executionTasks.id, second.id));

    await expect(
      repository.cancelTask(first.id, "The owner canceled only this task."),
    ).resolves.toMatchObject({ applied: true, state: "canceled" });
    const states = await client.database
      .select({ id: executionTasks.id, state: executionTasks.state })
      .from(executionTasks);
    expect(states.find((row) => row.id === first.id)?.state).toBe("canceled");
    expect(states.find((row) => row.id === second.id)?.state).toBe("running");

    const execution = new TaskExecutionRepository(
      client.database,
      {
        workspaceRoot: "/tmp/task-operations",
        interactionWorkingDirectory: "/tmp/interaction",
        encrypt: encryptFixture,
        decrypt: decryptFixture,
        capabilities: () => [],
      },
      new OrchestrationCodec(encryptFixture),
    );
    const completion = await execution.completeTask({
      payload: {
        taskId: first.id,
        chainId: delegated.chainId,
        expectedChainVersion: delegated.chainVersion,
        expectedState: "queued",
      },
      result: executionResultSchema.parse({
        taskId: "first",
        status: "succeeded",
        userSafeSummary: "This must not be published.",
        artifacts: [],
        proposedActions: [],
        memoryCandidates: [],
        error: null,
      }),
      promptSha256: "b".repeat(64),
      recovered: false,
    });
    expect(completion.accepted).toBe(false);
    const [stillCanceled] = await client.database
      .select({ state: executionTasks.state })
      .from(executionTasks)
      .where(eq(executionTasks.id, first.id));
    expect(stillCanceled?.state).toBe("canceled");
  });

  it("retains the previous instructions and creates a rewired task revision", async () => {
    await repository.createDelegatedChain(ids.run1, [
      task("inspect"),
      task("combine", ["inspect"]),
    ]);
    const before = await client.database
      .select({
        id: executionTasks.id,
        name: executionTasks.name,
        instructions: executionTasks.instructionsCiphertext,
      })
      .from(executionTasks);
    const inspect = before.find((row) => row.name === "inspect");
    if (inspect?.instructions === null || inspect === undefined) {
      throw new Error("inspect task fixture is missing");
    }

    const revision = await repository.reviseTask(
      inspect.id,
      "Revised instructions with a narrower scope.",
    );
    const rows = await client.database
      .select({
        id: executionTasks.id,
        name: executionTasks.name,
        state: executionTasks.state,
        instructions: executionTasks.instructionsCiphertext,
        dependencies: executionTasks.dependsOnJson,
      })
      .from(executionTasks);
    const previous = rows.find((row) => row.id === inspect.id);
    const revised = rows.find((row) => row.id === revision.revisedTaskId);
    const dependent = rows.find((row) => row.name === "combine");

    expect(rows).toHaveLength(3);
    expect(previous?.state).toBe("canceled");
    expect(decryptFixture(inspect.instructions)).toBe(
      "Original instructions for inspect.",
    );
    expect(revision).toMatchObject({ logicalTaskId: "inspect-r2", revision: 2 });
    const revisedInstructions =
      revised?.instructions === null
        ? null
        : decryptFixture(revised?.instructions ?? "");
    expect(revisedInstructions).toBe(
      "Revised instructions with a narrower scope.",
    );
    expect(dependent?.dependencies).toEqual([revision.revisedTaskId]);
  });

  it("checkpoints queued pauses and returns a typed error for running work", async () => {
    const delegated = await repository.createDelegatedChain(ids.run1, [
      task("queued"),
      task("running"),
    ]);
    const rows = await client.database
      .select({ id: executionTasks.id, name: executionTasks.name })
      .from(executionTasks);
    const queued = rows.find((row) => row.name === "queued");
    const running = rows.find((row) => row.name === "running");
    if (queued === undefined || running === undefined) {
      throw new Error("pause task fixtures were not created");
    }

    await expect(
      repository.pauseTask(queued.id, "Wait for explicit owner direction."),
    ).resolves.toMatchObject({ state: "paused", applied: true });
    const [paused] = await client.database
      .select({
        state: executionTasks.state,
        agentThreadId: executionTasks.agentThreadId,
        result: executionTasks.resultJson,
      })
      .from(executionTasks)
      .where(eq(executionTasks.id, queued.id));
    expect(paused).toMatchObject({ state: "queued", agentThreadId: null });
    expect(JSON.stringify(paused?.result)).not.toContain("owner direction");

    const execution = new TaskExecutionRepository(
      client.database,
      {
        workspaceRoot: "/tmp/task-operations",
        interactionWorkingDirectory: "/tmp/interaction",
        encrypt: encryptFixture,
        decrypt: decryptFixture,
        capabilities: () => [],
      },
      new OrchestrationCodec(encryptFixture),
    );
    await expect(
      execution.claimTask({
        taskId: queued.id,
        chainId: delegated.chainId,
        expectedChainVersion: delegated.chainVersion,
        expectedState: "queued",
      }),
    ).resolves.toBeNull();

    await client.database
      .update(executionTasks)
      .set({ state: "running", startedAt: new Date() })
      .where(eq(executionTasks.id, running.id));
    await expect(
      repository.pauseTask(running.id, "Pause active work."),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "TASK_PAUSE_UNSUPPORTED_WHILE_RUNNING",
      } satisfies Partial<TaskLifecycleError>),
    );
    const [stillRunning] = await client.database
      .select({ state: executionTasks.state })
      .from(executionTasks)
      .where(eq(executionTasks.id, running.id));
    expect(stillRunning?.state).toBe("running");
  });

  it("cancels only chains sourced from the selected interaction turn", async () => {
    await createRun(ids.run2, 2);
    const first = await repository.createDelegatedChain(ids.run1, [task("one")]);
    const second = await repository.createDelegatedChain(ids.run2, [task("two")]);

    await expect(
      repository.cancelInteractionTurn(ids.run1, "Stop this interaction."),
    ).resolves.toMatchObject({
      canceledChainCount: 1,
      canceledTaskCount: 1,
    });
    const chainRows = await client.database
      .select({ id: chains.id, state: chains.state })
      .from(chains);
    expect(chainRows.find((row) => row.id === first.chainId)?.state).toBe(
      "canceled",
    );
    expect(chainRows.find((row) => row.id === second.chainId)?.state).toBe(
      "executing",
    );
  });
});
