import { z } from "zod";

import type {
  InteractionContext,
  InteractionRuntimeCompletion,
  InteractionRuntimePort,
  InteractionRuntimeSession,
  InteractionRuntimeStartInput,
  InteractionRuntimeSteerInput,
  InteractionRuntimeSteerReceipt,
} from "../../conversation/contracts.js";
import type { JsonValue } from "../../security/action-schema.js";
import { SecureInteractionStartGate } from "../../security/secure-interaction-start-gate.js";
import type { PromptBundle } from "../../config/prompt-bundle.js";
import type { ConversationThreadRepository } from "../../db/repositories/conversation-threads.js";
import { buildPrompt } from "../prompt-builder.js";
import {
  interactionDecisionSchema,
  type InteractionDecision,
} from "../schemas.js";
import { createCodexOutputJsonSchema } from "../codex-client.js";
import type { RoutedCodexAppServerEvent } from "./event-router.js";
import type { CodexAppServerInteractionHandle } from "./event-router.js";
import type { CodexAppServerInteractionClient } from "./interaction-client.js";
import type { CodexAppServerSupervisor } from "./supervisor.js";

const completionSchema = z
  .object({
    threadId: z.string().trim().min(1).max(512),
    turn: z
      .object({
        id: z.string().trim().min(1).max(512),
        status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
        items: z.array(
          z
            .object({
              type: z.string(),
              text: z.string().optional(),
            })
            .passthrough(),
        ),
        completedAt: z.number().finite().nullable(),
        durationMs: z.number().finite().nonnegative().nullable(),
        error: z.unknown().nullable(),
      })
      .passthrough(),
  })
  .passthrough();

interface PendingInteraction {
  readonly run: InteractionRuntimeStartInput["run"];
  readonly promise: Promise<InteractionRuntimeCompletion>;
  readonly resolve: (completion: InteractionRuntimeCompletion) => void;
  readonly reject: (error: unknown) => void;
  handle?: CodexAppServerInteractionHandle;
  settled: boolean;
  synthesizingTasks: boolean;
}

export interface CodexAppServerActorRuntimeOptions {
  supervisor: Pick<CodexAppServerSupervisor, "generation"> & {
    interactionClient: Pick<
      CodexAppServerInteractionClient,
      | "threadStart"
      | "threadResume"
      | "turnStartInteraction"
      | "turnSteer"
      | "turnInterrupt"
    >;
  };
  gate: Pick<SecureInteractionStartGate, "issuePermit">;
  threads: Pick<ConversationThreadRepository, "load" | "store">;
  promptBundle: PromptBundle;
  workingDirectory: string;
}

/** Conversation-actor runtime backed directly by the shared App Server. */
export class CodexAppServerActorRuntime implements InteractionRuntimePort {
  readonly #pending = new Map<string, PendingInteraction>();

  public constructor(
    private readonly options: CodexAppServerActorRuntimeOptions,
  ) {}

