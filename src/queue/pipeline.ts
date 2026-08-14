import type {
  AcceptedInboundMessage,
  InboundRepository,
  IngestResult,
} from "../db/repositories/inbound.js";
import type { ChainRepository } from "../db/repositories/chains.js";
import type { OutboundRepository } from "../db/repositories/outbound.js";
import type { QueuePublisher } from "./publisher.js";

export interface DurableInboundPipelineDependencies {
  inbound: Pick<
    InboundRepository,
    "ingestAcceptedMessage" | "findSpacesWithUndrainedInbound"
  >;
  chains: Pick<
    ChainRepository,
    "supersedeActiveChain" | "findQueuedChains"
  >;
  outbound: Pick<OutboundRepository, "findResumableBatchIds">;
  publisher: QueuePublisher;
  debounceMs: number;
}

export interface ReconciliationResult {
  inboundFlushesScheduled: number;
  planJobsScheduled: number;
  outboundJobsScheduled: number;
}

export class DurablePipeline {
  public constructor(
    private readonly dependencies: DurableInboundPipelineDependencies,
  ) {}

  public async ingestAndSchedule(
    input: AcceptedInboundMessage,
  ): Promise<IngestResult> {
    const result = await this.dependencies.inbound.ingestAcceptedMessage(input);
    if (result.inserted) {
      await this.dependencies.chains.supersedeActiveChain(
        input.spaceId,
        result.messageId,
      );
    }

    try {
      await this.dependencies.publisher.scheduleInboundFlush(
        { spaceId: input.spaceId },
        this.dependencies.debounceMs,
      );
    } catch (error) {
      throw new Error(
        "Inbound message is durable but its flush job could not be scheduled. Run pipeline reconciliation after queue recovery.",
        { cause: error },
      );
    }

    return result;
  }

  public async reconcile(limit = 100): Promise<ReconciliationResult> {
    const spaceIds = await this.dependencies.inbound.findSpacesWithUndrainedInbound(
      limit,
    );
    for (const spaceId of spaceIds) {
      await this.dependencies.publisher.scheduleInboundFlush(
        { spaceId },
        this.dependencies.debounceMs,
      );
    }

    const queuedChains = await this.dependencies.chains.findQueuedChains(limit);
    for (const chain of queuedChains) {
      await this.dependencies.publisher.enqueueTurnPlan({
        chainId: chain.chainId,
        expectedChainVersion: chain.version,
        expectedState: "queued",
      });
    }

    const batchIds = await this.dependencies.outbound.findResumableBatchIds(limit);
    for (const outboundBatchId of batchIds) {
      await this.dependencies.publisher.enqueueOutboundSend({
        outboundBatchId,
        expectedState: "sending",
      });
    }

    return {
      inboundFlushesScheduled: spaceIds.length,
      planJobsScheduled: queuedChains.length,
      outboundJobsScheduled: batchIds.length,
    };
  }
}
