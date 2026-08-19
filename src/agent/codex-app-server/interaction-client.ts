import { z } from "zod";

import type { ThreadReadParams } from "./generated/v2/ThreadReadParams.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.js";
import {
  type CodexAppServerInteractionHandle,
  type CodexAppServerInteractionRegistration,
  CodexAppServerEventRouter,
} from "./event-router.js";
import {
  CodexAppServerConnectionClosedError,
  CodexAppServerProtocolError,
  CodexAppServerRequestTimeoutError,
} from "./protocol.js";

const identifierSchema = z.string().trim().min(1).max(512);
const turnStatusSchema = z.enum([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);
const userMessageItemSchema = z
  .object({
    type: z.literal("userMessage"),
    id: identifierSchema,
    clientId: identifierSchema.nullable(),
    content: z.array(z.unknown()),
  })
  .passthrough();
const otherThreadItemSchema = z
  .object({
    type: z.string().trim().min(1).max(128),
    id: identifierSchema.optional(),
  })
  .passthrough()
  .refine((item) => item.type !== "userMessage");
const threadItemSchema = z.union([
  userMessageItemSchema,
  otherThreadItemSchema,
]);
const turnSchema = z
  .object({
    id: identifierSchema,
    status: turnStatusSchema,
    items: z.array(threadItemSchema),
    itemsView: z.enum(["notLoaded", "summary", "full"]),
    error: z.unknown().nullable(),
    startedAt: z.number().finite().nullable(),
    completedAt: z.number().finite().nullable(),
    durationMs: z.number().finite().nonnegative().nullable(),
  })
  .passthrough();
const threadSchema = z
  .object({
    id: identifierSchema,
    turns: z.array(turnSchema),
  })
  .passthrough();
const threadStartResponseSchema = z
  .object({ thread: threadSchema })
  .passthrough();
const threadResumeResponseSchema = z
  .object({ thread: threadSchema })
  .passthrough();
const threadReadResponseSchema = z.object({ thread: threadSchema }).passthrough();
const turnStartResponseSchema = z.object({ turn: turnSchema }).passthrough();
const turnSteerResponseSchema = z
  .object({ turnId: identifierSchema })
  .passthrough();
const turnInterruptResponseSchema = z.object({}).strict();

/**
 * Runtime-owned views intentionally expose only fields validated and used by
 * interaction/recovery code. Generated request bindings remain the source of
 * truth for outbound parameters; these views never claim unvalidated provider
 * fields are present.
 */
export type CodexAppServerThreadItemView = z.infer<typeof threadItemSchema>;
export type CodexAppServerTurnView = z.infer<typeof turnSchema>;
export type CodexAppServerThreadView = z.infer<typeof threadSchema>;
export type CodexAppServerThreadStartResult = z.infer<
  typeof threadStartResponseSchema
>;
export type CodexAppServerThreadResumeResult = z.infer<
  typeof threadResumeResponseSchema
>;
export type CodexAppServerThreadReadResult = z.infer<
  typeof threadReadResponseSchema
>;
export type CodexAppServerTurnStartResult = z.infer<
  typeof turnStartResponseSchema
>;
export type CodexAppServerTurnSteerResult = z.infer<
  typeof turnSteerResponseSchema
>;
export type CodexAppServerTurnInterruptResult = z.infer<
  typeof turnInterruptResponseSchema
>;

export interface CodexAppServerInteractionRpc {
  request(
    method: string,
    params: unknown,
    options?: { expectedGeneration?: number },
  ): Promise<unknown>;
  generation(): number;
}

export type TurnSteerSubmissionResult =
  | { state: "accepted"; response: CodexAppServerTurnSteerResult }
  | {
      state: "uncertain_submission";
      threadId: string;
      expectedTurnId: string;
      clientUserMessageId: string;
      generation: number;
    };

export type InteractionRegistration = CodexAppServerInteractionRegistration;

export type TurnStartInteractionRegistration = Omit<
  CodexAppServerInteractionRegistration,
  "threadId" | "turnId"
>;

export interface GenerationPrecondition {
  expectedGeneration: number;
}

export interface TurnStartInteractionResult {
  response: CodexAppServerTurnStartResult;
  interaction: CodexAppServerInteractionHandle;
}

export class CodexAppServerInteractionClient {
  public constructor(
    private readonly rpc: CodexAppServerInteractionRpc,
    private readonly eventRouter: CodexAppServerEventRouter,
  ) {}

  public registerInteraction(
    registration: InteractionRegistration,
  ): CodexAppServerInteractionHandle {
    return this.eventRouter.register(registration);
  }

  public generation(): number {
    return this.rpc.generation();
  }

  public async threadStart(
    params: ThreadStartParams,
  ): Promise<CodexAppServerThreadStartResult> {
    return this.#parse(
      threadStartResponseSchema,
      await this.rpc.request("thread/start", params),
    );
  }

  public async threadResume(
    params: ThreadResumeParams,
  ): Promise<CodexAppServerThreadResumeResult> {
    const response = this.#parse(
      threadResumeResponseSchema,
      await this.rpc.request("thread/resume", params),
    );
    if (response.thread.id !== params.threadId) {
      throw new CodexAppServerProtocolError();
    }
    return response;
  }

  public async threadRead(
    params: ThreadReadParams,
  ): Promise<CodexAppServerThreadReadResult> {
    const response = this.#parse(
      threadReadResponseSchema,
      await this.rpc.request("thread/read", params),
    );
    if (response.thread.id !== params.threadId) {
      throw new CodexAppServerProtocolError();
    }
    return response;
  }

  public async turnStart(
    params: TurnStartParams,
    precondition: GenerationPrecondition,
  ): Promise<CodexAppServerTurnStartResult> {
    return this.#parse(
      turnStartResponseSchema,
      await this.rpc.request("turn/start", params, precondition),
    );
  }

  public async turnStartInteraction(
    params: TurnStartParams,
    registration: TurnStartInteractionRegistration,
  ): Promise<TurnStartInteractionResult> {
    const generation = registration.generation;
    const interaction = this.eventRouter.register({
      ...registration,
      threadId: params.threadId,
      generation,
    });
    try {
      const response = this.#parse(
        turnStartResponseSchema,
        await this.rpc.request("turn/start", params, {
          expectedGeneration: generation,
        }),
      );
      interaction.bindTurn(response.turn.id);
      return { response, interaction };
    } catch (error) {
      interaction.dispose();
      throw error;
    }
  }

  public async turnSteer(
    params: TurnSteerParams & { clientUserMessageId: string },
    precondition: GenerationPrecondition,
  ): Promise<TurnSteerSubmissionResult> {
    const clientUserMessageId = identifierSchema.parse(
      params.clientUserMessageId,
    );
    const generation = precondition.expectedGeneration;
    try {
      const response = this.#parse(
        turnSteerResponseSchema,
        await this.rpc.request(
          "turn/steer",
          {
            ...params,
            clientUserMessageId,
          },
          precondition,
        ),
      );
      if (response.turnId !== params.expectedTurnId) {
        throw new CodexAppServerProtocolError();
      }
      return { state: "accepted", response };
    } catch (error) {
      if (
        (error instanceof CodexAppServerConnectionClosedError ||
          error instanceof CodexAppServerRequestTimeoutError) &&
        error.requestWasWritten
      ) {
        return {
          state: "uncertain_submission",
          threadId: params.threadId,
          expectedTurnId: params.expectedTurnId,
          clientUserMessageId,
          generation,
        };
      }
      throw error;
    }
  }

  public async turnInterrupt(
    params: TurnInterruptParams,
    precondition: GenerationPrecondition,
  ): Promise<CodexAppServerTurnInterruptResult> {
    return this.#parse(
      turnInterruptResponseSchema,
      await this.rpc.request("turn/interrupt", params, precondition),
    );
  }

  #parse<Schema extends z.ZodType>(
    schema: Schema,
    value: unknown,
  ): z.infer<Schema> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new CodexAppServerProtocolError();
    }
    return parsed.data;
  }
}
