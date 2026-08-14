import type { PgBoss } from "pg-boss";

import { QUEUE_NAMES } from "./names.js";
import type {
  InboundFlushPayload,
  OutboundSendPayload,
  TurnPlanPayload,
  TurnSynthesizePayload,
} from "./payloads.js";

export interface QueuePublisher {
  scheduleInboundFlush(payload: InboundFlushPayload, debounceMs: number): Promise<void>;
  enqueueTurnPlan(payload: TurnPlanPayload): Promise<void>;
  enqueueTurnSynthesize(payload: TurnSynthesizePayload): Promise<void>;
  enqueueOutboundSend(payload: OutboundSendPayload): Promise<void>;
}

export class PgBossPublisher implements QueuePublisher {
  public constructor(
    private readonly boss: Pick<PgBoss, "send" | "upsert">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async scheduleInboundFlush(
    payload: InboundFlushPayload,
    debounceMs: number,
  ): Promise<void> {
    const startAfter = new Date(this.now().getTime() + debounceMs);
    await this.boss.upsert(
      QUEUE_NAMES.inboundFlush,
      payload,
      {
        singletonKey: `space:${payload.spaceId}`,
        startAfter,
        retryLimit: 5,
        retryDelay: 2,
        retryBackoff: true,
        expireInSeconds: 60,
      },
    );
  }

  public async enqueueTurnPlan(payload: TurnPlanPayload): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.turnPlan,
      payload,
      `chain:${payload.chainId}:plan`,
    );
  }

  public async enqueueTurnSynthesize(
    payload: TurnSynthesizePayload,
  ): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.turnSynthesize,
      payload,
      `chain:${payload.chainId}:synthesize`,
    );
  }

  public async enqueueOutboundSend(payload: OutboundSendPayload): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.outboundSend,
      payload,
      `outbound:${payload.outboundBatchId}`,
    );
  }

  private async sendSingleton(
    name:
      | typeof QUEUE_NAMES.turnPlan
      | typeof QUEUE_NAMES.turnSynthesize
      | typeof QUEUE_NAMES.outboundSend,
    payload: TurnPlanPayload | TurnSynthesizePayload | OutboundSendPayload,
    singletonKey: string,
  ): Promise<void> {
    await this.boss.send(name, payload, {
      singletonKey,
      retryLimit: 5,
      retryDelay: 2,
      retryBackoff: true,
      expireInSeconds: 900,
    });
  }
}
