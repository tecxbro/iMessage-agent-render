import type { JsonValue } from "../security/action-schema.js";
import type { InteractionCoordinatePayload } from "../queue/payloads.js";
import type {
  BeginInteractionConversationPrecondition,
  ConversationActorState,
  ConversationCasPrecondition,
  ConversationInitializationResult,
  ConversationInputIngestResult,
  ConversationStateRecord,
  InteractionAuthorizationReference,
  InteractionRunCasPrecondition,
  InteractionRunMutationResult,
  InteractionRunRecord,
  InteractionRunRecoveryState,
  InteractionRunState,
  InteractionSteerCasPrecondition,
  InteractionSteerClaimResult,
  InteractionSteerMutationResult,
  InteractionSteerState,
} from "./state.js";

export interface EncryptedConversationInput {
  messageId: string;
  spaceId: string;
  externalMessageId: string;
  senderIdentityId: string;
  contentCiphertext: string;
  contentHash: string;
  receivedAt: Date;
  retentionExpiresAt: Date;
}

export interface BeginInteractionInput {
  interactionRunId: string;
  spaceId: string;
  /**
   * The run generation is actorGeneration + 1, and both initial run cursors
   * equal latestInputSequence. The precondition permits only idle/recovering,
   * a null active pointer, and at least one unfinalized input.
   */
  expectedConversation: BeginInteractionConversationPrecondition;
  modelId: string;
  reasoningEffort: string;
  promptVersion: string;
  promptSha256: string;
  authorization: Omit<
    InteractionAuthorizationReference,
    "interactionRunId" | "createdAt"
  >;
}

export interface ConversationCheckpointUpdate {
  state: ConversationActorState;
  activeInteractionRunId: string | null;
  acceptedThroughSequence: number;
  finalizedThroughSequence: number;
}

export interface InteractionRunCheckpoint {
  spaceId: string;
  expectedConversation: ConversationCasPrecondition;
  expectedRun: InteractionRunCasPrecondition;
  nextRunState: InteractionRunState;
  nextConversation: ConversationCheckpointUpdate;
  threadId?: string | null;
  turnId?: string | null;
  /** Routing/task metadata only. User-visible draft text belongs in the encrypted field. */
  decisionMetadataJson?: Readonly<Record<string, JsonValue>> | null;
  draftOutputCiphertext?: string | null;
  terminalReason?: string | null;
  lastObservedEventJson?: JsonValue | null;
  completedAt?: Date | null;
}

export interface CreateInteractionSteerInput {
  id: string;
  spaceId: string;
  expectedConversation: ConversationCasPrecondition;
  expectedRun: InteractionRunCasPrecondition;
  clientUserMessageId: string;
  fromSequence: number;
  throughSequence: number;
  expectedTurnId: string | null;
  submissionGeneration: number;
}

export interface InteractionSteerCheckpoint {
  spaceId: string;
  expectedConversation: ConversationCasPrecondition;
  expectedRun: InteractionRunCasPrecondition;
  expectedSteer: InteractionSteerCasPrecondition;
  nextState: InteractionSteerState;
  submittedAt?: Date | null;
  acceptedAt?: Date | null;
}

export interface ConversationSnapshot {
  state: ConversationStateRecord;
  activeRun: InteractionRunRecord | null;
}

export interface RecoverInteractionInput {
  spaceId: string;
  expectedConversation: ConversationCasPrecondition;
  expectedRun: InteractionRunCasPrecondition;
  terminalState: InteractionRunRecoveryState;
  terminalReason: string;
  recoveredAt: Date;
}

export interface ConversationRepositoryPort {
  /**
   * Idempotently creates conversation state and sequences any legacy inbound
   * rows in one transaction. Legacy rows are treated as finalized history so
   * activating the actor cannot emit duplicate user-visible replies. This is
   * permitted only before generation 1; a later NULL sequence is an invariant
   * failure, not history that may be silently finalized.
   */
  initializeConversation(input: {
    spaceId: string;
  }): Promise<ConversationInitializationResult>;
  /**
   * Atomically initializes/locks the conversation, inserts the encrypted
   * inbound row, assigns its next sequence, and advances latestInputSequence.
   * A provider duplicate returns the original message ID and sequence.
   */
  ingestInput(
    input: EncryptedConversationInput,
  ): Promise<ConversationInputIngestResult>;
  loadConversation(spaceId: string): Promise<ConversationSnapshot | null>;
  loadInteractionRun(
    interactionRunId: string,
  ): Promise<InteractionRunRecord | null>;
  loadAuthorizationReference(
    interactionRunId: string,
  ): Promise<InteractionAuthorizationReference | null>;
  beginInteraction(
    input: BeginInteractionInput,
  ): Promise<InteractionRunMutationResult>;
  checkpointInteraction(
    input: InteractionRunCheckpoint,
  ): Promise<InteractionRunMutationResult>;
  /**
   * Terminalizes a run before recovery. Interrupted runs were still active
   * when their runtime ended; orphaned runs no longer match the authoritative
   * active pointer/generation. Neither state may be resumed in place.
   */
  recoverInteraction(
    input: RecoverInteractionInput,
  ): Promise<InteractionRunMutationResult>;
  createSteer(
    input: CreateInteractionSteerInput,
  ): Promise<InteractionSteerMutationResult>;
  claimPendingSteer(input: {
    spaceId: string;
    expectedConversation: ConversationCasPrecondition;
    expectedRun: InteractionRunCasPrecondition;
  }): Promise<InteractionSteerClaimResult>;
  checkpointSteer(
    input: InteractionSteerCheckpoint,
  ): Promise<InteractionSteerMutationResult>;
}

