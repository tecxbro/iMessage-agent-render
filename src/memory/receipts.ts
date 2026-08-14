export type MemoryOperation = "add" | "update" | "delete" | "recall";
export type MemoryReceiptStatus = "pending" | "succeeded" | "failed";

export interface MemoryReceipt {
  id: string;
  ownerId: string;
  spaceId: string;
  chainId: string;
  operation: MemoryOperation;
  contentHash: string;
  status: MemoryReceiptStatus;
  safeSummary: string;
  externalMemoryId?: string;
}

export interface PendingMemoryReceipt {
  ownerId: string;
  spaceId: string;
  chainId: string;
  operation: MemoryOperation;
  contentHash: string;
  safeSummary: string;
}

/**
 * PostgreSQL implements this port during integration. No provider call is allowed
 * to become the operational source of truth for projection or deletion state.
 */
export interface MemoryReceiptStore {
  findSucceededByContentHash(
    ownerId: string,
    contentHash: string,
  ): Promise<MemoryReceipt | undefined>;
  createPending(receipt: PendingMemoryReceipt): Promise<MemoryReceipt>;
  markSucceeded(receiptId: string, externalMemoryId: string): Promise<void>;
  markFailed(receiptId: string, failureCode: string): Promise<void>;
  findDeletedMemoryIds(
    ownerId: string,
    externalMemoryIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
  hasSucceededDeletion(ownerId: string): Promise<boolean>;
  isContainerDeleted(ownerId: string, containerTag: string): Promise<boolean>;
}

export class MemoryReceiptError extends Error {
  readonly code = "MEMORY_RECEIPT_WRITE_FAILED";
  readonly retryable = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemoryReceiptError";
  }
}

export async function failReceiptSafely(
  store: MemoryReceiptStore,
  receiptId: string,
  failureCode: string,
  originalError: unknown,
): Promise<never> {
  try {
    await store.markFailed(receiptId, failureCode);
  } catch (receiptError) {
    throw new MemoryReceiptError(
      "The memory operation failed and its redacted failure receipt could not be stored; repair PostgreSQL before retrying.",
      { cause: new AggregateError([originalError, receiptError]) },
    );
  }
  throw originalError;
}
