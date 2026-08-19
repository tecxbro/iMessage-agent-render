import type { JsonValue } from "../security/action-schema.js";
import type { InteractionCoordinatePayload } from "../queue/payloads.js";
import type {
  ConversationActorState,
  ConversationStateRecord,
  InteractionAuthorizationReference,
  InteractionRunRecord,
  InteractionRunState,
  InteractionSteerRecord,
  InteractionSteerState,
} from "./state.js";

export interface AssignedConversationInput {
  messageId: string;
  spaceId: string;
  inputSequence: number;
  actorGeneration: number;
}

export interface BeginInteractionInput {
  interactionRunId: string;
  spaceId: string;
  expectedActorGeneration: number;
  generation: number;
  startedThroughSequence: number;
  acceptedThroughSequence: number;
  modelId: string;
  reasoningEffort: string;
  promptVersion: string;
  promptSha256: string;
  authorization: Omit<
    InteractionAuthorizationReference,
    "interactionRunId" | "createdAt"
  >;
}

export interface InteractionRunCheckpoint {
  interactionRunId: string;
  spaceId: string;
  generation: number;
  expectedRunState: InteractionRunState;
  nextRunState: InteractionRunState;
  nextConversationState: ConversationActorState;
  acceptedThroughSequence?: number;
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
  interactionRunId: string;
  spaceId: string;
  generation: number;
  clientUserMessageId: string;
  fromSequence: number;
  throughSequence: number;
  expectedTurnId: string | null;
  submissionGeneration: number;
}

export interface InteractionSteerCheckpoint {
  interactionSteerId: string;
  interactionRunId: string;
  generation: number;
  expectedState: InteractionSteerState;
  nextState: InteractionSteerState;
  submittedAt?: Date | null;
  acceptedAt?: Date | null;
}

export interface ConversationSnapshot {
  state: ConversationStateRecord;
  activeRun: InteractionRunRecord | null;
}

export interface ConversationRepositoryPort {
  assignInputSequence(input: {
    spaceId: string;
    messageId: string;
  }): Promise<AssignedConversationInput>;
  loadConversation(spaceId: string): Promise<ConversationSnapshot | null>;
  loadInteractionRun(
    interactionRunId: string,
  ): Promise<InteractionRunRecord | null>;
  loadAuthorizationReference(
    interactionRunId: string,
  ): Promise<InteractionAuthorizationReference | null>;
  beginInteraction(
    input: BeginInteractionInput,
  ): Promise<InteractionRunRecord | null>;
  checkpointInteraction(
    input: InteractionRunCheckpoint,
  ): Promise<InteractionRunRecord | null>;
  createSteer(
    input: CreateInteractionSteerInput,
  ): Promise<InteractionSteerRecord>;
  claimPendingSteer(input: {
    interactionRunId: string;
    generation: number;
  }): Promise<InteractionSteerRecord | null>;
  checkpointSteer(
    input: InteractionSteerCheckpoint,
  ): Promise<InteractionSteerRecord | null>;
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