export interface InteractionContextMessage {
  messageId: string;
  inputSequence: number;
  text: string;
}

export interface InteractionContext {
  spaceId: string;
  interactionRunId: string;
  fromSequence: number;
  throughSequence: number;
  messages: readonly InteractionContextMessage[];
  conversationHistory: readonly string[];
  taskResults: readonly JsonValue[];
  recoverySummary?: string;
}

export interface InteractionContextLoaderPort {
  load(input: {
    spaceId: string;
    interactionRunId: string;
    fromSequence: number;
    throughSequence: number;
  }): Promise<InteractionContext>;
}

export interface InteractionRuntimeSession {
  threadId: string;
  turnId: string;
}

export interface InteractionRuntimeStartInput {
  run: InteractionRunRecord;
  context: InteractionContext;
  signal: AbortSignal;
}

export interface InteractionRuntimeSteerInput {
  interactionRunId: string;
  threadId: string;
  expectedTurnId: string | null;
  clientUserMessageId: string;
  submissionGeneration: number;
  messages: readonly InteractionContextMessage[];
  signal: AbortSignal;
}

export interface InteractionRuntimeSteerReceipt {
  turnId: string;
  acceptedAt: Date;
  lastObservedEventJson: JsonValue | null;
}

export interface InteractionRuntimeCompletion {
  threadId: string;
  turnId: string;
  /** Routing/task metadata only; this object must never contain the draft answer. */
  decisionMetadataJson: Readonly<Record<string, JsonValue>>;
  draftOutput: string | null;
  lastObservedEventJson: JsonValue | null;
}

export interface InteractionRuntimePort {
  start(input: InteractionRuntimeStartInput): Promise<InteractionRuntimeSession>;
  resume(input: InteractionRuntimeStartInput): Promise<InteractionRuntimeSession>;
  steer(
    input: InteractionRuntimeSteerInput,
  ): Promise<InteractionRuntimeSteerReceipt>;
  waitForCompletion(input: {
    interactionRunId: string;
    session: InteractionRuntimeSession;
    signal: AbortSignal;
  }): Promise<InteractionRuntimeCompletion>;
  cancel(input: {
    interactionRunId: string;
    session: InteractionRuntimeSession;
  }): Promise<void>;
}

export interface InteractionStartGatePort {
  authorize(input: {
    spaceId: string;
    throughSequence: number;
  }): Promise<
    Omit<InteractionAuthorizationReference, "interactionRunId" | "createdAt"> | null
  >;
  revalidate(reference: InteractionAuthorizationReference): Promise<boolean>;
}

export interface InteractionPresenceLease {
  stop(): Promise<void>;
}

export interface InteractionPresencePort {
  start(input: {
    spaceId: string;
    interactionRunId: string;
    signal: AbortSignal;
  }): Promise<InteractionPresenceLease>;
}

export interface InteractionTaskSnapshot {
  pendingCount: number;
  terminalResults: readonly JsonValue[];
}

export interface InteractionTaskPort {
  dispatch(input: {
    interactionRunId: string;
    generation: number;
    decisionMetadataJson: Readonly<Record<string, JsonValue>>;
  }): Promise<void>;
  reconcile(input: {
    interactionRunId: string;
    generation: number;
  }): Promise<InteractionTaskSnapshot>;
}

export interface InteractionDeliveryPort {
  /** Encrypts and stages the draft without copying it into plaintext metadata. */
  prepare(input: {
    interactionRunId: string;
    spaceId: string;
    generation: number;
    draftOutput: string;
  }): Promise<{ outboundBatchId: string }>;
}

export interface InteractionWakePublisherPort {
  publish(payload: InteractionCoordinatePayload): Promise<void>;
}

export interface ActorRegistryPort {
  runExclusive<Result>(
    spaceId: string,
    actor: () => Promise<Result>,
  ): Promise<Result>;
}