  public async start(
    input: InteractionRuntimeStartInput,
  ): Promise<InteractionRuntimeSession> {
    return await this.#startTurn(
      input,
      async (client) => {
        const persistedThreadId = await this.options.threads.load(
          input.run.spaceId,
        );
        const thread =
          persistedThreadId === null
            ? await client.threadStart({
                model: input.run.modelId,
                cwd: this.options.workingDirectory,
                approvalPolicy: "never",
                sandbox: "read-only",
                ephemeral: false,
              })
            : await client.threadResume({
                threadId: persistedThreadId,
                model: input.run.modelId,
                cwd: this.options.workingDirectory,
                approvalPolicy: "never",
                sandbox: "read-only",
              });
        await this.options.threads.store(input.run.spaceId, thread.thread.id);
        return {
          threadId: thread.thread.id,
          includeConversationHistory: persistedThreadId === null,
        };
      },
    );
  }

  public async resume(
    input: InteractionRuntimeStartInput,
  ): Promise<InteractionRuntimeSession> {
    if (input.run.threadId === null) {
      return await this.start(input);
    }
    const threadId = input.run.threadId;
    return await this.#startTurn(
      input,
      async (client) => {
        const resumed = await client.threadResume({
          threadId,
          model: input.run.modelId,
          cwd: this.options.workingDirectory,
          approvalPolicy: "never",
          sandbox: "read-only",
        });
        await this.options.threads.store(input.run.spaceId, resumed.thread.id);
        return {
          threadId: resumed.thread.id,
          includeConversationHistory: false,
        };
      },
    );
  }

  public async steer(
    input: InteractionRuntimeSteerInput,
  ): Promise<InteractionRuntimeSteerReceipt> {
    if (input.expectedTurnId === null) {
      throw new Error("An App Server steer requires an active turn ID.");
    }
    const pending = this.#pending.get(input.interactionRunId);
    if (pending === undefined) {
      throw new Error("The interaction is not registered with App Server.");
    }
    const permit = await this.options.gate.issuePermit({
      action: "turn/steer",
      spaceId: pending.run.spaceId,
      interactionRunId: input.interactionRunId,
      generation: pending.run.generation,
      selectedModelId: pending.run.modelId,
      selectedReasoningEffort: pending.run.reasoningEffort,
    });
    const target = {
      action: "turn/steer" as const,
      spaceId: pending.run.spaceId,
      interactionRunId: input.interactionRunId,
      generation: pending.run.generation,
    };
    const response = await permit.execute(target, async () =>
      await this.options.supervisor.interactionClient.turnSteer(
        {
          threadId: input.threadId,
          expectedTurnId: input.expectedTurnId!,
          clientUserMessageId: input.clientUserMessageId,
          input: [this.#textInput(this.#renderSteer(input.messages))],
        },
        { expectedGeneration: this.options.supervisor.generation() },
      ),
    );
    if (response.state !== "accepted") {
      throw new Error(
        "App Server closed after a steer was written; actor recovery must fence the uncertain submission.",
      );
    }
    return {
      turnId: response.response.turnId,
      acceptedAt: new Date(),
      lastObservedEventJson: {
        method: "turn/steer",
        submissionGeneration: input.submissionGeneration,
      },
    };
  }

  public async waitForCompletion(input: {
    interactionRunId: string;
    session: InteractionRuntimeSession;
    signal: AbortSignal;
  }): Promise<InteractionRuntimeCompletion> {
    const pending = this.#pending.get(input.interactionRunId);
    if (pending === undefined) {
      throw new Error("The interaction completion registration is missing.");
    }
    try {
      return await this.#withAbort(pending.promise, input.signal);
    } catch (error) {
      if (input.signal.aborted) {
        // Registry shutdown or a stale actor checkpoint must not leave an App
        // Server turn running after its local owner stops waiting.
        await this.cancel({
          interactionRunId: input.interactionRunId,
          session: input.session,
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (pending.settled) {
        pending.handle?.dispose();
        this.#pending.delete(input.interactionRunId);
      }
    }
  }

  public async cancel(input: {
    interactionRunId: string;
    session: InteractionRuntimeSession;
  }): Promise<void> {
    const pending = this.#pending.get(input.interactionRunId);
    if (pending === undefined) return;
    const permit = await this.options.gate.issuePermit({
      action: "turn/interrupt",
      spaceId: pending.run.spaceId,
      interactionRunId: input.interactionRunId,
      generation: pending.run.generation,
      selectedModelId: pending.run.modelId,
      selectedReasoningEffort: pending.run.reasoningEffort,
    });
    try {
      await permit.execute(
        {
          action: "turn/interrupt",
          spaceId: pending.run.spaceId,
          interactionRunId: input.interactionRunId,
          generation: pending.run.generation,
        },
        async () => {
          await this.options.supervisor.interactionClient.turnInterrupt(
            { threadId: input.session.threadId, turnId: input.session.turnId },
            { expectedGeneration: this.options.supervisor.generation() },
          );
        },
      );
    } finally {
      this.#finish(
        input.interactionRunId,
        new DOMException("Interaction canceled.", "AbortError"),
      );
      this.#pending.delete(input.interactionRunId);
    }
  }

  async #startTurn(
    input: InteractionRuntimeStartInput,
    prepareThread: (
      client: CodexAppServerActorRuntimeOptions["supervisor"]["interactionClient"],
    ) => Promise<{
      threadId: string;
      includeConversationHistory: boolean;
    }>,
  ): Promise<InteractionRuntimeSession> {
    input.signal.throwIfAborted();
    const permit = await this.options.gate.issuePermit({
      action: "turn/start",
      spaceId: input.run.spaceId,
      interactionRunId: input.run.id,
      generation: input.run.generation,
      selectedModelId: input.run.modelId,
      selectedReasoningEffort: input.run.reasoningEffort,
    });
    const pending = this.#createPending(input.run);
    pending.synthesizingTasks = input.context.taskResults.length > 0;
    this.#pending.set(input.run.id, pending);
    try {
      const submission = await permit.execute(
        {
          action: "turn/start",
          spaceId: input.run.spaceId,
          interactionRunId: input.run.id,
          generation: input.run.generation,
        },
        async () => {
          const client = this.options.supervisor.interactionClient;
          const preparedThread = await prepareThread(client);
          const threadId = preparedThread.threadId;
          const generation = this.options.supervisor.generation();
          const started = await client.turnStartInteraction(
            {
              threadId,
              clientUserMessageId:
                input.context.messages.at(-1)?.messageId ?? input.run.id,
              input: [
                this.#textInput(
                  this.#buildTurnPrompt(
                    input.context,
                    preparedThread.includeConversationHistory,
                  ),
                ),
              ],
              cwd: this.options.workingDirectory,
              approvalPolicy: "never",
              sandboxPolicy: { type: "readOnly", networkAccess: false },
              model: input.run.modelId,
              effort: input.run.reasoningEffort,
              outputSchema: createCodexOutputJsonSchema(interactionDecisionSchema) as JsonValue,
            },
            {
              interactionRunId: input.run.id,
              generation,
              onEvent: (event) => this.#onEvent(event),
              onProcessClosed: () => {
                this.#finish(
                  input.run.id,
                  new Error("Codex App Server closed before interaction completion."),
                );
              },
            },
          );
          return { threadId, started };
        },
      );
      const { threadId, started } = submission;
      pending.handle = started.interaction;
      if (started.response.turn.status !== "inProgress") {
        this.#consumeCompletion(input.run.id, {
          method: "turn/completed",
          params: { threadId, turn: started.response.turn },
        });
      }
      return { threadId, turnId: started.response.turn.id };
    } catch (error) {
      permit.dispose();
      this.#finish(input.run.id, error);
      this.#pending.delete(input.run.id);
      throw error;
    }
  }

  #createPending(run: InteractionRuntimeStartInput["run"]): PendingInteraction {
    let resolve!: (completion: InteractionRuntimeCompletion) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<InteractionRuntimeCompletion>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void promise.catch(() => undefined);
    return {
      run,
      promise,
      resolve,
      reject,
      settled: false,
      synthesizingTasks: false,
    };
  }

  #onEvent(event: RoutedCodexAppServerEvent): void {
    if (event.notification.method === "turn/completed") {
      this.#consumeCompletion(event.interactionRunId, event.notification);
    }
  }

  #consumeCompletion(
    interactionRunId: string,
    notification: { method: string; params: unknown },
  ): void {
    const pending = this.#pending.get(interactionRunId);
    if (pending === undefined || pending.settled) return;
    try {
      const completed = completionSchema.parse(notification.params);
      if (completed.turn.status !== "completed") {
        throw new Error(`Interaction turn ended as ${completed.turn.status}.`);
      }
      const output = [...completed.turn.items]
        .reverse()
        .find((item) => item.type === "agentMessage" && item.text !== undefined)
        ?.text;
      if (output === undefined) {
        throw new Error("Interaction completion contained no structured agent message.");
      }
      const decision = interactionDecisionSchema.parse(JSON.parse(output) as unknown);
      if (
        pending.synthesizingTasks &&
        decision.mode !== "direct" &&
        decision.mode !== "confirm"
      ) {
        throw new Error(
          "Task-result synthesis must finish with a direct or confirmation decision.",
        );
      }
      const completion = this.#completionFromDecision(completed, decision);
      pending.settled = true;
      pending.resolve(completion);
      pending.handle?.dispose();
    } catch (error) {
      this.#finish(interactionRunId, error);
    }
  }

  #completionFromDecision(
    completed: z.infer<typeof completionSchema>,
    decision: InteractionDecision,
  ): InteractionRuntimeCompletion {
    return {
      threadId: completed.threadId,
      turnId: completed.turn.id,
      decisionMetadataJson: {
        mode: decision.mode,
        statusMessage: decision.statusMessage,
        tasks: decision.tasks,
        waitForTasks: decision.waitForTasks,
        memoryCandidates: decision.memoryCandidates,
      } as Readonly<Record<string, JsonValue>>,
      draftOutput: decision.userMessage,
      lastObservedEventJson: {
        method: "turn/completed",
        status: completed.turn.status,
        completedAt: completed.turn.completedAt,
        durationMs: completed.turn.durationMs,
      },
    };
  }

  #finish(interactionRunId: string, error: unknown): void {
    const pending = this.#pending.get(interactionRunId);
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    pending.reject(error);
    pending.handle?.dispose();
  }

  #buildTurnPrompt(
    context: InteractionContext,
    includeConversationHistory: boolean,
  ): string {
    return buildPrompt({
      title: "Private iMessage interaction turn",
      sections: [
        {
          name: "Interaction system policy",
          trust: "trusted-policy",
          content: this.options.promptBundle.prompts["interaction.system.md"].content,
        },
        {
          name: "Voice policy",
          trust: "trusted-policy",
          content: this.options.promptBundle.prompts["voice-policy.md"].content,
        },
        ...(context.taskResults.length === 0
          ? []
          : [
              {
                name: "Task synthesis policy",
                trust: "trusted-policy" as const,
                content:
                  "The delegated tasks for this interaction are terminal. Synthesize their supplied results now. Return direct or confirm; do not delegate another task graph.",
              },
            ]),
        {
          name: "Current inbound messages",
          trust: "untrusted-context",
          content: JSON.stringify(context.messages.map((message) => message.text), null, 2),
        },
        ...(includeConversationHistory
          ? [
              {
                name: "Conversation history",
                trust: "untrusted-context" as const,
                content: JSON.stringify(context.conversationHistory, null, 2),
              },
            ]
          : []),
        {
          name: "Task results",
          trust: "untrusted-context",
          content: JSON.stringify(context.taskResults, null, 2),
        },
      ],
    }).content;
  }

  #renderSteer(messages: InteractionRuntimeSteerInput["messages"]): string {
    return buildPrompt({
      title: "Additional inbound messages",
      sections: [
        {
          name: "Late user input",
          trust: "untrusted-context",
          content: JSON.stringify(messages.map((message) => message.text), null, 2),
        },
      ],
    }).content;
  }

  #textInput(text: string) {
    return { type: "text" as const, text, text_elements: [] };
  }

  async #withAbort<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
    signal.throwIfAborted();
    return await new Promise<Value>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      void promise.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", aborted);
      });
    });
  }
}
