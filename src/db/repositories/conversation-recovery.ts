import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type {
  BeginInteractionInput,
  ConversationRepositoryPort,
  CreateInteractionSteerInput,
  EncryptedConversationInput,
  InteractionRunCheckpoint,
  InteractionSteerCheckpoint,
  RecoverInteractionInput,
} from "../../conversation/contracts.js";
import {
  conversationInputIngestResultSchema,
  conversationStateRecordSchema,
  interactionRunRecordSchema,
  interactionSteerRecordSchema,
  type ConversationInitializationResult,
  type ConversationInputIngestResult,
  type InteractionAuthorizationReference,
  type InteractionRunCasPrecondition,
  type InteractionRunMutationResult,
  type InteractionRunRecord,
  type InteractionSteerClaimResult,
  type InteractionSteerMutationResult,
  type InteractionSteerRecord,
} from "../../conversation/state.js";
import type { Database } from "../client.js";
import {
  conversationStates,
  interactionRuns,
  interactionSteers,
} from "../schema-fragments/conversation-actors.js";
import { messages } from "../schema.js";
import {
  conversationStateSelection,
  ConversationStateRepository,
  type ConversationStateMutationResult,
  type IncrementActorGenerationInput,
} from "./conversation-state.js";
import {
  InteractionAuthorizationRepository,
} from "./interaction-authorization.js";
import {
  InteractionRunRepository,
  interactionRunSelection,
  type FinalizeRunInput,
  type MarkRunActiveInput,
  type RecordTurnIdentityInput,
  type StoreTerminalDecisionInput,
  type StoreUndeliveredDraftInput,
} from "./interaction-runs.js";
import {
  InteractionSteerRepository,
  interactionSteerSelection,
  type BeginSteerSubmissionInput,
  type MarkSteerAcceptedInput,
} from "./interaction-steers.js";
import { SequencedInboundRepository } from "./sequenced-inbound.js";

export interface SequencedInboundMessageRecord {
  messageId: string;
  spaceId: string;
  inputSequence: number;
  senderIdentityId: string | null;
  contentCiphertext: string | null;
  contentHash: string;
  receivedAt: Date;
  retentionExpiresAt: Date;
}

export interface UnfinalizedConversationQuery {
  limit?: number;
  afterSpaceId?: string;
}

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Recovery query limit must be an integer from 1 through 1000.");
  }
  return limit;
}

function sequenceRange(fromSequence: number, throughSequence: number): void {
  if (
    !Number.isSafeInteger(fromSequence) ||
    !Number.isSafeInteger(throughSequence) ||
    fromSequence < 0 ||
    fromSequence > throughSequence
  ) {
    throw new Error(
      "Conversation sequence range is invalid. Use an inclusive nonnegative range before retrying recovery.",
    );
  }
}

export class ConversationRecoveryRepository {
  public constructor(private readonly database: Database) {}

  /**
   * Observe/cutover recovery query. Unlike the broader actor-repair query
   * below, this selects only explicit cursor lag and supports keyset paging so
   * an observer that never advances finalized state can still scan all spaces.
   */
  public async findSpacesWithUnfinalizedInput(
    input: UnfinalizedConversationQuery = {},
  ): Promise<string[]> {
    const cursorBehind = gt(
      conversationStates.latestInputSequence,
      conversationStates.finalizedThroughSequence,
    );
    const rows = await this.database
      .select({ spaceId: conversationStates.spaceId })
      .from(conversationStates)
      .where(
        input.afterSpaceId === undefined
          ? cursorBehind
          : and(
              cursorBehind,
              gt(conversationStates.spaceId, input.afterSpaceId),
            ),
      )
      .orderBy(asc(conversationStates.spaceId))
      .limit(boundedLimit(input.limit ?? 100));
    return rows.map((row) => row.spaceId);
  }

  public async findSpacesBehindCursor(limit = 100): Promise<string[]> {
    const rows = await this.database
      .select({ spaceId: conversationStates.spaceId })
      .from(conversationStates)
      .where(
        or(
          gt(
            conversationStates.latestInputSequence,
            conversationStates.finalizedThroughSequence,
          ),
          and(
            eq(conversationStates.actorGeneration, 0),
            eq(conversationStates.state, "idle"),
            isNull(conversationStates.activeInteractionRunId),
            sql<boolean>`exists (
              select 1
              from "messages" as "legacy_message"
              where "legacy_message"."space_id" = ${conversationStates.spaceId}
                and "legacy_message"."direction" = 'inbound'
                and not (
                  exists (
                    select 1
                    from "chains" as "direct_chain"
                    where "direct_chain"."id" = "legacy_message"."drained_chain_id"
                      and "direct_chain"."state" = 'complete'
                  )
                  or exists (
                    select 1
                    from "carried_messages" as "carried"
                    inner join "chains" as "consuming_chain"
                      on "consuming_chain"."id" = "carried"."consumed_by_chain_id"
                    where "carried"."source_message_id" = "legacy_message"."id"
                      and "consuming_chain"."state" = 'complete'
                  )
                )
            )`,
          ),
        ),
      )
      .orderBy(asc(conversationStates.spaceId))
      .limit(boundedLimit(limit));
    return rows.map((row) => row.spaceId);
  }

