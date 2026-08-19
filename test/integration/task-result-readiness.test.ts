import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { executionResultSchema } from "../../src/agent/schemas.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { TaskOperationsRepository } from "../../src/db/repositories/task-operations.js";
import { TaskResultReadinessRepository } from "../../src/db/repositories/task-result-readiness.js";
import {
  interactionAuthorizationReferences,
  interactionRuns,
} from "../../src/db/schema-fragments/conversation-actors.js";
import {
  channelIdentities,
  deployments,
  executionTasks,
  owners,
  spaces,
} from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  deployment: "73000000-0000-4000-8000-000000000001",
  owner: "73000000-0000-4000-8000-000000000002",
  identity: "73000000-0000-4000-8000-000000000003",
  space: "73000000-0000-4000-8000-000000000004",
  run1: "73000000-0000-4000-8000-000000000005",
  run2: "73000000-0000-4000-8000-000000000006",
} as const;

const encryptFixture = (plaintext: string) =>
  `secure:${Buffer.from(plaintext, "utf8").toString("base64")}`;
const decryptFixture = (ciphertext: string) =>
  Buffer.from(ciphertext.slice("secure:".length), "base64").toString("utf8");

const task = (id: string) => ({
  id,
  agentName: "reviewer",
  purpose: `Complete ${id}.`,
  instructions: `Return ${id} evidence.`,
  workspaceBinding: "personal",
  permissionProfile: "read" as const,
  dependsOn: [],
});

describeDatabase("task result readiness", () => {
  let client: DatabaseClient;
  let operations: TaskOperationsRepository;
  let readiness: TaskResultReadinessRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    operations = new TaskOperationsRepository(client.database, {
      encrypt: encryptFixture,
      decrypt: decryptFixture,
    });
    readiness = new TaskResultReadinessRepository(client.database, {
      decrypt: decryptFixture,
    });
  });

  beforeEach(async () => {
    await client.pool.query(
      "truncate table deployments restart identity cascade",
    );
    await client.database.insert(deployments).values({
      id: ids.deployment,
      name: "task-result-readiness-integration",
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
      handleFingerprint: "task-result-readiness-owner",
      role: "owner",
      verifiedAt: new Date("2026-08-18T00:00:00Z"),
    });
    await client.database.insert(spaces).values({
      id: ids.space,
      deploymentId: ids.deployment,
      externalSpaceGuid: "task-result-readiness-space",
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
      promptSha256: "c".repeat(64),
    });
    await client.database.insert(interactionAuthorizationReferences).values({
      interactionRunId: runId,
      deploymentId: ids.deployment,
      ownerId: ids.owner,
      identityId: ids.identity,
      authorizationRevision: generation,
    });
  }

  function storedResult(
    logicalTaskId: string,
    status: "succeeded" | "failed",
  ): Record<string, unknown> {
    const result = executionResultSchema.parse({
      taskId: logicalTaskId,
      status,
      userSafeSummary: `${logicalTaskId} ${status}.`,
      artifacts: [],
      proposedActions: [],
      memoryCandidates: [],
      error:
        status === "failed"
          ? {
              code: "FIXTURE_FAILURE",
              retryable: false,
              safeMessage: "The fixture failed safely.",
            }
          : null,
    });
    return { ciphertext: encryptFixture(JSON.stringify(result)) };
  }

  it("queries completed results by both space and source interaction run", async () => {
    await operations.createDelegatedChain(ids.run1, [task("first"), task("second")]);
    const rows = await client.database
      .select({ id: executionTasks.id, name: executionTasks.name })
      .from(executionTasks);
    const first = rows.find((row) => row.name === "first");
    const second = rows.find((row) => row.name === "second");
    if (first === undefined || second === undefined) {
      throw new Error("result readiness fixtures were not created");
    }
    await client.database
      .update(executionTasks)
      .set({
        state: "succeeded",
        resultJson: storedResult("first", "succeeded"),
        completedAt: new Date(),
      })
      .where(eq(executionTasks.id, first.id));

    await expect(
      readiness.loadTaskSnapshot(ids.space, ids.run1),
    ).resolves.toMatchObject({
      taskCount: 2,
      pendingCount: 1,
      resultReady: false,
      terminalResults: [{ taskId: "first", status: "succeeded" }],
    });
    await expect(
      readiness.loadCompletedTaskResults(
        "73000000-0000-4000-8000-000000000099",
        ids.run1,
      ),
    ).resolves.toEqual([]);

    await client.database
      .update(executionTasks)
      .set({
        state: "failed",
        resultJson: storedResult("second", "failed"),
        completedAt: new Date(),
      })
      .where(eq(executionTasks.id, second.id));
    const snapshot = await readiness.loadTaskSnapshot(ids.space, ids.run1);
    expect(snapshot).toMatchObject({
      pendingCount: 0,
      resultReady: true,
    });
    expect(snapshot.terminalResults.map((result) => result.status).sort()).toEqual([
      "failed",
      "succeeded",
    ]);
  });

  it("emits one minimal recoverable wake per ready space", async () => {
    await operations.createDelegatedChain(ids.run1, [task("first")]);
    await createRun(ids.run2, 2);
    await operations.createDelegatedChain(ids.run2, [task("second")]);
    const rows = await client.database
      .select({ id: executionTasks.id, name: executionTasks.name })
      .from(executionTasks);
    for (const row of rows) {
      await client.database
        .update(executionTasks)
        .set({
          state: "succeeded",
          resultJson: storedResult(row.name, "succeeded"),
          completedAt: new Date(),
        })
        .where(eq(executionTasks.id, row.id));
    }

    const firstScan = await readiness.findResultReadySignals();
    const recoveryScan = await readiness.findResultReadySignals();

    expect(firstScan).toEqual([
      { spaceId: ids.space, reason: "task_results_ready" },
    ]);
    expect(recoveryScan).toEqual(firstScan);
    expect(Object.keys(firstScan[0] ?? {})).toEqual(["spaceId", "reason"]);
  });

  it("does not signal while any task remains queued, running, or paused", async () => {
    await operations.createDelegatedChain(ids.run1, [task("first"), task("second")]);
    const rows = await client.database
      .select({ id: executionTasks.id, name: executionTasks.name })
      .from(executionTasks);
    const first = rows.find((row) => row.name === "first");
    const second = rows.find((row) => row.name === "second");
    if (first === undefined || second === undefined) {
      throw new Error("pending result fixtures were not created");
    }
    await client.database
      .update(executionTasks)
      .set({
        state: "succeeded",
        resultJson: storedResult("first", "succeeded"),
        completedAt: new Date(),
      })
      .where(eq(executionTasks.id, first.id));
    await operations.pauseTask(second.id, "Wait for owner direction.");

    await expect(readiness.findResultReadySignals()).resolves.toEqual([]);
    await expect(
      readiness.loadInteractionTaskSnapshot(ids.run1),
    ).resolves.toMatchObject({ pendingCount: 1 });
  });
});
