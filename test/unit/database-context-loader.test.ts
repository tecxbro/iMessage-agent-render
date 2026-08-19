import { describe, expect, it, vi } from "vitest";

import { DatabaseInteractionContextLoader } from "../../src/conversation/database-context-loader.js";

describe("database interaction context loader", () => {
  it("loads the exact active suffix and bounded prior inbound history", async () => {
    const loadMessagesBySequenceRange = vi.fn(async () => [
      {
        messageId: "40000000-0000-4000-8000-000000000003",
        spaceId: "40000000-0000-4000-8000-000000000001",
        inputSequence: 3,
        senderIdentityId: "40000000-0000-4000-8000-000000000004",
        contentCiphertext: "cipher:current",
        contentHash: "hash-current",
        receivedAt: new Date("2026-08-19T10:03:00Z"),
        retentionExpiresAt: new Date("2026-09-19T10:03:00Z"),
      },
    ]);
    const loadRecentMessagesBeforeSequence = vi.fn(async () => [
      {
        messageId: "40000000-0000-4000-8000-000000000002",
        spaceId: "40000000-0000-4000-8000-000000000001",
        inputSequence: 2,
        senderIdentityId: "40000000-0000-4000-8000-000000000004",
        contentCiphertext: "cipher:prior",
        contentHash: "hash-prior",
        receivedAt: new Date("2026-08-19T10:02:00Z"),
        retentionExpiresAt: new Date("2026-09-19T10:02:00Z"),
      },
    ]);
    const loader = new DatabaseInteractionContextLoader(
      { loadMessagesBySequenceRange, loadRecentMessagesBeforeSequence },
      { decrypt: (value) => value.replace(/^cipher:/u, "") },
    );

    await expect(
      loader.load({
        spaceId: "40000000-0000-4000-8000-000000000001",
        interactionRunId: "40000000-0000-4000-8000-000000000005",
        fromSequence: 3,
        throughSequence: 3,
      }),
    ).resolves.toEqual({
      spaceId: "40000000-0000-4000-8000-000000000001",
      interactionRunId: "40000000-0000-4000-8000-000000000005",
      fromSequence: 3,
      throughSequence: 3,
      messages: [
        {
          messageId: "40000000-0000-4000-8000-000000000003",
          inputSequence: 3,
          text: "current",
        },
      ],
      conversationHistory: ["prior"],
      taskResults: [],
    });
    expect(loadMessagesBySequenceRange).toHaveBeenCalledWith({
      spaceId: "40000000-0000-4000-8000-000000000001",
      fromSequence: 3,
      throughSequence: 3,
    });
    expect(loadRecentMessagesBeforeSequence).toHaveBeenCalledWith({
      spaceId: "40000000-0000-4000-8000-000000000001",
      beforeSequence: 3,
      limit: 20,
    });
  });
});
