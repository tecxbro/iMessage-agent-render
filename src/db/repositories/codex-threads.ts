import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import {
  codexThreadScopeKey,
  type CodexThreadRepository,
  type CodexThreadScope,
  type StoredCodexThread,
} from "../../agent/thread-store.js";
import type { Database } from "../client.js";
import {
  agentThreads,
  channelIdentities,
  messages,
  spaces,
} from "../schema.js";

function parseScopeKey(scopeKey: string): CodexThreadScope | undefined {
  const segments = scopeKey.split(":");
  if (
    segments[0] === "interaction" &&
    segments.length === 3 &&
    segments[1] !== undefined &&
    segments[2] !== undefined
  ) {
    return {
      kind: "interaction",
      ownerId: segments[1],
      spaceId: segments[2],
    };
  }
  if (
    segments[0] === "executor" &&
    segments.length === 4 &&
    segments[1] !== undefined &&
    segments[2] !== undefined &&
    segments[3] !== undefined
  ) {
    return {
      kind: "executor",
      ownerId: segments[1],
      agentName: segments[2],
      workspaceBinding: segments[3],
    };
  }
  return undefined;
}

export interface PostgresCodexThreadRepositoryOptions {
  encrypt(plaintext: string): Promise<string> | string;
  decrypt(ciphertext: string): Promise<string> | string;
}

export class PostgresCodexThreadRepository implements CodexThreadRepository {
  public constructor(
    private readonly database: Database,
    private readonly options: PostgresCodexThreadRepositoryOptions,
  ) {}

  public async get(scopeKey: string): Promise<StoredCodexThread | undefined> {
    const scope = parseScopeKey(scopeKey);
    if (scope === undefined) {
      throw new Error("The persisted Codex thread scope key is invalid.");
    }
    if (scope.kind === "interaction") {
      await this.assertInteractionOwner(scope.ownerId, scope.spaceId);
      const [space] = await this.database
        .select({
          threadId: spaces.interactionThreadId,
          summary: spaces.interactionSummary,
          updatedAt: spaces.updatedAt,
        })
        .from(spaces)
        .where(eq(spaces.id, scope.spaceId))
        .limit(1);
      if (
        space === undefined ||
        (space.threadId === null && space.summary === null)
      ) {
        return undefined;
      }
      return {
        scopeKey,
        scope,
        state: space.threadId === null ? "reset" : "active",
        ...(space.threadId === null ? {} : { threadId: space.threadId }),
        ...(space.summary === null
          ? {}
          : { recoverySummary: await this.options.decrypt(space.summary) }),
        generation: space.threadId === null ? 0 : 1,
        updatedAt: space.updatedAt,
      };
    }

    const [thread] = await this.database
      .select({
        threadId: agentThreads.codexThreadId,
        summary: agentThreads.summary,
        status: agentThreads.status,
        updatedAt: agentThreads.updatedAt,
      })
      .from(agentThreads)
      .where(
        and(
          eq(agentThreads.ownerId, scope.ownerId),
          eq(agentThreads.agentName, scope.agentName),
          eq(agentThreads.workspaceBinding, scope.workspaceBinding),
        ),
      )
      .limit(1);
    if (thread === undefined || thread.status === "disabled") {
      return undefined;
    }
    return {
      scopeKey,
      scope,
      state: thread.status === "reset" ? "reset" : "active",
      ...(thread.threadId === null ? {} : { threadId: thread.threadId }),
      ...(thread.summary === null
        ? {}
        : { recoverySummary: await this.options.decrypt(thread.summary) }),
      generation: thread.threadId === null ? 0 : 1,
      updatedAt: thread.updatedAt,
    };
  }

  public async save(record: StoredCodexThread): Promise<void> {
    if (codexThreadScopeKey(record.scope) !== record.scopeKey) {
      throw new Error(
        "The Codex thread record scope key does not match its structured scope.",
      );
    }
    const encryptedSummary =
      record.recoverySummary === undefined
        ? null
        : await this.options.encrypt(record.recoverySummary);
    if (record.scope.kind === "interaction") {
      await this.assertInteractionOwner(
        record.scope.ownerId,
        record.scope.spaceId,
      );
      const updated = await this.database
        .update(spaces)
        .set({
          interactionThreadId:
            record.state === "active" ? record.threadId ?? null : null,
          interactionSummary: encryptedSummary,
          updatedAt: record.updatedAt,
        })
        .where(eq(spaces.id, record.scope.spaceId))
        .returning({ id: spaces.id });
      if (updated.length !== 1) {
        throw new Error(
          "The interaction Codex thread could not be persisted. Rehydrate the space before retrying.",
        );
      }
      return;
    }

    const [existing] = await this.database
      .select({ status: agentThreads.status })
      .from(agentThreads)
      .where(
        and(
          eq(agentThreads.ownerId, record.scope.ownerId),
          eq(agentThreads.agentName, record.scope.agentName),
          eq(agentThreads.workspaceBinding, record.scope.workspaceBinding),
        ),
      )
      .limit(1);
    if (existing?.status === "disabled") {
      throw new Error(
        "The named execution context is disabled and cannot persist a Codex thread.",
      );
    }
    await this.database
      .insert(agentThreads)
      .values({
        id: randomUUID(),
        ownerId: record.scope.ownerId,
        agentName: record.scope.agentName,
        workspaceBinding: record.scope.workspaceBinding,
        codexThreadId: record.state === "active" ? record.threadId : null,
        summary: encryptedSummary,
        status: record.state,
        lastUsedAt: record.updatedAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          agentThreads.ownerId,
          agentThreads.agentName,
          agentThreads.workspaceBinding,
        ],
        set: {
          codexThreadId: record.state === "active" ? record.threadId : null,
          summary: encryptedSummary,
          status: record.state,
          lastUsedAt: record.updatedAt,
          updatedAt: record.updatedAt,
        },
      });
  }

  private async assertInteractionOwner(
    ownerId: string,
    spaceId: string,
  ): Promise<void> {
    const [authorized] = await this.database
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(
        channelIdentities,
        eq(channelIdentities.id, messages.senderIdentityId),
      )
      .where(
        and(
          eq(messages.spaceId, spaceId),
          eq(channelIdentities.ownerId, ownerId),
          isNull(channelIdentities.revokedAt),
        ),
      )
      .limit(1);
    if (authorized === undefined) {
      throw new Error(
        "The interaction thread owner is not authorized for this space.",
      );
    }
  }
}
