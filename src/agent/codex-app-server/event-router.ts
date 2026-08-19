import { z } from "zod";

import type { AppServerNotification } from "./protocol.js";

const MAXIMUM_DIAGNOSTICS = 128;
const MAXIMUM_PENDING_EVENTS = 128;

export interface RoutedCodexAppServerEvent {
  interactionRunId: string;
  threadId: string;
  turnId: string | undefined;
  generation: number;
  notification: AppServerNotification;
}

export interface CodexAppServerProcessClosedEvent {
  interactionRunId: string;
  threadId: string;
  turnId: string | undefined;
  generation: number;
}

export interface CodexAppServerEventDiagnostic {
  method: string;
  threadId: string | undefined;
  turnId: string | undefined;
  generation: number;
  reason:
    | "malformed_notification"
    | "unknown_interaction"
    | "stale_generation";
}

const terminalTurnNotificationParamsSchema = z
  .object({
    threadId: z.string().trim().min(1).max(512),
    turn: z
      .object({
        id: z.string().trim().min(1).max(512),
        status: z.enum([
          "completed",
          "interrupted",
          "failed",
          "inProgress",
        ]),
        items: z.array(
          z
            .object({ type: z.string().trim().min(1).max(128) })
            .passthrough(),
        ),
        itemsView: z.enum(["notLoaded", "summary", "full"]),
        error: z.unknown().nullable(),
        startedAt: z.number().finite().nullable(),
        completedAt: z.number().finite().nullable(),
        durationMs: z.number().finite().nonnegative().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export interface CodexAppServerInteractionRegistration {
  interactionRunId: string;
  threadId: string;
  turnId?: string;
  generation: number;
  onEvent(event: RoutedCodexAppServerEvent): void;
  onProcessClosed(event: CodexAppServerProcessClosedEvent): void;
}

export interface CodexAppServerInteractionHandle {
  readonly interactionRunId: string;
  bindTurn(turnId: string): void;
  dispose(): void;
}

interface ActiveInteraction
  extends Omit<CodexAppServerInteractionRegistration, "turnId"> {
  turnId: string | undefined;
  processClosed: boolean;
  pendingEvents: Array<{
    notification: AppServerNotification;
    turnId: string;
  }>;
}

export class CodexAppServerEventRouter {
  readonly #active = new Map<string, ActiveInteraction>();
  readonly #diagnostics: CodexAppServerEventDiagnostic[] = [];
  #currentGeneration = 0;

  public setCurrentGeneration(generation: number): void {
    if (
      !Number.isSafeInteger(generation) ||
      generation < this.#currentGeneration
    ) {
      throw new Error("Codex App Server generation must only advance.");
    }
    this.#currentGeneration = generation;
  }

  public register(
    registration: CodexAppServerInteractionRegistration,
  ): CodexAppServerInteractionHandle {
    if (this.#active.has(registration.interactionRunId)) {
      throw new Error("Interaction run ID is already registered.");
    }
    if (
      registration.generation !== this.#currentGeneration ||
      registration.generation <= 0
    ) {
      throw new Error("Interaction must register against the active generation.");
    }
    if (registration.turnId !== undefined) {
      this.#assertRouteAvailable(
        registration.interactionRunId,
        registration.threadId,
        registration.turnId,
        registration.generation,
      );
    }
    const active: ActiveInteraction = {
      ...registration,
      turnId: registration.turnId,
      processClosed: false,
      pendingEvents: [],
    };
    this.#active.set(registration.interactionRunId, active);
    return {
      interactionRunId: registration.interactionRunId,
      bindTurn: (turnId) => {
        const current = this.#active.get(registration.interactionRunId);
        if (current === undefined || current.processClosed) {
          return;
        }
        if (current.turnId !== undefined && current.turnId !== turnId) {
          throw new Error("Interaction turn ID cannot be rebound.");
        }
        this.#assertRouteAvailable(
          current.interactionRunId,
          current.threadId,
          turnId,
          current.generation,
        );
        current.turnId = turnId;
        const pendingEvents = current.pendingEvents.splice(0);
        for (const pending of pendingEvents) {
          if (pending.turnId === turnId) {
            this.#deliver(current, pending.notification, pending.turnId);
          } else {
            this.#record({
              method: pending.notification.method,
              threadId: current.threadId,
              turnId: pending.turnId,
              generation: current.generation,
              reason: "unknown_interaction",
            });
          }
        }
      },
      dispose: () => {
        const current = this.#active.get(registration.interactionRunId);
        if (current !== undefined) {
          for (const pending of current.pendingEvents) {
            this.#record({
              method: pending.notification.method,
              threadId: current.threadId,
              turnId: pending.turnId,
              generation: current.generation,
              reason: "unknown_interaction",
            });
          }
        }
        this.#active.delete(registration.interactionRunId);
      },
    };
  }

  public route(notification: AppServerNotification, generation: number): void {
    const { threadId, turnId } = extractRoute(notification.params);
    if (generation !== this.#currentGeneration) {
      this.#record({
        method: notification.method,
        threadId,
        turnId,
        generation,
        reason: "stale_generation",
      });
      return;
    }
    const terminalTurn =
      notification.method === "turn/started" ||
      notification.method === "turn/completed"
        ? terminalTurnNotificationParamsSchema.safeParse(notification.params)
        : undefined;
    if (
      terminalTurn !== undefined &&
      (!terminalTurn.success ||
        (notification.method === "turn/started" &&
          terminalTurn.data.turn.status !== "inProgress") ||
        (notification.method === "turn/completed" &&
          terminalTurn.data.turn.status === "inProgress"))
    ) {
      this.#record({
        method: notification.method,
        threadId,
        turnId,
        generation,
        reason: "malformed_notification",
      });
      return;
    }
    if (threadId === undefined) {
      this.#record({
        method: notification.method,
        threadId,
        turnId,
        generation,
        reason: "unknown_interaction",
      });
      return;
    }

    const threadMatches = [...this.#active.values()].filter(
      (active) =>
        !active.processClosed &&
        active.generation === generation &&
        active.threadId === threadId,
    );
    let routed = threadMatches;
    if (turnId !== undefined) {
      const exact = threadMatches.filter((active) => active.turnId === turnId);
      if (exact.length > 0) {
        routed = exact;
      } else {
        const pending = threadMatches.filter(
          (active) => active.turnId === undefined,
        );
        for (const active of pending) {
          if (active.pendingEvents.length >= MAXIMUM_PENDING_EVENTS) {
            const discarded = active.pendingEvents.shift();
            if (discarded !== undefined) {
              this.#record({
                method: discarded.notification.method,
                threadId: active.threadId,
                turnId: discarded.turnId,
                generation: active.generation,
                reason: "unknown_interaction",
              });
            }
          }
          active.pendingEvents.push({ notification, turnId });
        }
        if (pending.length > 0) {
          return;
        }
        routed = [];
      }
    }
    if (routed.length === 0) {
      this.#record({
        method: notification.method,
        threadId,
        turnId,
        generation,
        reason: "unknown_interaction",
      });
      return;
    }
    for (const active of routed) {
      this.#deliver(active, notification, turnId);
    }
  }

  public processClosed(generation: number): void {
    for (const active of this.#active.values()) {
      if (active.generation !== generation || active.processClosed) {
        continue;
      }
      active.processClosed = true;
      for (const pending of active.pendingEvents.splice(0)) {
        this.#record({
          method: pending.notification.method,
          threadId: active.threadId,
          turnId: pending.turnId,
          generation: active.generation,
          reason: "unknown_interaction",
        });
      }
      try {
        active.onProcessClosed({
          interactionRunId: active.interactionRunId,
          threadId: active.threadId,
          turnId: active.turnId,
          generation,
        });
      } catch {
        // Continue notifying every active actor even if one callback fails.
      }
    }
  }

  public diagnostics(): readonly CodexAppServerEventDiagnostic[] {
    return this.#diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  #record(diagnostic: CodexAppServerEventDiagnostic): void {
    this.#diagnostics.push(diagnostic);
    if (this.#diagnostics.length > MAXIMUM_DIAGNOSTICS) {
      this.#diagnostics.shift();
    }
  }

  #deliver(
    active: ActiveInteraction,
    notification: AppServerNotification,
    turnId: string | undefined,
  ): void {
    try {
      active.onEvent({
        interactionRunId: active.interactionRunId,
        threadId: active.threadId,
        turnId,
        generation: active.generation,
        notification,
      });
    } catch {
      // One actor callback cannot prevent routing to another active actor.
    }
  }

  #assertRouteAvailable(
    interactionRunId: string,
    threadId: string,
    turnId: string,
    generation: number,
  ): void {
    const duplicate = [...this.#active.values()].some(
      (active) =>
        active.interactionRunId !== interactionRunId &&
        !active.processClosed &&
        active.generation === generation &&
        active.threadId === threadId &&
        active.turnId === turnId,
    );
    if (duplicate) {
      throw new Error("Interaction route is already registered.");
    }
  }
}

function extractRoute(params: unknown): {
  threadId: string | undefined;
  turnId: string | undefined;
} {
  if (typeof params !== "object" || params === null) {
    return { threadId: undefined, turnId: undefined };
  }
  const record = params as Record<string, unknown>;
  let threadId =
    typeof record["threadId"] === "string" ? record["threadId"] : undefined;
  if (threadId === undefined) {
    const thread = record["thread"];
    if (typeof thread === "object" && thread !== null) {
      const id = (thread as Record<string, unknown>)["id"];
      if (typeof id === "string") {
        threadId = id;
      }
    }
  }
  let turnId =
    typeof record["turnId"] === "string" ? record["turnId"] : undefined;
  if (turnId === undefined) {
    const turn = record["turn"];
    if (typeof turn === "object" && turn !== null) {
      const id = (turn as Record<string, unknown>)["id"];
      if (typeof id === "string") {
        turnId = id;
      }
    }
  }
  return { threadId, turnId };
}