  public async findActiveRuns(limit = 100): Promise<InteractionRunRecord[]> {
    const rows = await this.database
      .select(interactionRunSelection)
      .from(interactionRuns)
      .where(
        inArray(interactionRuns.state, ["starting", "active", "finalizing"]),
      )
      .orderBy(asc(interactionRuns.updatedAt), asc(interactionRuns.id))
      .limit(boundedLimit(limit));
    return rows.map((row) => interactionRunRecordSchema.parse(row));
  }

  public async findUncertainSteers(
    limit = 100,
  ): Promise<InteractionSteerRecord[]> {
    const rows = await this.database
      .select(interactionSteerSelection)
      .from(interactionSteers)
      .where(eq(interactionSteers.state, "submitting"))
      .orderBy(asc(interactionSteers.updatedAt), asc(interactionSteers.id))
      .limit(boundedLimit(limit));
    return rows.map((row) => interactionSteerRecordSchema.parse(row));
  }

  public async loadMessagesBySequenceRange(input: {
    spaceId: string;
    fromSequence: number;
    throughSequence: number;
  }): Promise<SequencedInboundMessageRecord[]> {
    sequenceRange(input.fromSequence, input.throughSequence);
    const rows = await this.database
      .select({
        messageId: messages.id,
        spaceId: messages.spaceId,
        inputSequence: messages.inputSequence,
        senderIdentityId: messages.senderIdentityId,
        contentCiphertext: messages.contentCiphertext,
        contentHash: messages.contentHash,
        receivedAt: messages.receivedAt,
        retentionExpiresAt: messages.retentionExpiresAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.spaceId, input.spaceId),
          eq(messages.direction, "inbound"),
          gte(messages.inputSequence, input.fromSequence),
          lte(messages.inputSequence, input.throughSequence),
        ),
      )
      .orderBy(asc(messages.inputSequence), asc(messages.id));

    return rows.map((row) => {
      if (
        row.inputSequence === null ||
        row.receivedAt === null ||
        !Number.isSafeInteger(row.inputSequence) ||
        row.inputSequence < 0
      ) {
        throw new Error(
          "Recovery loaded an invalid sequenced inbound row. Repair the affected space before resuming the actor.",
        );
      }
      return {
        ...row,
        inputSequence: row.inputSequence,
        receivedAt: row.receivedAt,
      };
    });
  }

  public async loadActorSnapshot(spaceId: string) {
    const [row] = await this.database
      .select({
        state: conversationStateSelection,
        activeRun: interactionRunSelection,
      })
      .from(conversationStates)
      .leftJoin(
        interactionRuns,
        eq(interactionRuns.id, conversationStates.activeInteractionRunId),
      )
      .where(eq(conversationStates.spaceId, spaceId))
      .limit(1);
    if (row === undefined) {
      return null;
    }
    return {
      state: conversationStateRecordSchema.parse(row.state),
      activeRun:
        row.activeRun === null
          ? null
          : interactionRunRecordSchema.parse(row.activeRun),
    };
  }
}

/**
 * PostgreSQL adapter for the frozen Step 0 port. Concrete repositories retain
 * the finer Worktree A APIs without widening the shared actor contract.
 */
