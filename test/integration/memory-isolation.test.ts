import { describe, expect, it } from "vitest";

import type { MemoryCandidate } from "../../src/agent/schemas.js";
import {
  curateMemories,
  type CurationContext,
} from "../../src/memory/curator.js";
import {
  deleteOwnerMemoryContainer,
  forgetMemory,
  inspectOwnerMemories,
} from "../../src/memory/deletion.js";
import { recallMemoryContext } from "../../src/memory/recall.js";
import type {
  MemoryReceipt,
  MemoryReceiptStore,
  PendingMemoryReceipt,
} from "../../src/memory/receipts.js";
import {
  type CreatedMemory,
  type CreateMemoryInput,
  type DeleteContainerResult,
  type ListedMemory,
  type MemoryProfile,
  MemoryProviderError,
  type MemorySearchHit,
  type SupermemoryPort,
  ownerContainerTag,
} from "../../src/memory/supermemory-client.js";

const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_A = "00000000-0000-4000-8000-00000000000a";
const OWNER_B = "00000000-0000-4000-8000-00000000000b";
const DM_SPACE = "00000000-0000-4000-8000-0000000000d1";
const GROUP_SPACE = "00000000-0000-4000-8000-0000000000d2";
const CHAIN_ONE = "00000000-0000-4000-8000-000000000101";
const CHAIN_TWO = "00000000-0000-4000-8000-000000000102";

interface StoredMemory extends ListedMemory {
  containerTag: string;
}

class FakeSupermemory implements SupermemoryPort {
  readonly records = new Map<string, StoredMemory[]>();
  createCalls = 0;
  failRecallWith?: MemoryProviderError;
  returnForgottenFromSearch = false;
  private sequence = 0;

  async getOwnerProfile(containerTag: string): Promise<MemoryProfile> {
    if (this.failRecallWith !== undefined) {
      throw this.failRecallWith;
    }
    const ownerMemories = this.items(containerTag).filter(
      (memory) =>
        memory.metadata["scope"] === "owner" &&
        (this.returnForgottenFromSearch || !memory.isForgotten),
    );
    return {
      static: ownerMemories.filter((memory) => memory.isStatic).map((memory) => memory.text),
      dynamic: ownerMemories.filter((memory) => !memory.isStatic).map((memory) => memory.text),
    };
  }

  async searchMemories(input: {
    containerTag: string;
    query: string;
    limit: number;
  }): Promise<MemorySearchHit[]> {
    if (this.failRecallWith !== undefined) {
      throw this.failRecallWith;
    }
    return this.items(input.containerTag)
      .filter((memory) => this.returnForgottenFromSearch || !memory.isForgotten)
      .slice(0, input.limit)
      .map((memory) => ({
        id: memory.id,
        text: memory.text,
        similarity: 0.91,
        metadata: memory.metadata,
        updatedAt: memory.updatedAt,
      }));
  }

  async createMemories(input: {
    containerTag: string;
    memories: CreateMemoryInput[];
  }): Promise<CreatedMemory[]> {
    this.createCalls += 1;
    return input.memories.map((candidate) => {
      const id = `memory-${++this.sequence}`;
      const createdAt = `2026-08-14T12:00:${String(this.sequence).padStart(2, "0")}Z`;
      const stored: StoredMemory = {
        id,
        text: candidate.content,
        isStatic: candidate.isStatic,
        createdAt,
        version: 1,
        isLatest: true,
        isForgotten: false,
        updatedAt: createdAt,
        metadata: candidate.metadata,
        containerTag: input.containerTag,
      };
      this.items(input.containerTag).push(stored);
      return { id, text: stored.text, isStatic: stored.isStatic, createdAt };
    });
  }

