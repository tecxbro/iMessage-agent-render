import type { ChainRepository } from "../../db/repositories/chains.js";
import type { QueuePublisher } from "../publisher.js";
import type { InboundFlushPayload } from "../payloads.js";

export interface InboundFlushDependencies {
  chains: Pick<ChainRepository, "flushInboundMessages">;
  publisher: Pick<QueuePublisher, "enqueueTurnPlan">;
  now?: () => Date;
}

export function createInboundFlushHandler(dependencies: InboundFlushDependencies) {
  return async (payload: InboundFlushPayload): Promise<void> => {
    const flushed = await dependencies.chains.flushInboundMessages(
      payload.spaceId,
      dependencies.now?.() ?? new Date(),
    );
    if (flushed === null) {
      return;
    }

    await dependencies.publisher.enqueueTurnPlan({
      chainId: flushed.chainId,
      expectedChainVersion: flushed.version,
      expectedState: "queued",
    });
  };
}
