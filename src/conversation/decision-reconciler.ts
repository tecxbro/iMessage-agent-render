import type {
  ConversationSnapshot,
  ConversationRepositoryPort,
  InteractionDeliveryPort,
  InteractionTaskPort,
} from "./contracts.js";
import type { DataCipher } from "../security/data-cipher.js";
import {
  INTERACTION_RUN_NONTERMINAL_STATES,
  type ConversationCasPrecondition,
  type ConversationStateRecord,
  type InteractionRunCasPrecondition,
  type InteractionRunMutationResult,
  type InteractionRunNonterminalState,
  type InteractionRunRecord,
} from "./state.js";

const nonterminalRunStates = new Set<InteractionRunRecord["state"]>(
  INTERACTION_RUN_NONTERMINAL_STATES,
);

export interface DecisionReconcilerOptions {
  repository: ConversationRepositoryPort;
  tasks: InteractionTaskPort;
  delivery: InteractionDeliveryPort;
  cipher: DataCipher;
  now?: () => Date;
}

export interface ReconcileDecisionInput {
  spaceId: string;
  interactionRunId: string;
  generation: number;
}

export type ReconcileDecisionResult =
  | {
      status: "completed";
      effect: "delivery" | "tasks" | "none";
      outboundBatchId?: string;
    }
  | {
      status: "continuation";
      draftOutputCiphertext: string;
      fromSequence: number;
      threadId: string | null;
    }
  | {
      status: "awaiting_tasks";
    }
  | {
      status: "synthesize_tasks";
      terminalResults: readonly import("../security/action-schema.js").JsonValue[];
    }
  | {
      status: "stale";
    };

type NonterminalInteractionRun = InteractionRunRecord & {
  state: InteractionRunNonterminalState;
};

export function conversationCasPrecondition(
  state: ConversationStateRecord,
): ConversationCasPrecondition {
  return {
    actorGeneration: state.actorGeneration,
    state: state.state,
    activeInteractionRunId: state.activeInteractionRunId,
    latestInputSequence: state.latestInputSequence,
    acceptedThroughSequence: state.acceptedThroughSequence,
    finalizedThroughSequence: state.finalizedThroughSequence,
  };
}

export function interactionRunCasPrecondition(
  run: InteractionRunRecord,
): InteractionRunCasPrecondition {
  if (!isNonterminalRun(run)) {
    throw new Error("A terminal interaction run cannot form a CAS precondition.");
  }
  return {
    interactionRunId: run.id,
    generation: run.generation,
    state: run.state,
    threadId: run.threadId,
    turnId: run.turnId,
    acceptedThroughSequence: run.acceptedThroughSequence,
  };
}

function isNonterminalRun(
  run: InteractionRunRecord,
): run is NonterminalInteractionRun {
  return nonterminalRunStates.has(run.state);
}

function isFencedFinalizingState(
  input: ReconcileDecisionInput,
  snapshot: ConversationSnapshot | null,
  run: InteractionRunRecord | null,
): run is NonterminalInteractionRun {
  return (
    snapshot !== null &&
    snapshot.activeRun !== null &&
    run !== null &&
    isNonterminalRun(run) &&
    snapshot.state.spaceId === input.spaceId &&
    run.spaceId === input.spaceId &&
    snapshot.state.actorGeneration === input.generation &&
    run.generation === input.generation &&
    snapshot.state.activeInteractionRunId === input.interactionRunId &&
    snapshot.activeRun.id === input.interactionRunId &&
    snapshot.activeRun.generation === input.generation &&
    snapshot.activeRun.state === "finalizing" &&
    run.id === input.interactionRunId &&
    snapshot.state.acceptedThroughSequence === run.acceptedThroughSequence &&
    snapshot.state.state === "finalizing" &&
    run.state === "finalizing"
  );
}

function decisionMode(
  metadata: Readonly<Record<string, unknown>>,
): "direct" | "delegate" | "confirm" | "silent" | null {
  const candidate = metadata["mode"] ?? metadata["route"];
  return candidate === "direct" ||
    candidate === "delegate" ||
    candidate === "confirm" ||
    candidate === "silent"
    ? candidate
    : null;
}

export class DecisionReconciler {
  readonly #repository: ConversationRepositoryPort;
  readonly #tasks: InteractionTaskPort;
  readonly #delivery: InteractionDeliveryPort;
  readonly #cipher: DataCipher;
  readonly #now: () => Date;

  public constructor(options: DecisionReconcilerOptions) {
    this.#repository = options.repository;
    this.#tasks = options.tasks;
    this.#delivery = options.delivery;
    this.#cipher = options.cipher;
    this.#now = options.now ?? (() => new Date());
  }

  /** Encrypt before the actor persists a runtime completion as finalizing. */
  public encryptDraftOutput(draftOutput: string): string {
    return this.#cipher.encrypt(draftOutput);
  }

  public async reconcile(
    input: ReconcileDecisionInput,
  ): Promise<ReconcileDecisionResult> {
    const { snapshot, run } = await this.#load(input);
    if (!isFencedFinalizingState(input, snapshot, run)) {
      return { status: "stale" };
    }
    if (snapshot === null) {
      throw new Error("The finalization fence accepted a missing conversation.");
    }

    if (snapshot.state.latestInputSequence > run.acceptedThroughSequence) {
      return await this.#continueAfterLateInput(input, snapshot, run);
    }

    return await this.#finalize(input, snapshot, run);
  }

