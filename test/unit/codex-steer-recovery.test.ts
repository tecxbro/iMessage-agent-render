import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerEventRouter } from "../../src/agent/codex-app-server/event-router.js";
import { CodexAppServerInteractionClient } from "../../src/agent/codex-app-server/interaction-client.js";
import {
  AbsentSteerReplacementCoordinator,
  type AbsentSteerReplacementKey,
  type AbsentSteerReplacementReservationStore,
  type AbsentSteerReplacementReserveResult,
  reconcileRunAfterRestart,
  recoverUncertainSteer,
  type SteerRecoveryResult,
} from "../../src/agent/codex-app-server/recovery.js";
import { CodexAppServerSupervisor } from "../../src/agent/codex-app-server/supervisor.js";

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
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

const textInput = (text: string) => ({
  type: "text" as const,
  text,
  text_elements: [],
});

class DurableFakeReplacementStore
  implements AbsentSteerReplacementReservationStore
{
  readonly #records = new Map<
    string,
    { state: "reserved" | "committed"; reservationId: string }
  >();
  #nextReservation = 1;

  public async reserve(
    key: AbsentSteerReplacementKey,
    _rangeFingerprint: string,
  ): Promise<AbsentSteerReplacementReserveResult> {
    const encodedKey = this.#encode(key);
    if (this.#records.has(encodedKey)) {
      return { state: "unavailable" };
    }
    const reservationId = `reservation-${this.#nextReservation++}`;
    this.#records.set(encodedKey, { state: "reserved", reservationId });
    return { state: "reserved", reservationId };
  }

  public async commit(
    key: AbsentSteerReplacementKey,
    reservationId: string,
  ): Promise<void> {
    const encodedKey = this.#encode(key);
    const record = this.#records.get(encodedKey);
    if (
      record?.state !== "reserved" ||
      record.reservationId !== reservationId
    ) {
      throw new Error("reservation is not owned");
    }
    this.#records.set(encodedKey, { state: "committed", reservationId });
  }

  public async release(
    key: AbsentSteerReplacementKey,
    reservationId: string,
  ): Promise<void> {
    const encodedKey = this.#encode(key);
    const record = this.#records.get(encodedKey);
    if (
      record?.state !== "reserved" ||
      record.reservationId !== reservationId
    ) {
      throw new Error("reservation is not owned");
    }
    this.#records.delete(encodedKey);
  }

  #encode(key: AbsentSteerReplacementKey): string {
    return JSON.stringify(key);
  }
}

const absentRecovery = (): Extract<
  SteerRecoveryResult,
  { state: "absent" }
> => ({
  state: "absent",
  threadId: "thread",
  expectedTurnId: "turn",
  clientUserMessageId: "absent-client-message",
});

async function fixtureSupervisor(): Promise<{
  supervisor: CodexAppServerSupervisor;
  codexHome: string;
}> {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-steer-recovery-"));
  temporaryDirectories.push(codexHome);
  await chmod(codexHome, 0o700);
  const supervisor = new CodexAppServerSupervisor({
    codexHome,
    parentEnvironment: { PATH: process.env["PATH"] },
    executablePath: fakeExecutable,
    requestTimeoutMs: 2_000,
  });
  supervisors.push(supervisor);
  await supervisor.initialize();
  return { supervisor, codexHome };
}

async function startFixtureTurn(supervisor: CodexAppServerSupervisor) {
  const { thread } = await supervisor.interactionClient.threadStart({});
  const { turn } = await supervisor.interactionClient.turnStart({
    threadId: thread.id,
    clientUserMessageId: "initial-message",
    input: [textInput("initial")],
  }, { expectedGeneration: supervisor.generation() });
  return { threadId: thread.id, turnId: turn.id };
}