  async updateMemory(input: {
    containerTag: string;
    memoryId: string;
    content: string;
    metadata: CreateMemoryInput["metadata"];
  }): Promise<CreatedMemory> {
    const original = this.items(input.containerTag).find(
      (memory) => memory.id === input.memoryId,
    );
    if (original !== undefined) {
      original.isLatest = false;
    }
    const id = `memory-${++this.sequence}`;
    const createdAt = `2026-08-14T12:01:${String(this.sequence).padStart(2, "0")}Z`;
    this.items(input.containerTag).push({
      id,
      text: input.content,
      isStatic: original?.isStatic ?? false,
      createdAt,
      version: (original?.version ?? 0) + 1,
      isLatest: true,
      isForgotten: false,
      updatedAt: createdAt,
      metadata: input.metadata,
      containerTag: input.containerTag,
    });
    return { id, text: input.content, isStatic: false, createdAt };
  }

  async forgetMemory(input: {
    containerTag: string;
    memoryId: string;
    reason: string;
  }): Promise<{ id: string; forgotten: true }> {
    const memory = this.items(input.containerTag).find(
      (candidate) => candidate.id === input.memoryId,
    );
    if (memory !== undefined) {
      memory.isForgotten = true;
    }
    return { id: input.memoryId, forgotten: true };
  }

  async listMemories(input: {
    containerTag: string;
    limit: number;
  }): Promise<ListedMemory[]> {
    return this.items(input.containerTag).slice(0, input.limit);
  }

  async deleteContainer(input: {
    containerTag: string;
  }): Promise<DeleteContainerResult> {
    const memories = this.items(input.containerTag);
    this.records.delete(input.containerTag);
    return {
      containerTag: input.containerTag,
      deletedDocumentsCount: 0,
      deletedMemoriesCount: memories.length,
    };
  }

  private items(containerTag: string): StoredMemory[] {
    let items = this.records.get(containerTag);
    if (items === undefined) {
      items = [];
      this.records.set(containerTag, items);
    }
    return items;
  }
}

class FakeReceiptStore implements MemoryReceiptStore {
  readonly receipts: MemoryReceipt[] = [];
  private sequence = 0;

  async findSucceededByContentHash(
    ownerId: string,
    contentHash: string,
  ): Promise<MemoryReceipt | undefined> {
    return this.receipts.find(
      (receipt) =>
        receipt.ownerId === ownerId &&
        receipt.contentHash === contentHash &&
        receipt.status === "succeeded",
    );
  }

  async createPending(receipt: PendingMemoryReceipt): Promise<MemoryReceipt> {
    const created: MemoryReceipt = {
      id: `receipt-${++this.sequence}`,
      ...receipt,
      status: "pending",
    };
    this.receipts.push(created);
    return created;
  }

  async markSucceeded(receiptId: string, externalMemoryId: string): Promise<void> {
    const receipt = this.required(receiptId);
    receipt.status = "succeeded";
    receipt.externalMemoryId = externalMemoryId;
  }

  async markFailed(receiptId: string): Promise<void> {
    this.required(receiptId).status = "failed";
  }

  async findDeletedMemoryIds(
    ownerId: string,
    externalMemoryIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const requested = new Set(externalMemoryIds);
    return new Set(
      this.receipts
        .filter(
          (receipt) =>
            receipt.ownerId === ownerId &&
            receipt.operation === "delete" &&
            receipt.status === "succeeded" &&
            receipt.safeSummary === "memory:item-delete" &&
            receipt.externalMemoryId !== undefined &&
            requested.has(receipt.externalMemoryId),
        )
        .map((receipt) => receipt.externalMemoryId as string),
    );
  }

  async hasSucceededDeletion(ownerId: string): Promise<boolean> {
    return this.receipts.some(
      (receipt) =>
        receipt.ownerId === ownerId &&
        receipt.operation === "delete" &&
        receipt.status === "succeeded",
    );
  }

  async isContainerDeleted(ownerId: string, containerTag: string): Promise<boolean> {
    return this.receipts.some(
      (receipt) =>
        receipt.ownerId === ownerId &&
        receipt.operation === "delete" &&
        receipt.status === "succeeded" &&
        receipt.safeSummary === "memory:owner-container-delete" &&
        receipt.externalMemoryId === containerTag,
    );
  }