export class PostgresConversationRepository
  implements ConversationRepositoryPort
{
  private readonly inbound: SequencedInboundRepository;
  private readonly states: ConversationStateRepository;
  private readonly runs: InteractionRunRepository;
  private readonly steers: InteractionSteerRepository;
  private readonly authorization: InteractionAuthorizationRepository;
  private readonly recovery: ConversationRecoveryRepository;

  public constructor(database: Database) {
    this.inbound = new SequencedInboundRepository(database);
    this.states = new ConversationStateRepository(database);
    this.runs = new InteractionRunRepository(database);
    this.steers = new InteractionSteerRepository(database);
    this.authorization = new InteractionAuthorizationRepository(database);
    this.recovery = new ConversationRecoveryRepository(database);
  }

  public async initializeConversation(input: {
    spaceId: string;
  }): Promise<ConversationInitializationResult> {
    return this.inbound.initializeConversation(input);
  }

  public async ingestInput(
    input: EncryptedConversationInput,
  ): Promise<ConversationInputIngestResult> {
    const ingested = await this.inbound.ingestForActor(input);
    return this.#parseIngestResult(ingested);
  }

  /** Concrete observe-mode API that cannot advance accepted/finalized cursors. */
  public async ingestObservedInput(
    input: EncryptedConversationInput,
  ): Promise<ConversationInputIngestResult> {
    const ingested = await this.inbound.ingestForObservation(input);
    return this.#parseIngestResult(ingested);
  }

  #parseIngestResult(
    ingested: Awaited<ReturnType<SequencedInboundRepository["ingestForActor"]>>,
  ): ConversationInputIngestResult {
    return conversationInputIngestResultSchema.parse({
      status: ingested.result.inserted ? "inserted" : "duplicate",
      input: {
        messageId: ingested.result.messageId,
        spaceId: ingested.result.spaceId,
        inputSequence: ingested.result.inputSequence,
        actorGeneration: ingested.actorGeneration,
      },
    });
  }

  public async loadConversation(spaceId: string) {
    return this.recovery.loadActorSnapshot(spaceId);
  }

  public async loadInteractionRun(interactionRunId: string) {
    return this.runs.loadInteractionRun(interactionRunId);
  }

  public async loadAuthorizationReference(
    interactionRunId: string,
  ): Promise<InteractionAuthorizationReference | null> {
    return this.authorization.loadAuthorizationReference(interactionRunId);
  }

  public async beginInteraction(
    input: BeginInteractionInput,
  ): Promise<InteractionRunMutationResult> {
    return this.runs.beginInteraction(input);
  }

  public async checkpointInteraction(
    input: InteractionRunCheckpoint,
  ): Promise<InteractionRunMutationResult> {
    return this.runs.checkpointInteraction(input);
  }

  public async recoverInteraction(
    input: RecoverInteractionInput,
  ): Promise<InteractionRunMutationResult> {
    return this.runs.recoverInteraction(input);
  }

  public async createSteer(
    input: CreateInteractionSteerInput,
  ): Promise<InteractionSteerMutationResult> {
    return this.steers.createSteer(input);
  }

  public async claimPendingSteer(input: {
    spaceId: string;
    expectedConversation: CreateInteractionSteerInput["expectedConversation"];
    expectedRun: InteractionRunCasPrecondition;
  }): Promise<InteractionSteerClaimResult> {
    return this.steers.claimPendingSteer(input);
  }

  public async checkpointSteer(
    input: InteractionSteerCheckpoint,
  ): Promise<InteractionSteerMutationResult> {
    return this.steers.checkpointSteer(input);
  }

  public async createStartingRun(input: BeginInteractionInput) {
    return this.runs.createStartingRun(input);
  }

  public async markRunActive(input: MarkRunActiveInput) {
    return this.runs.markRunActive(input);
  }

  public async recordTurnIdentity(input: RecordTurnIdentityInput) {
    return this.runs.recordTurnIdentity(input);
  }

  public async storeTerminalDecision(input: StoreTerminalDecisionInput) {
    return this.runs.storeTerminalDecision(input);
  }

  public async storeUndeliveredDraft(input: StoreUndeliveredDraftInput) {
    return this.runs.storeUndeliveredDraft(input);
  }

  public async finalizeRun(input: FinalizeRunInput) {
    return this.runs.finalizeRun(input);
  }

  public async markRunInterrupted(
    input: Omit<RecoverInteractionInput, "terminalState">,
  ) {
    return this.runs.markRunInterrupted(input);
  }

  public async markRunOrphaned(
    input: Omit<RecoverInteractionInput, "terminalState">,
  ) {
    return this.runs.markRunOrphaned(input);
  }

  public async incrementActorGeneration(
    input: IncrementActorGenerationInput,
  ): Promise<ConversationStateMutationResult> {
    return this.states.incrementActorGeneration(input);
  }

  public async beginSteerSubmission(input: BeginSteerSubmissionInput) {
    return this.steers.beginSteerSubmission(input);
  }

  public async markSteerAccepted(input: MarkSteerAcceptedInput) {
    return this.steers.markSteerAccepted(input);
  }

  public async findSpacesBehindCursor(limit = 100) {
    return this.recovery.findSpacesBehindCursor(limit);
  }

  public async findSpacesWithUnfinalizedInput(
    input: UnfinalizedConversationQuery = {},
  ) {
    return this.recovery.findSpacesWithUnfinalizedInput(input);
  }

  public async findActiveRuns(limit = 100) {
    return this.recovery.findActiveRuns(limit);
  }

  public async findUncertainSteers(limit = 100) {
    return this.recovery.findUncertainSteers(limit);
  }

  public async loadMessagesBySequenceRange(input: {
    spaceId: string;
    fromSequence: number;
    throughSequence: number;
  }) {
    return this.recovery.loadMessagesBySequenceRange(input);
  }

  public async loadActorSnapshot(spaceId: string) {
    return this.recovery.loadActorSnapshot(spaceId);
  }
}
