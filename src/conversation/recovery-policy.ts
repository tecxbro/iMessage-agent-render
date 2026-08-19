import {
  INTERACTION_RUN_TERMINAL_STATES,
  type ConversationStateRecord,
  type InteractionRunRecord,
  type InteractionRunRecoveryState,
} from "./state.js";

const terminalRunStates = new Set<InteractionRunRecord["state"]>(
  INTERACTION_RUN_TERMINAL_STATES,
);

export interface InteractionRecoveryPolicyInput {
  conversation: ConversationStateRecord | null;
  run: InteractionRunRecord;
  sessionAvailable: boolean;
}

export type InteractionRecoveryDecision =
  | {
      action: "none";
      reason: "terminal";
    }
  | {
      action: "resume";
      reason: "authoritative_session_available";
    }
  | {
      action: "terminalize";
      terminalState: InteractionRunRecoveryState;
      terminalReason:
        | "authoritative_runtime_session_unavailable"
        | "authoritative_run_mismatch";
      startReplacement: boolean;
    };

/**
 * Classifies a discovered run without mutating it. Pointer/generation mismatch
 * is authoritative and therefore wins over any local runtime-session hint.
 */
export function classifyInteractionRecovery(
  input: InteractionRecoveryPolicyInput,
): InteractionRecoveryDecision {
  if (terminalRunStates.has(input.run.state)) {
    return { action: "none", reason: "terminal" };
  }

  const authoritative =
    input.conversation !== null &&
    input.conversation.spaceId === input.run.spaceId &&
    input.conversation.activeInteractionRunId === input.run.id &&
    input.conversation.actorGeneration === input.run.generation;

  if (!authoritative) {
    return {
      action: "terminalize",
      terminalState: "orphaned",
      terminalReason: "authoritative_run_mismatch",
      startReplacement: false,
    };
  }

  if (!input.sessionAvailable) {
    return {
      action: "terminalize",
      terminalState: "interrupted",
      terminalReason: "authoritative_runtime_session_unavailable",
      startReplacement: true,
    };
  }

  return { action: "resume", reason: "authoritative_session_available" };
}
