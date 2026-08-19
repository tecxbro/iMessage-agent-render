import { randomUUID } from "node:crypto";

import type {
  InteractionCoordinateReason,
} from "../queue/payloads.js";
import type {
  BeginInteractionInput,
  ConversationRepositoryPort,
  ConversationSnapshot,
  InteractionContext,
  InteractionContextLoaderPort,
  InteractionPresenceLease,
  InteractionPresencePort,
  InteractionRuntimeCompletion,
  InteractionRuntimePort,
  InteractionRuntimeSession,
  InteractionRuntimeSteerReceipt,
  InteractionStartGatePort,
} from "./contracts.js";
import { CoalescingMailbox } from "./coalescing-mailbox.js";
import type {
  ReconcileDecisionResult as DecisionReconciliationResult,
} from "./decision-reconciler.js";
import {
  DecisionReconciler,
  conversationCasPrecondition as conversationPrecondition,
  interactionRunCasPrecondition as runPrecondition,
} from "./decision-reconciler.js";
import { ConversationActorError } from "./errors.js";
import { InteractionSemaphore } from "./interaction-semaphore.js";
import {
  classifyInteractionRecovery,
} from "./recovery-policy.js";
import type {
  InteractionRunRecord,
  InteractionSteerRecord,
} from "./state.js";

export interface InteractionRunDefaults {
  modelId: string;
  reasoningEffort: string;
  promptVersion: string;
  promptSha256: string;
}

export interface ConversationActorOptions {
  spaceId: string;
  repository: ConversationRepositoryPort;
  runtime: InteractionRuntimePort;
  startGate: InteractionStartGatePort;
  presence: InteractionPresencePort;
  contextLoader: InteractionContextLoaderPort;
  interactionSemaphore: InteractionSemaphore;
  decisionReconciler: DecisionReconciler;
  runDefaults:
    | InteractionRunDefaults
    | (() => Promise<InteractionRunDefaults> | InteractionRunDefaults);
  createId?: () => string;
  now?: () => Date;
}

interface ContinuationDirective {
  draftOutputCiphertext: string;
  fromSequence: number;
  threadId: string | null;
}

type DriveResult = "continue" | "stop";

function isDelegatedDecision(
  metadata: InteractionRunRecord["decisionMetadataJson"],
): boolean {
  return metadata?.["mode"] === "delegate" || metadata?.["route"] === "delegate";
}

/**
 * One in-memory actor per Spectrum space. The mailbox only schedules work; all
 * decisions are made from repository snapshots loaded inside the actor loop.
 */
export class ConversationActor {
  readonly #mailbox = new CoalescingMailbox<InteractionCoordinateReason>();
  readonly #abortController = new AbortController();
  readonly #spaceId: string;
  readonly #repository: ConversationRepositoryPort;
  readonly #runtime: InteractionRuntimePort;
  readonly #startGate: InteractionStartGatePort;
  readonly #presence: InteractionPresencePort;
  readonly #contextLoader: InteractionContextLoaderPort;
  readonly #interactionSemaphore: InteractionSemaphore;
  readonly #decisionReconciler: DecisionReconciler;
  readonly #runDefaults: ConversationActorOptions["runDefaults"];
  readonly #createId: () => string;
  readonly #now: () => Date;

  #loopPromise: Promise<void> | null = null;
  #continuation: ContinuationDirective | null = null;
  #disposed = false;