  private required(receiptId: string): MemoryReceipt {
    const receipt = this.receipts.find((candidate) => candidate.id === receiptId);
    if (receipt === undefined) {
      throw new Error(`missing receipt ${receiptId}`);
    }
    return receipt;
  }
}

function context(
  ownerId: string,
  spaceId = DM_SPACE,
  chainId = CHAIN_ONE,
): CurationContext {
  return {
    deploymentId: DEPLOYMENT_ID,
    ownerId,
    spaceId,
    chainId,
    turnSucceeded: true,
  };
}

function preference(content: string): MemoryCandidate {
  return {
    kind: "preference",
    scope: "owner",
    content,
    confidence: 0.99,
    source: "authorized_user",
  };
}

function allRecalledText(result: Awaited<ReturnType<typeof recallMemoryContext>>): string {
  return [...result.ownerProfile, ...result.relevantMemories]
    .map((item) => item.text)
    .join("\n");
}

describe("Supermemory owner and context isolation", () => {
  it("derives opaque owner namespaces and never crosses two owners", async () => {
    const provider = new FakeSupermemory();
    const receipts = new FakeReceiptStore();
    expect(ownerContainerTag(DEPLOYMENT_ID, OWNER_A)).toBe(
      `imessage-agent:${DEPLOYMENT_ID}:owner:${OWNER_A}`,
    );
    expect(ownerContainerTag(DEPLOYMENT_ID, OWNER_A)).not.toBe(
      ownerContainerTag(DEPLOYMENT_ID, OWNER_B),
    );

    await curateMemories({
      provider,
      receipts,
      context: context(OWNER_A),
      candidates: [preference("Owner A prefers green interface accents.")],
    });
    await curateMemories({
      provider,
      receipts,
      context: context(OWNER_B),
      candidates: [preference("Owner B prefers blue interface accents.")],
    });

    const recalled = await recallMemoryContext({
      provider,
      receipts,
      deploymentId: DEPLOYMENT_ID,
      ownerId: OWNER_A,
      spaceId: DM_SPACE,
      query: "interface color preference",
    });
    expect(allRecalledText(recalled)).toContain("green");
    expect(allRecalledText(recalled)).not.toContain("blue");
    expect(
      [...recalled.ownerProfile, ...recalled.relevantMemories].every(
        (memory) => memory.trust === "untrusted_context",
      ),
    ).toBe(true);
  });

  it("shares owner profile across DM/group while keeping space context separate", async () => {
    const provider = new FakeSupermemory();
    const receipts = new FakeReceiptStore();
    await curateMemories({
      provider,
      receipts,
      context: context(OWNER_A, DM_SPACE),
      candidates: [
        preference("The owner prefers concise progress updates."),
        {
          kind: "project_fact",
          scope: "space",
          content: "The DM thread is planning Project Cedar.",
          confidence: 0.98,
          source: "authorized_user",
        },
      ],
    });

    const dm = await recallMemoryContext({
      provider,
      receipts,
      deploymentId: DEPLOYMENT_ID,
      ownerId: OWNER_A,
      spaceId: DM_SPACE,
      query: "current preferences and project",
    });
    const group = await recallMemoryContext({
      provider,
      receipts,
      deploymentId: DEPLOYMENT_ID,
      ownerId: OWNER_A,
      spaceId: GROUP_SPACE,
      query: "current preferences and project",
    });

    expect(allRecalledText(dm)).toContain("concise");
    expect(allRecalledText(dm)).toContain("Project Cedar");
    expect(allRecalledText(group)).toContain("concise");
    expect(allRecalledText(group)).not.toContain("Project Cedar");
  });

  it("filters temporary candidates and writes a durable preference only once", async () => {
    const provider = new FakeSupermemory();
    const receipts = new FakeReceiptStore();
    const durable = preference("The owner prefers test output summarized by failing suite.");
    const first = await curateMemories({
      provider,
      receipts,
      context: context(OWNER_A),
      candidates: [
        durable,
        {
          kind: "project_fact",
          scope: "space",
          content: "The owner is at the airport for the next 2 hours.",
          confidence: 0.99,
          source: "authorized_user",
        },
      ],
    });
    const second = await curateMemories({
      provider,
      receipts,
      context: context(OWNER_A, DM_SPACE, CHAIN_TWO),
      candidates: [durable],
    });

    expect(first.map((item) => item.status)).toEqual(["written", "filtered"]);
    expect(first[1]?.filterReason).toBe("temporary");
    expect(second[0]?.status).toBe("deduplicated");
    expect(provider.createCalls).toBe(1);
  });

  it.each([
    ["MEMORY_PROVIDER_TIMEOUT", "provider_timeout"],
    ["MEMORY_PROVIDER_RATE_LIMITED", "provider_rate_limited"],
  ] as const)(
    "degrades on %s without blocking turn planning",
    async (providerCode, degradedReason) => {
      const provider = new FakeSupermemory();
      const receipts = new FakeReceiptStore();
      provider.failRecallWith = new MemoryProviderError(
        providerCode,
        true,
        "fixture provider failure",
      );

      const recalled = await recallMemoryContext({
        provider,
        receipts,
        deploymentId: DEPLOYMENT_ID,
        ownerId: OWNER_A,
        spaceId: DM_SPACE,
        query: "anything relevant",
      });
      expect(recalled).toMatchObject({
        available: false,
        degradedReason,
        ownerProfile: [],
        relevantMemories: [],
      });
    },
  );

  it("records item deletion and suppresses stale provider recall and inspection", async () => {
    const provider = new FakeSupermemory();
    const receipts = new FakeReceiptStore();
    const projection = await curateMemories({
      provider,
      receipts,
      context: context(OWNER_A),
      candidates: [preference("The owner prefers a four-space indentation.")],
    });
    const memoryId = projection[0]?.externalMemoryId;
    expect(memoryId).toBeDefined();
    provider.returnForgottenFromSearch = true;

    const deleted = await forgetMemory({
      provider,
      receipts,
      context: context(OWNER_A),
      externalMemoryId: memoryId as string,
    });
    const recalled = await recallMemoryContext({
      provider,
      receipts,
      deploymentId: DEPLOYMENT_ID,
      ownerId: OWNER_A,
      spaceId: DM_SPACE,
      query: "indentation preference",
    });
    const inspected = await inspectOwnerMemories({
      provider,
      receipts,
      deploymentId: DEPLOYMENT_ID,
      ownerId: OWNER_A,
    });

    expect(deleted.status).toBe("deleted");
    expect(allRecalledText(recalled)).not.toContain("four-space");
    expect(inspected).toEqual([]);
    expect(
      receipts.receipts.some(
        (receipt) =>
          receipt.operation === "delete" && receipt.status === "succeeded",
      ),
    ).toBe(true);
  });

  it("deletes an owner container idempotently and blocks subsequent recall", async () => {
    const provider = new FakeSupermemory();
    const receipts = new FakeReceiptStore();
    await curateMemories({
      provider,
      receipts,
      context: context(OWNER_A),
      candidates: [preference("The owner prefers release notes in Markdown.")],
    });

    const first = await deleteOwnerMemoryContainer({
      provider,
      receipts,
      context: context(OWNER_A),
    });
    const second = await deleteOwnerMemoryContainer({
      provider,
      receipts,
      context: context(OWNER_A, DM_SPACE, CHAIN_TWO),
    });
    const recalled = await recallMemoryContext({
      provider,
      receipts,
      deploymentId: DEPLOYMENT_ID,
      ownerId: OWNER_A,
      spaceId: DM_SPACE,
      query: "release note preference",
    });

    expect(first.status).toBe("deleted");
    expect(second.status).toBe("already_deleted");
    expect(recalled.degradedReason).toBe("container_deleted");
    expect(allRecalledText(recalled)).toBe("");
  });
});
