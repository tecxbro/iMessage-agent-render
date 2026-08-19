import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull } from "drizzle-orm";

import type { PostgresConversationRepository } from "./conversation-recovery.js";
import type { Database } from "../client.js";
import { messages } from "../schema.js";

export interface AcceptedInboundMessage {
  id?: string;
  spaceId: string;
  externalMessageId: string;
  senderIdentityId: string;
  contentCiphertext: string;
  contentHash: string;
  receivedAt: Date;
  retentionExpiresAt: Date;
}

export interface IngestResult {
  messageId: string;
  inserted: boolean;
}

export class InboundRepository {
  public constructor(private readonly database: Database) {}

  public async ingestAcceptedMessage(
    input: AcceptedInboundMessage,
  ): Promise<IngestResult> {
    const messageId = input.id ?? randomUUID();
    const inserted = await this.database
      .insert(messages)
      .values({
        id: messageId,
        spaceId: input.spaceId,
        externalMessageId: input.externalMessageId,
        direction: "inbound",
        senderIdentityId: input.senderIdentityId,
        contentType: "text",
        contentCiphertext: input.contentCiphertext,
        contentHash: input.contentHash,
        receivedAt: input.receivedAt,
        retentionExpiresAt: input.retentionExpiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });

    const insertedRow = inserted[0];
    if (insertedRow !== undefined) {
      return { messageId: insertedRow.id, inserted: true };
    }

    const [existing] = await this.database
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.spaceId, input.spaceId),
          eq(messages.externalMessageId, input.externalMessageId),
        ),
      )
      .limit(1);

    if (existing === undefined) {
      throw new Error(
        "Inbound message insert conflicted with an unrelated invariant. Inspect database constraints before retrying ingestion.",
      );
    }

    return { messageId: existing.id, inserted: false };
  }

  public async findSpacesWithUndrainedInbound(limit = 100): Promise<string[]> {
    const rows = await this.database
      .selectDistinct({ spaceId: messages.spaceId })
      .from(messages)
      .where(
        and(eq(messages.direction, "inbound"), isNull(messages.drainedChainId)),
      )
      .orderBy(asc(messages.spaceId))
      .limit(limit);

    return rows.map((row) => row.spaceId);
  }
}

/**
 * Cutover adapter that replaces the legacy insert with the actor repository's
 * atomic sequence assignment while retaining legacy recovery queries. Calling
 * both insert paths for one provider event is intentionally impossible here.
 */
export class ConversationSequencedInboundAdapter {
  public constructor(
    private readonly legacyQueries: Pick<
      InboundRepository,
      "findSpacesWithUndrainedInbound"
    >,
    private readonly conversations: Pick<
      PostgresConversationRepository,
      "ingestObservedInput"
    >,
  ) {}

  public async ingestAcceptedMessage(
    input: AcceptedInboundMessage,
  ): Promise<IngestResult> {
    const ingested = await this.conversations.ingestObservedInput({
      messageId: input.id ?? randomUUID(),
      spaceId: input.spaceId,
      externalMessageId: input.externalMessageId,
      senderIdentityId: input.senderIdentityId,
      contentCiphertext: input.contentCiphertext,
      contentHash: input.contentHash,
      receivedAt: input.receivedAt,
      retentionExpiresAt: input.retentionExpiresAt,
    });
    return {
      messageId: ingested.input.messageId,
      inserted: ingested.status === "inserted",
    };
  }

  public async findSpacesWithUndrainedInbound(limit = 100): Promise<string[]> {
    return this.legacyQueries.findSpacesWithUndrainedInbound(limit);
  }
}
