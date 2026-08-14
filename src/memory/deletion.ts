import { createHash } from "node:crypto";

import { z } from "zod";

import {
  failReceiptSafely,
  type MemoryReceiptStore,
} from "./receipts.js";
import {
  type ListedMemory,
  MemoryProviderError,
  type SupermemoryPort,
  ownerContainerTag,
} from "./supermemory-client.js";

const deletionContextSchema = z.object({
  deploymentId: z.uuid(),
  ownerId: z.uuid(),
  spaceId: z.uuid(),
  chainId: z.uuid(),
});

export interface MemoryDeletionContext {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  chainId: string;
}

export interface MemoryDeletionResult {
  status: "deleted" | "already_deleted";
  receiptId: string;
  externalMemoryId: string;
}

function deletionHash(kind: "container" | "memory", identifier: string): string {
  return createHash("sha256")
    .update(`delete\0${kind}\0${identifier}`, "utf8")
    .digest("hex");
}

function failureCode(error: unknown): string {
  return error instanceof MemoryProviderError
    ? error.code
    : "MEMORY_DELETION_FAILED";
}

export async function forgetMemory(input: {
  provider: SupermemoryPort;
  receipts: MemoryReceiptStore;
  context: MemoryDeletionContext;
  externalMemoryId: string;
  signal?: AbortSignal;
}): Promise<MemoryDeletionResult> {
  const context = deletionContextSchema.parse(input.context);
  const externalMemoryId = z
    .string()
    .trim()
    .min(1)
    .max(512)
    .parse(input.externalMemoryId);
  const contentHash = deletionHash("memory", externalMemoryId);
  const existing = await input.receipts.findSucceededByContentHash(
    context.ownerId,
    contentHash,
  );
  if (existing?.externalMemoryId !== undefined) {
    return {
      status: "already_deleted",
      receiptId: existing.id,
      externalMemoryId: existing.externalMemoryId,
    };
  }

  const pending = await input.receipts.createPending({
    ownerId: context.ownerId,
    spaceId: context.spaceId,
    chainId: context.chainId,
    operation: "delete",
    contentHash,
    safeSummary: "memory:item-delete",
  });
  const containerTag = ownerContainerTag(context.deploymentId, context.ownerId);
  try {
    const result = await input.provider.forgetMemory({
      containerTag,
      memoryId: externalMemoryId,
      reason: "owner_requested_forget",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    await input.receipts.markSucceeded(pending.id, result.id);
    return {
      status: "deleted",
      receiptId: pending.id,
      externalMemoryId: result.id,
    };
  } catch (error) {
    return await failReceiptSafely(
      input.receipts,
      pending.id,
      failureCode(error),
      error,
    );
  }
}

export async function deleteOwnerMemoryContainer(input: {
  provider: SupermemoryPort;
  receipts: MemoryReceiptStore;
  context: MemoryDeletionContext;
  signal?: AbortSignal;
}): Promise<MemoryDeletionResult> {
  const context = deletionContextSchema.parse(input.context);
  const containerTag = ownerContainerTag(context.deploymentId, context.ownerId);
  const contentHash = deletionHash("container", containerTag);
  const existing = await input.receipts.findSucceededByContentHash(
    context.ownerId,
    contentHash,
  );
  if (existing?.externalMemoryId !== undefined) {
    return {
      status: "already_deleted",
      receiptId: existing.id,
      externalMemoryId: existing.externalMemoryId,
    };
  }

  const pending = await input.receipts.createPending({
    ownerId: context.ownerId,
    spaceId: context.spaceId,
    chainId: context.chainId,
    operation: "delete",
    contentHash,
    safeSummary: "memory:owner-container-delete",
  });
  try {
    const result = await input.provider.deleteContainer({
      containerTag,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    await input.receipts.markSucceeded(pending.id, result.containerTag);
    return {
      status: "deleted",
      receiptId: pending.id,
      externalMemoryId: result.containerTag,
    };
  } catch (error) {
    return await failReceiptSafely(
      input.receipts,
      pending.id,
      failureCode(error),
      error,
    );
  }
}

export async function inspectOwnerMemories(input: {
  provider: SupermemoryPort;
  receipts: MemoryReceiptStore;
  deploymentId: string;
  ownerId: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<ListedMemory[]> {
  const deploymentId = z.uuid().parse(input.deploymentId);
  const ownerId = z.uuid().parse(input.ownerId);
  const limit = z.number().int().min(1).max(100).default(20).parse(input.limit);
  const containerTag = ownerContainerTag(deploymentId, ownerId);
  if (await input.receipts.isContainerDeleted(ownerId, containerTag)) {
    return [];
  }
  const memories = await input.provider.listMemories({
    containerTag,
    limit,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const deletedIds = await input.receipts.findDeletedMemoryIds(
    ownerId,
    memories.map((memory) => memory.id),
  );
  return memories.filter(
    (memory) =>
      memory.isLatest && !memory.isForgotten && !deletedIds.has(memory.id),
  );
}