describe("uncertain steer recovery", () => {
  it("discovers an accepted-but-unacknowledged steer in full history without retrying", async () => {
    const { supervisor, codexHome } = await fixtureSupervisor();
    const identifiers = await startFixtureTurn(supervisor);
    const submission = await supervisor.interactionClient.turnSteer({
      threadId: identifiers.threadId,
      expectedTurnId: identifiers.turnId,
      clientUserMessageId: "accepted-client-message",
      input: [textInput("fixture-accepted-steer")],
    }, { expectedGeneration: supervisor.generation() });
    expect(submission).toMatchObject({ state: "uncertain_submission" });
    if (submission.state !== "uncertain_submission") {
      throw new Error("fixture steer was unexpectedly acknowledged");
    }

    await expect(
      recoverUncertainSteer(supervisor.interactionClient, submission),
    ).resolves.toEqual({
      state: "accepted",
      threadId: identifiers.threadId,
      turnId: identifiers.turnId,
      clientUserMessageId: "accepted-client-message",
    });
    const state = JSON.parse(
      await readFile(
        join(codexHome, "fake-codex-app-server-state.json"),
        "utf8",
      ),
    ) as { requests: Array<{ method: string }> };
    expect(
      state.requests.filter((request) => request.method === "turn/steer"),
    ).toHaveLength(1);
    await expect(
      reconcileRunAfterRestart(supervisor.interactionClient, identifiers),
    ).resolves.toEqual({
      state: "orphaned_nonterminal",
      turnId: identifiers.turnId,
    });
  });

  it("reports conclusive absence and durably exposes the replacement range only once", async () => {
    const { supervisor } = await fixtureSupervisor();
    const identifiers = await startFixtureTurn(supervisor);
    const submission = await supervisor.interactionClient.turnSteer({
      threadId: identifiers.threadId,
      expectedTurnId: identifiers.turnId,
      clientUserMessageId: "absent-client-message",
      input: [textInput("fixture-absent-steer")],
    }, { expectedGeneration: supervisor.generation() });
    if (submission.state !== "uncertain_submission") {
      throw new Error("fixture steer was unexpectedly acknowledged");
    }
    const recovery = await recoverUncertainSteer(
      supervisor.interactionClient,
      submission,
    );
    expect(recovery).toEqual({
      state: "absent",
      threadId: identifiers.threadId,
      expectedTurnId: identifiers.turnId,
      clientUserMessageId: "absent-client-message",
    });

    const store = new DurableFakeReplacementStore();
    const firstActor = new AbsentSteerReplacementCoordinator(store);
    const range = [textInput("include this range")];
    const reservation = await firstActor.reserve(recovery, range);
    expect(reservation?.range).toEqual(range);
    if (reservation === undefined) {
      throw new Error("first actor unexpectedly failed to reserve replacement");
    }
    await reservation.commit();

    const restartedActor = new AbsentSteerReplacementCoordinator(store);
    await expect(
      restartedActor.reserve(recovery, range),
    ).resolves.toBeUndefined();
    await expect(
      restartedActor.reserve(recovery, [textInput("different reconstruction")]),
    ).resolves.toBeUndefined();
  });

  it("releases a pre-write failure so a replacement can be retried and committed", async () => {
    const store = new DurableFakeReplacementStore();
    const range = [textInput("retry this range")];
    const firstActor = new AbsentSteerReplacementCoordinator(store);
    const failedAttempt = await firstActor.reserve(absentRecovery(), range);
    expect(failedAttempt?.range).toEqual(range);
    if (failedAttempt === undefined) {
      throw new Error("first actor unexpectedly failed to reserve replacement");
    }

    const concurrentActor = new AbsentSteerReplacementCoordinator(store);
    await expect(
      concurrentActor.reserve(absentRecovery(), range),
    ).resolves.toBeUndefined();

    // The replacement turn was not written, so the actor releases its claim.
    await failedAttempt.release();

    const restartedActor = new AbsentSteerReplacementCoordinator(store);
    const retry = await restartedActor.reserve(absentRecovery(), range);
    expect(retry?.range).toEqual(range);
    if (retry === undefined) {
      throw new Error(
        "restarted actor unexpectedly failed to reserve replacement",
      );
    }
    await retry.commit();

    const laterActor = new AbsentSteerReplacementCoordinator(store);
    await expect(
      laterActor.reserve(absentRecovery(), range),
    ).resolves.toBeUndefined();
  });

  it("does not call partial history conclusive and orphans old nonterminal liveness", async () => {
    const eventRouter = new CodexAppServerEventRouter();
    eventRouter.setCurrentGeneration(2);
    const client = new CodexAppServerInteractionClient(
      {
        async request(method) {
          if (method !== "thread/read") throw new Error("unexpected method");
          return {
            thread: {
              id: "thread",
              turns: [
                {
                  id: "turn",
                  status: "inProgress",
                  items: [],
                  itemsView: "summary",
                  error: null,
                  startedAt: null,
                  completedAt: null,
                  durationMs: null,
                },
              ],
            },
          };
        },
        generation: () => 2,
      },
      eventRouter,
    );
    const submission = {
      state: "uncertain_submission" as const,
      threadId: "thread",
      expectedTurnId: "turn",
      clientUserMessageId: "client-message",
      generation: 1,
    };

    await expect(recoverUncertainSteer(client, submission)).resolves.toEqual({
      state: "still_uncertain",
      threadId: "thread",
      expectedTurnId: "turn",
      clientUserMessageId: "client-message",
    });
    await expect(
      reconcileRunAfterRestart(client, { threadId: "thread", turnId: "turn" }),
    ).resolves.toEqual({ state: "orphaned_nonterminal", turnId: "turn" });
  });

  it("reconciles a persisted terminal event through a real restart", async () => {
    const { supervisor } = await fixtureSupervisor();
    const identifiers = await startFixtureTurn(supervisor);
    await supervisor.interactionClient.turnInterrupt({
      threadId: identifiers.threadId,
      turnId: identifiers.turnId,
    }, { expectedGeneration: supervisor.generation() });
    const submission = await supervisor.interactionClient.turnSteer({
      threadId: identifiers.threadId,
      expectedTurnId: identifiers.turnId,
      clientUserMessageId: "terminal-restart-message",
      input: [textInput("fixture-absent-steer")],
    }, { expectedGeneration: supervisor.generation() });
    expect(submission.state).toBe("uncertain_submission");

    await expect(
      reconcileRunAfterRestart(supervisor.interactionClient, identifiers),
    ).resolves.toMatchObject({
      state: "terminal",
      turn: { id: identifiers.turnId, status: "interrupted" },
    });
  });
});