  public constructor(options: ConversationActorOptions) {
    this.#spaceId = options.spaceId;
    this.#repository = options.repository;
    this.#runtime = options.runtime;
    this.#startGate = options.startGate;
    this.#presence = options.presence;
    this.#contextLoader = options.contextLoader;
    this.#interactionSemaphore = options.interactionSemaphore;
    this.#decisionReconciler = options.decisionReconciler;
    this.#runDefaults = options.runDefaults;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  public wake(reason: InteractionCoordinateReason): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(
        new DOMException("Conversation actor has been disposed.", "AbortError"),
      );
    }
    this.#mailbox.wake(reason);
    return this.#ensureLoop();
  }

  public get isIdle(): boolean {
    return this.#loopPromise === null && !this.#mailbox.hasPending;
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#abortController.abort(
      new DOMException("Conversation actor was disposed.", "AbortError"),
    );
  }

  #ensureLoop(): Promise<void> {
    if (this.#loopPromise !== null) {
      return this.#loopPromise;
    }
    const loop = this.#runLoop();
    const tracked = loop.finally(() => {
      if (this.#loopPromise === tracked) {
        this.#loopPromise = null;
      }
    });
    this.#loopPromise = tracked;
    return tracked;
  }

  async #runLoop(): Promise<void> {
    while (!this.#disposed) {
      this.#mailbox.drain();
      let snapshot = await this.#repository.loadConversation(this.#spaceId);
      if (snapshot === null) {
        await this.#repository.initializeConversation({ spaceId: this.#spaceId });
        snapshot = await this.#repository.loadConversation(this.#spaceId);
        if (snapshot === null) {
          throw new ConversationActorError("CONVERSATION_STATE_STALE", true);
        }
      }

      const result = await this.#drive(snapshot);
      if (result === "continue") {
        continue;
      }

      const quietVersion = this.#mailbox.version;
      await Promise.resolve();
      if (
        !this.#mailbox.hasPending &&
        this.#mailbox.version === quietVersion
      ) {
        return;
      }
    }
  }

  async #drive(snapshot: ConversationSnapshot): Promise<DriveResult> {
    const { state, activeRun } = snapshot;
    if (
      state.state === "idle" &&
      state.latestInputSequence === state.finalizedThroughSequence
    ) {
      return "stop";
    }

    if (state.state === "idle" || state.state === "recovering") {
      if (activeRun !== null || state.activeInteractionRunId !== null) {
        return this.#recover(snapshot);
      }
      return this.#startInteraction(snapshot);
    }

    if (state.state === "finalizing") {
      if (activeRun === null) {
        throw new ConversationActorError("INTERACTION_RUN_NOT_FOUND", true);
      }
      return this.#reconcileDecision(activeRun);
    }

    return this.#recover(snapshot);
  }

  async #startInteraction(
    initialSnapshot: ConversationSnapshot,
  ): Promise<DriveResult> {
    const initialState = initialSnapshot.state;
    if (initialState.state !== "idle" && initialState.state !== "recovering") {
      throw new ConversationActorError("CONVERSATION_STATE_STALE", true);
    }
    const initialActorState: "idle" | "recovering" = initialState.state;
    if (
      initialState.latestInputSequence === initialState.finalizedThroughSequence
    ) {
      return "stop";
    }

    const authorization = await this.#startGate.authorize({
      spaceId: this.#spaceId,
      throughSequence: initialState.latestInputSequence,
    });
    if (authorization === null) {
      return "stop";
    }

    const continuation = this.#continuation;
    const interactionRunId = this.#createId();
    let finalizingRun: InteractionRunRecord | null = null;
    let authorizationBlocked = false;

    await this.#interactionSemaphore.runExclusive(async () => {
      this.#abortController.signal.throwIfAborted();
      const refreshedAuthorization = await this.#startGate.authorize({
        spaceId: this.#spaceId,
        throughSequence: initialState.latestInputSequence,
      });
      if (refreshedAuthorization === null) {
        authorizationBlocked = true;
        return;
      }
      let presenceLease: InteractionPresenceLease | null = null;
      try {
        presenceLease = await this.#presence.start({
          spaceId: this.#spaceId,
          interactionRunId,
          signal: this.#abortController.signal,
        });

        const context = await this.#contextLoader.load({
          spaceId: this.#spaceId,
          interactionRunId,
          fromSequence:
            continuation?.fromSequence ??
            initialState.finalizedThroughSequence + 1,
          throughSequence: initialState.latestInputSequence,
        });
        const beginInput: BeginInteractionInput = {
          interactionRunId,
          spaceId: this.#spaceId,
          expectedConversation: {
            actorGeneration: initialState.actorGeneration,
            state: initialActorState,
            activeInteractionRunId: null,
            latestInputSequence: initialState.latestInputSequence,
            acceptedThroughSequence: initialState.acceptedThroughSequence,
            finalizedThroughSequence: initialState.finalizedThroughSequence,
          },
          ...(typeof this.#runDefaults === "function"
            ? await this.#runDefaults()
            : this.#runDefaults),
          authorization: refreshedAuthorization,
        };
        const begun = await this.#repository.beginInteraction(beginInput);
        if (begun.status !== "applied") {
          return;
        }

        let current = await this.#loadAuthoritativeRun(
          interactionRunId,
          begun.run.generation,
        );
        if (current === null) {
          return;
        }

        const persistedAuthorization =
          await this.#repository.loadAuthorizationReference(interactionRunId);
        if (
          persistedAuthorization === null ||
          !(await this.#startGate.revalidate(persistedAuthorization))
        ) {
          authorizationBlocked = true;
          await this.#repository.recoverInteraction({
            spaceId: this.#spaceId,
            expectedConversation: conversationPrecondition(current.state),
            expectedRun: runPrecondition(current.activeRun),
            terminalState: "interrupted",
            terminalReason: "authorization_revalidation_failed",
            recoveredAt: this.#now(),
          });
          return;
        }

        if (continuation !== null) {
          const persisted = await this.#repository.checkpointInteraction({
            spaceId: this.#spaceId,
            expectedConversation: conversationPrecondition(current.state),
            expectedRun: runPrecondition(current.activeRun),
            nextRunState: "starting",
            nextConversation: {
              state: "starting",
              activeInteractionRunId: interactionRunId,
              acceptedThroughSequence:
                current.activeRun.acceptedThroughSequence,
              finalizedThroughSequence:
                current.state.finalizedThroughSequence,
            },
            draftOutputCiphertext: continuation.draftOutputCiphertext,
            threadId: continuation.threadId,
          });
          if (persisted.status !== "applied") {
            return;
          }
          current = await this.#loadAuthoritativeRun(
            interactionRunId,
            begun.run.generation,
          );
          if (current === null) {
            return;
          }
        }

        const session = continuation === null
          ? await this.#runtime.start({
              run: current.activeRun,
              context,
              signal: this.#abortController.signal,
            })
          : await this.#runtime.resume({
              run: current.activeRun,
              context,
              signal: this.#abortController.signal,
            });
        if (continuation !== null) {
          this.#continuation = null;
        }

        current = await this.#loadAuthoritativeRun(
          interactionRunId,
          begun.run.generation,
        );
        if (current === null || current.activeRun.state !== "starting") {
          await this.#runtime.cancel({ interactionRunId, session });
          return;
        }
        const activated = await this.#repository.checkpointInteraction({
          spaceId: this.#spaceId,
          expectedConversation: conversationPrecondition(current.state),
          expectedRun: runPrecondition(current.activeRun),
          nextRunState: "active",
          nextConversation: {
            state: "active",
            activeInteractionRunId: interactionRunId,
            acceptedThroughSequence: current.activeRun.acceptedThroughSequence,
            finalizedThroughSequence: current.state.finalizedThroughSequence,
          },
          threadId: session.threadId,
          turnId: session.turnId,
        });
        if (activated.status !== "applied") {
          await this.#runtime.cancel({ interactionRunId, session });
          return;
        }

        const completion = await this.#runActive(
          interactionRunId,
          begun.run.generation,
          session,
        );
        if (completion === null) {
          return;
        }
        finalizingRun = await this.#checkpointCompletion(
          interactionRunId,
          begun.run.generation,
          completion,
        );
      } finally {
        await presenceLease?.stop();
      }
    }, this.#abortController.signal);

    if (authorizationBlocked) {
      return "stop";
    }
    if (finalizingRun === null) {
      return "continue";
    }
    return this.#reconcileDecision(finalizingRun);
  }

  async #runActive(
    interactionRunId: string,
    generation: number,
    session: InteractionRuntimeSession,
  ): Promise<InteractionRuntimeCompletion | null> {
    const completionController = new AbortController();
    const relayAbort = () =>
      completionController.abort(this.#abortController.signal.reason);
    this.#abortController.signal.addEventListener("abort", relayAbort, {
      once: true,
    });
    const completion = this.#runtime.waitForCompletion({
      interactionRunId,
      session,
      signal: completionController.signal,
    });
    void completion.catch(() => undefined);

    try {
      while (true) {
        this.#mailbox.drain();
        const run = await this.#submitOutstandingSteer(
          interactionRunId,
          generation,
          session,
        );
        if (run === null) {
          return null;
        }

        const caughtUp = await this.#loadAuthoritativeRun(
          interactionRunId,
          generation,
        );
        if (caughtUp === null) {
          return null;
        }
        if (
          caughtUp.state.latestInputSequence >
            caughtUp.activeRun.acceptedThroughSequence ||
          this.#mailbox.hasPending
        ) {
          continue;
        }

        const observedVersion = this.#mailbox.version;
        const changeController = new AbortController();
        const relayChangeAbort = () =>
          changeController.abort(this.#abortController.signal.reason);
        this.#abortController.signal.addEventListener("abort", relayChangeAbort, {
          once: true,
        });
        try {
          const outcome = await Promise.race([
            completion.then((value) => ({ kind: "completion" as const, value })),
            this.#mailbox
              .waitForChange(observedVersion, changeController.signal)
              .then(() => ({ kind: "wake" as const })),
          ]);
          if (outcome.kind === "completion") {
            changeController.abort();
            return outcome.value;
          }
        } finally {
          this.#abortController.signal.removeEventListener(
            "abort",
            relayChangeAbort,
          );
        }
      }
    } finally {
      completionController.abort();
      this.#abortController.signal.removeEventListener("abort", relayAbort);
    }
  }

  async #submitOutstandingSteer(
    interactionRunId: string,
    generation: number,
    session: InteractionRuntimeSession,
  ): Promise<InteractionRunRecord | null> {
    const snapshot = await this.#loadAuthoritativeRun(
      interactionRunId,
      generation,
    );
    if (snapshot === null) {
      return null;
    }
    const run = snapshot.activeRun;
    if (snapshot.state.latestInputSequence <= run.acceptedThroughSequence) {
      return run;
    }

    const fromSequence = run.acceptedThroughSequence + 1;
    const throughSequence = snapshot.state.latestInputSequence;
    const context = await this.#contextLoader.load({
      spaceId: this.#spaceId,
      interactionRunId,
      fromSequence,
      throughSequence,
    });
    this.#assertContiguous(context, fromSequence, throughSequence);
    const clientUserMessageId = context.messages.at(-1)?.messageId;
    if (clientUserMessageId === undefined) {
      throw new ConversationActorError("INTERACTION_STEER_REJECTED", false);
    }

    const created = await this.#repository.createSteer({
      id: this.#createId(),
      spaceId: this.#spaceId,
      expectedConversation: conversationPrecondition(snapshot.state),
      expectedRun: runPrecondition(run),
      clientUserMessageId,
      fromSequence,
      throughSequence,
      expectedTurnId: session.turnId,
      submissionGeneration: generation,
    });
    if (created.status !== "applied") {
      if (
        created.status === "precondition_failed" &&
        created.reason === "conversation_precondition"
      ) {
        return await this.#submitOutstandingSteer(
          interactionRunId,
          generation,
          session,
        );
      }
      return null;
    }

    const claimed = await this.#claimPendingSteer(
      interactionRunId,
      generation,
    );
    if (claimed === null) {
      return null;
    }

    let receipt: InteractionRuntimeSteerReceipt;
    try {
      receipt = await this.#runtime.steer({
        interactionRunId,
        threadId: session.threadId,
        expectedTurnId: claimed.expectedTurnId,
        clientUserMessageId: claimed.clientUserMessageId,
        submissionGeneration: claimed.submissionGeneration,
        messages: context.messages,
        signal: this.#abortController.signal,
      });
    } catch (error) {
      await this.#interruptUncertainRun(
        interactionRunId,
        generation,
        "uncertain_steer_submission",
      );
      throw error;
    }

    if (!(await this.#acceptSubmittedSteer(claimed, receipt.acceptedAt))) {
      return null;
    }
    return this.#advanceAcceptedCursor(
      interactionRunId,
      generation,
      claimed.throughSequence,
      receipt.turnId,
      receipt.lastObservedEventJson,
    );
  }

  async #interruptUncertainRun(
    interactionRunId: string,
    generation: number,
    terminalReason: string,
  ): Promise<void> {
    while (true) {
      const snapshot = await this.#loadAuthoritativeRun(
        interactionRunId,
        generation,
      );
      if (snapshot === null) {
        return;
      }
      const recovered = await this.#repository.recoverInteraction({
        spaceId: this.#spaceId,
        expectedConversation: conversationPrecondition(snapshot.state),
        expectedRun: runPrecondition(snapshot.activeRun),
        terminalState: "interrupted",
        terminalReason,
        recoveredAt: this.#now(),
      });
      if (recovered.status === "applied" || recovered.status === "stale_generation") {
        return;
      }
      if (recovered.reason !== "conversation_precondition") {
        return;
      }
    }
  }

  async #claimPendingSteer(
    interactionRunId: string,
    generation: number,
  ): Promise<InteractionSteerRecord | null> {
    while (true) {
      const snapshot = await this.#loadAuthoritativeRun(
        interactionRunId,
        generation,
      );
      if (snapshot === null) {
        return null;
      }
      const claimed = await this.#repository.claimPendingSteer({
        spaceId: this.#spaceId,
        expectedConversation: conversationPrecondition(snapshot.state),
        expectedRun: runPrecondition(snapshot.activeRun),
      });
      if (claimed.status === "claimed") {
        return claimed.steer;
      }
      if (
        claimed.status !== "precondition_failed" ||
        claimed.reason !== "conversation_precondition"
      ) {
        return null;
      }
    }
  }

  async #acceptSubmittedSteer(
    steer: InteractionSteerRecord,
    acceptedAt: Date,
  ): Promise<boolean> {
    while (true) {
      const snapshot = await this.#loadAuthoritativeRun(
        steer.interactionRunId,
        steer.generation,
      );
      if (snapshot === null) {
        return false;
      }
      const result = await this.#repository.checkpointSteer({
        spaceId: this.#spaceId,
        expectedConversation: conversationPrecondition(snapshot.state),
        expectedRun: runPrecondition(snapshot.activeRun),
        expectedSteer: {
          interactionSteerId: steer.id,
          state: "submitting",
          expectedTurnId: steer.expectedTurnId,
          submissionGeneration: steer.submissionGeneration,
        },
        nextState: "accepted",
        acceptedAt,
      });
      if (result.status === "applied") {
        return true;
      }
      if (
        result.status === "stale_generation" ||
        result.reason !== "conversation_precondition"
      ) {
        return false;
      }
    }
  }

  async #advanceAcceptedCursor(
    interactionRunId: string,
    generation: number,
    acceptedThroughSequence: number,
    turnId: string,
    lastObservedEventJson: InteractionRuntimeCompletion["lastObservedEventJson"],
  ): Promise<InteractionRunRecord | null> {
    while (true) {
      const snapshot = await this.#loadAuthoritativeRun(
        interactionRunId,
        generation,
      );
      if (snapshot === null) {
        return null;
      }
      if (
        snapshot.activeRun.acceptedThroughSequence >= acceptedThroughSequence
      ) {
        return snapshot.activeRun;
      }
      const result = await this.#repository.checkpointInteraction({
        spaceId: this.#spaceId,
        expectedConversation: conversationPrecondition(snapshot.state),
        expectedRun: runPrecondition(snapshot.activeRun),
        nextRunState: "active",
        nextConversation: {
          state: "active",
          activeInteractionRunId: interactionRunId,
          acceptedThroughSequence,
          finalizedThroughSequence: snapshot.state.finalizedThroughSequence,
        },
        turnId,
        lastObservedEventJson,
      });
      if (result.status === "applied") {
        return result.run;
      }
      if (
        result.status === "stale_generation" ||
        result.reason !== "conversation_precondition"
      ) {
        return null;
      }
    }
  }

  async #checkpointCompletion(
    interactionRunId: string,
    generation: number,
    completion: InteractionRuntimeCompletion,
  ): Promise<InteractionRunRecord | null> {
    const snapshot = await this.#loadAuthoritativeRun(
      interactionRunId,
      generation,
    );
    if (snapshot === null || snapshot.activeRun.state !== "active") {
      return null;
    }
    const result = await this.#repository.checkpointInteraction({
      spaceId: this.#spaceId,
      expectedConversation: conversationPrecondition(snapshot.state),
      expectedRun: runPrecondition(snapshot.activeRun),
      nextRunState: "finalizing",
      nextConversation: {
        state: "finalizing",
        activeInteractionRunId: interactionRunId,
        acceptedThroughSequence: snapshot.activeRun.acceptedThroughSequence,
        finalizedThroughSequence: snapshot.state.finalizedThroughSequence,
      },
      threadId: completion.threadId,
      turnId: completion.turnId,
      decisionMetadataJson: completion.decisionMetadataJson,
      draftOutputCiphertext:
        completion.draftOutput === null
          ? null
          : this.#decisionReconciler.encryptDraftOutput(completion.draftOutput),
      lastObservedEventJson: completion.lastObservedEventJson,
    });
    return result.status === "applied" ? result.run : null;
  }

  async #reconcileDecision(run: InteractionRunRecord): Promise<DriveResult> {
    const result: DecisionReconciliationResult =
      await this.#decisionReconciler.reconcile({
        spaceId: this.#spaceId,
        interactionRunId: run.id,
        generation: run.generation,
      });
    if (result.status === "continuation") {
      this.#continuation = {
        draftOutputCiphertext: result.draftOutputCiphertext,
        fromSequence: result.fromSequence,
        threadId: result.threadId,
      };
      return "continue";
    }
    if (result.status === "synthesize_tasks") {
      return await this.#synthesizeTaskResults(run, result.terminalResults);
    }
    if (result.status === "awaiting_tasks") {
      return "stop";
    }
    if (result.status === "completed" && result.effect === "delivery") {
      return "stop";
    }
    return "continue";
  }

  async #synthesizeTaskResults(
    run: InteractionRunRecord,
    taskResults: readonly InteractionContext["taskResults"][number][],
  ): Promise<DriveResult> {
    const snapshot = await this.#loadAuthoritativeRun(run.id, run.generation);
    if (snapshot === null || snapshot.activeRun.state !== "finalizing") {
      return "continue";
    }
    const reactivated = await this.#repository.checkpointInteraction({
      spaceId: this.#spaceId,
      expectedConversation: conversationPrecondition(snapshot.state),
      expectedRun: runPrecondition(snapshot.activeRun),
      nextRunState: "active",
      nextConversation: {
        state: "active",
        activeInteractionRunId: run.id,
        acceptedThroughSequence: run.acceptedThroughSequence,
        finalizedThroughSequence: snapshot.state.finalizedThroughSequence,
      },
    });
    if (reactivated.status !== "applied") {
      return "continue";
    }

    let finalizingRun: InteractionRunRecord | null = null;
    await this.#interactionSemaphore.runExclusive(async () => {
      let presenceLease: InteractionPresenceLease | null = null;
      try {
        presenceLease = await this.#presence.start({
          spaceId: this.#spaceId,
          interactionRunId: run.id,
          signal: this.#abortController.signal,
        });
        const context = await this.#contextLoader.load({
          spaceId: this.#spaceId,
          interactionRunId: run.id,
          fromSequence: snapshot.state.finalizedThroughSequence + 1,
          throughSequence: run.acceptedThroughSequence,
        });
        const session = await this.#runtime.resume({
          run: reactivated.run,
          context: { ...context, taskResults },
          signal: this.#abortController.signal,
        });
        const current = await this.#loadAuthoritativeRun(run.id, run.generation);
        if (current === null || current.activeRun.state !== "active") {
          await this.#runtime.cancel({ interactionRunId: run.id, session });
          return;
        }
        const identified = await this.#repository.checkpointInteraction({
          spaceId: this.#spaceId,
          expectedConversation: conversationPrecondition(current.state),
          expectedRun: runPrecondition(current.activeRun),
          nextRunState: "active",
          nextConversation: {
            state: "active",
            activeInteractionRunId: run.id,
            acceptedThroughSequence: current.activeRun.acceptedThroughSequence,
            finalizedThroughSequence: current.state.finalizedThroughSequence,
          },
          threadId: session.threadId,
          turnId: session.turnId,
        });
        if (identified.status !== "applied") {
          await this.#runtime.cancel({ interactionRunId: run.id, session });
          return;
        }
        const completion = await this.#runActive(run.id, run.generation, session);
        if (completion !== null) {
          finalizingRun = await this.#checkpointCompletion(
            run.id,
            run.generation,
            completion,
          );
        }
      } finally {
        await presenceLease?.stop();
      }
    }, this.#abortController.signal);
    return finalizingRun === null
      ? "continue"
      : await this.#reconcileDecision(finalizingRun);
  }

  async #recover(snapshot: ConversationSnapshot): Promise<DriveResult> {
    if (snapshot.activeRun === null) {
      throw new ConversationActorError("INTERACTION_RUN_NOT_FOUND", true);
    }
    const activeRun = snapshot.activeRun;
    if (activeRun.state === "active" && isDelegatedDecision(activeRun.decisionMetadataJson)) {
      // A crash can occur after task-result synthesis reactivates the source
      // run but before the new App Server turn is durably identified. Restore
      // the finalizing checkpoint so reconciliation reloads the durable task
      // results instead of resuming without them.
      const restored = await this.#repository.checkpointInteraction({
        spaceId: this.#spaceId,
        expectedConversation: conversationPrecondition(snapshot.state),
        expectedRun: runPrecondition(activeRun),
        nextRunState: "finalizing",
        nextConversation: {
          state: "finalizing",
          activeInteractionRunId: activeRun.id,
          acceptedThroughSequence: activeRun.acceptedThroughSequence,
          finalizedThroughSequence: snapshot.state.finalizedThroughSequence,
        },
      });
      return restored.status === "applied"
        ? await this.#reconcileDecision(restored.run)
        : "continue";
    }
    const plan = classifyInteractionRecovery({
      conversation: snapshot.state,
      run: activeRun,
      sessionAvailable:
        activeRun.threadId !== null && activeRun.turnId !== null,
    });
    if (plan.action === "none") {
      throw new ConversationActorError("CONVERSATION_STATE_STALE", true);
    }

    if (plan.action === "resume") {
      const authorization = await this.#repository.loadAuthorizationReference(
        activeRun.id,
      );
      if (
        authorization === null ||
        !(await this.#startGate.revalidate(authorization))
      ) {
        await this.#interruptUncertainRun(
          activeRun.id,
          activeRun.generation,
          "authorization_revalidation_failed",
        );
        return "continue";
      }

      let authorizationRevokedWhileQueued = false;
      const completion = await this.#interactionSemaphore.runExclusive(
        async (): Promise<InteractionRuntimeCompletion | null> => {
          if (!(await this.#startGate.revalidate(authorization))) {
            authorizationRevokedWhileQueued = true;
            return null;
          }
          let presenceLease: InteractionPresenceLease | null = null;
          try {
            presenceLease = await this.#presence.start({
              spaceId: this.#spaceId,
              interactionRunId: activeRun.id,
              signal: this.#abortController.signal,
            });
            const context = await this.#contextLoader.load({
              spaceId: this.#spaceId,
              interactionRunId: activeRun.id,
              fromSequence: snapshot.state.finalizedThroughSequence + 1,
              throughSequence: activeRun.acceptedThroughSequence,
            });
            const session = await this.#runtime.resume({
              run: activeRun,
              context,
              signal: this.#abortController.signal,
            });
            if (activeRun.state === "starting") {
              const starting = await this.#loadAuthoritativeRun(
                activeRun.id,
                activeRun.generation,
              );
              if (starting === null || starting.activeRun.state !== "starting") {
                return null;
              }
              const activated = await this.#repository.checkpointInteraction({
                spaceId: this.#spaceId,
                expectedConversation: conversationPrecondition(starting.state),
                expectedRun: runPrecondition(starting.activeRun),
                nextRunState: "active",
                nextConversation: {
                  state: "active",
                  activeInteractionRunId: activeRun.id,
                  acceptedThroughSequence:
                    starting.activeRun.acceptedThroughSequence,
                  finalizedThroughSequence:
                    starting.state.finalizedThroughSequence,
                },
                threadId: session.threadId,
                turnId: session.turnId,
              });
              if (activated.status !== "applied") {
                return null;
              }
            }
            return await this.#runActive(
              activeRun.id,
              activeRun.generation,
              session,
            );
          } finally {
            await presenceLease?.stop();
          }
        },
        this.#abortController.signal,
      );

      if (authorizationRevokedWhileQueued) {
        await this.#interruptUncertainRun(
          activeRun.id,
          activeRun.generation,
          "authorization_revalidation_failed",
        );
        return "continue";
      }
      if (completion === null) {
        return "continue";
      }

      const finalizing = await this.#checkpointCompletion(
        activeRun.id,
        activeRun.generation,
        completion,
      );
      return finalizing === null
        ? "continue"
        : this.#reconcileDecision(finalizing);
    }

    const current = await this.#repository.loadConversation(this.#spaceId);
    if (current === null || current.activeRun === null) {
      return "continue";
    }
    const recovery = classifyInteractionRecovery({
      conversation: current.state,
      run: current.activeRun,
      sessionAvailable:
        current.activeRun.threadId !== null && current.activeRun.turnId !== null,
    });
    if (recovery.action !== "terminalize") {
      return "continue";
    }
    const recovered = await this.#repository.recoverInteraction({
      spaceId: this.#spaceId,
      expectedConversation: conversationPrecondition(current.state),
      expectedRun: runPrecondition(current.activeRun),
      terminalState: recovery.terminalState,
      terminalReason: recovery.terminalReason,
      recoveredAt: this.#now(),
    });
    if (recovered.status !== "applied") {
      await this.#repository.loadConversation(this.#spaceId);
    }
    return "continue";
  }

  async #loadAuthoritativeRun(
    interactionRunId: string,
    generation: number,
  ): Promise<(ConversationSnapshot & { activeRun: InteractionRunRecord }) | null> {
    const snapshot = await this.#repository.loadConversation(this.#spaceId);
    if (
      snapshot === null ||
      snapshot.activeRun === null ||
      snapshot.state.activeInteractionRunId !== interactionRunId ||
      snapshot.activeRun.id !== interactionRunId ||
      snapshot.state.actorGeneration !== generation ||
      snapshot.activeRun.generation !== generation
    ) {
      return null;
    }
    return snapshot as ConversationSnapshot & { activeRun: InteractionRunRecord };
  }

  #assertContiguous(
    context: InteractionContext,
    fromSequence: number,
    throughSequence: number,
  ): void {
    const expectedCount = throughSequence - fromSequence + 1;
    if (context.messages.length !== expectedCount) {
      throw new ConversationActorError("INTERACTION_STEER_REJECTED", false);
    }
    for (const [index, message] of context.messages.entries()) {
      if (message.inputSequence !== fromSequence + index) {
        throw new ConversationActorError("INTERACTION_STEER_REJECTED", false);
      }
    }
  }
}
