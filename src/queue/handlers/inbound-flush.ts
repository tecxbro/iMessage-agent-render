import {
  InboundFlushDeferredError,
  type ChainRepository,
} from "../../db/repositories/chains.js";
import type { QueuePublisher } from "../publisher.js";
import type { InboundFlushPayload } from "../payloads.js";

export interface InboundFlushDependencies {
  chains: Pick<ChainRepository, "flushInboundMessages">;
  publisher: Pick<QueuePublisher, "enqueueTurnPlan"> &
    Partial<Pick<QueuePublisher, "scheduleInboundFlush">>;
  deferredRetryMs?: number;
  enabled?: boolean;
  onChainsSuperseded?: (chainIds: readonly string[]) => void;
  now?: () => Date;
}

export function createInboundFlushHandler(dependencies: InboundFlushDependencies) {
  return async (payload: InboundFlushPayload): Promise<void> => {
    if (dependencies.enabled === false) return;
    // The repository atomically drains carried/current messages into one
    // versioned chain before the identifier-only planning job is published.
    let flushed: Awaited<ReturnType<ChainRepository["flushInboundMessages"]>>;
    try {
      flushed = await dependencies.chains.flushInboundMessages(
        payload.spaceId,
        dependencies.now?.() ?? new Date(),
      );
    } catch (error) {
      if (!(error instanceof InboundFlushDeferredError)) throw error;
      if (dependencies.publisher.scheduleInboundFlush === undefined) {
        throw error;
      }
      await dependencies.publisher.scheduleInboundFlush(
        payload,
        dependencies.deferredRetryMs ?? 30_000,
      );
      return;
    }
    if (flushed === null) {
      return;
    }
    if (flushed.canceledChainIds.length > 0) {
      dependencies.onChainsSuperseded?.(flushed.canceledChainIds);
    }

    await dependencies.publisher.enqueueTurnPlan({
      chainId: flushed.chainId,
      expectedChainVersion: flushed.version,
      expectedState: "queued",
    });
  };
}