  async #continueAfterLateInput(
    input: ReconcileDecisionInput,
    snapshot: ConversationSnapshot,
    run: NonterminalInteractionRun,
  ): Promise<ReconcileDecisionResult> {
    const draftOutputCiphertext =
      run.draftOutputCiphertext ?? this.#cipher.encrypt("");

    const result = await this.#repository.checkpointInteraction({
      spaceId: input.spaceId,
      expectedConversation: conversationCasPrecondition(snapshot.state),
      expectedRun: interactionRunCasPrecondition(run),
      nextRunState: "completed",
      nextConversation: {
        state: "recovering",
        activeInteractionRunId: null,
        acceptedThroughSequence: snapshot.state.acceptedThroughSequence,
        finalizedThroughSequence: snapshot.state.finalizedThroughSequence,
      },
      threadId: run.threadId,
      turnId: run.turnId,
      decisionMetadataJson: run.decisionMetadataJson,
      draftOutputCiphertext,
      terminalReason: null,
      lastObservedEventJson: run.lastObservedEventJson,
      completedAt: this.#now(),
    });

    if (!(await this.#mutationAppliedOrReload(input, result))) {
      return { status: "stale" };
    }

    return {
      status: "continuation",
      draftOutputCiphertext,
      fromSequence: run.acceptedThroughSequence + 1,
      threadId: run.threadId,
    };
  }

  async #finalize(
    input: ReconcileDecisionInput,
    snapshot: ConversationSnapshot,
    run: NonterminalInteractionRun,
  ): Promise<ReconcileDecisionResult> {
    const metadata = run.decisionMetadataJson;
    if (metadata === null) {
      throw new Error("A finalizing interaction run requires decision metadata.");
    }

    const mode = decisionMode(metadata);
    if (mode === null) {
      throw new Error("A finalizing interaction run requires a known decision mode.");
    }

    let effect: "delivery" | "tasks" | "none" = "none";
    let outboundBatchId: string | undefined;
    if (mode === "delegate") {
      const taskSnapshot = await this.#tasks.reconcile({
        interactionRunId: run.id,
        generation: run.generation,
      });
      if (
        taskSnapshot.pendingCount === 0 &&
        taskSnapshot.terminalResults.length === 0
      ) {
        await this.#tasks.dispatch({
          interactionRunId: run.id,
          generation: run.generation,
          decisionMetadataJson: metadata,
        });
        return { status: "awaiting_tasks" };
      }
      if (taskSnapshot.pendingCount > 0) {
        return { status: "awaiting_tasks" };
      }
      return {
        status: "synthesize_tasks",
        terminalResults: taskSnapshot.terminalResults,
      };
    } else if (mode !== "silent") {
      if (run.draftOutputCiphertext === null) {
        throw new Error(`${mode} finalization requires an encrypted draft.`);
      }
      const prepared = await this.#delivery.prepare({
        interactionRunId: run.id,
        spaceId: input.spaceId,
        generation: run.generation,
        draftOutput: this.#cipher.decrypt(run.draftOutputCiphertext),
      });
      outboundBatchId = prepared.outboundBatchId;
      effect = "delivery";
      // Batch materialization is the no-late-input completion fence and
      // atomically completes the run/cursor. Provider delivery is recovered
      // independently from the queued interaction-origin batch.
      return { status: "completed", effect, outboundBatchId };
    }

    const result = await this.#repository.checkpointInteraction({
      spaceId: input.spaceId,
      expectedConversation: conversationCasPrecondition(snapshot.state),
      expectedRun: interactionRunCasPrecondition(run),
      nextRunState: "completed",
      nextConversation: {
        state: "idle",
        activeInteractionRunId: null,
        acceptedThroughSequence: snapshot.state.acceptedThroughSequence,
        finalizedThroughSequence: run.acceptedThroughSequence,
      },
      threadId: run.threadId,
      turnId: run.turnId,
      decisionMetadataJson: metadata,
      draftOutputCiphertext: run.draftOutputCiphertext,
      terminalReason: null,
      lastObservedEventJson: run.lastObservedEventJson,
      completedAt: this.#now(),
    });

    if (!(await this.#mutationAppliedOrReload(input, result))) {
      return { status: "stale" };
    }

    return outboundBatchId === undefined
      ? { status: "completed", effect }
      : { status: "completed", effect, outboundBatchId };
  }

  async #mutationAppliedOrReload(
    input: ReconcileDecisionInput,
    result: InteractionRunMutationResult,
  ): Promise<boolean> {
    if (result.status === "applied") {
      return true;
    }
    await this.#load(input);
    return false;
  }

  async #load(input: ReconcileDecisionInput): Promise<{
    snapshot: ConversationSnapshot | null;
    run: InteractionRunRecord | null;
  }> {
    const [snapshot, run] = await Promise.all([
      this.#repository.loadConversation(input.spaceId),
      this.#repository.loadInteractionRun(input.interactionRunId),
    ]);
    return { snapshot, run };
  }
}
