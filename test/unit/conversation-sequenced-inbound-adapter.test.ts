import { describe, expect, it } from "vitest";

import type { EncryptedConversationInput } from "../../src/conversation/contracts.js";
import { ConversationSequencedInboundAdapter } from "../../src/db/repositories/inbound.js";

const message = {
  id: "31000000-0000-4000-8000-000000000001",
  spaceId: "31000000-0000-4000-8000-000000000002",
  externalMessageId: "provider-message",
  senderIdentityId: "31000000-0000-4000-8000-000000000003",
  contentCiphertext: "ciphertext",
  contentHash: "content-hash",
  receivedAt: new Date("2026-08-19T10:00:00Z"),
  retentionExpiresAt: new Date("2026-09-19T10:00:00Z"),
} as const;

class ConversationRepositoryFake {
  public actorCalls = 0;
  public observeCalls = 0;

  public async ingestInput(input: EncryptedConversationInput) {
    this.actorCalls += 1;
    return this.result(input, 2);
  }

  public async ingestObservedInput(input: EncryptedConversationInput) {
    this.observeCalls += 1;
    return this.result(input, 1);
  }

  private result(input: EncryptedConversationInput, actorGeneration: number) {
    return {
      status: "inserted" as const,
      input: {
        messageId: input.messageId,
        spaceId: input.spaceId,
        inputSequence: 1,
        actorGeneration,
      },
    };
  }
}

describe("ConversationSequencedInboundAdapter", () => {
  it("invokes actor ingestion through the repository instance", async () => {
    const conversations = new ConversationRepositoryFake();
    const adapter = new ConversationSequencedInboundAdapter(
      { findSpacesWithUndrainedInbound: async () => [] },
      conversations,
      "actor",
    );

    await expect(adapter.ingestAcceptedMessage(message)).resolves.toEqual({
      messageId: message.id,
      inserted: true,
    });
    expect(conversations.actorCalls).toBe(1);
    expect(conversations.observeCalls).toBe(0);
  });

  it("keeps observe ingestion on its non-authoritative repository method", async () => {
    const conversations = new ConversationRepositoryFake();
    const adapter = new ConversationSequencedInboundAdapter(
      { findSpacesWithUndrainedInbound: async () => [] },
      conversations,
      "observe",
    );

    await expect(adapter.ingestAcceptedMessage(message)).resolves.toMatchObject({
      inserted: true,
    });
    expect(conversations.actorCalls).toBe(0);
    expect(conversations.observeCalls).toBe(1);
  });
});
