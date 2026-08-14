import { PgBoss, type Job, type QueuePolicy } from "pg-boss";

import { QUEUE_NAMES, QUEUE_NAME_VALUES, type QueueName } from "./names.js";
import {
  parseQueuePayload,
  type QueuePayloadByName,
} from "./payloads.js";

const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = {
  [QUEUE_NAMES.inboundFlush]: "stately",
  [QUEUE_NAMES.turnPlan]: "exclusive",
  [QUEUE_NAMES.taskExecute]: "exclusive",
  [QUEUE_NAMES.turnSynthesize]: "exclusive",
  [QUEUE_NAMES.outboundSend]: "exclusive",
  [QUEUE_NAMES.memoryCurate]: "exclusive",
  [QUEUE_NAMES.maintenanceRetention]: "exclusive",
  [QUEUE_NAMES.maintenanceHealth]: "exclusive",
};

export interface DurableQueueOptions {
  connectionString: string;
  schema?: string;
  onError?: (error: Error) => void;
}

export type QueueHandler<Name extends QueueName> = (
  payload: QueuePayloadByName[Name],
  signal: AbortSignal,
) => Promise<void>;

export class DurableQueue {
  public readonly boss: PgBoss;
  private started = false;

  public constructor(options: DurableQueueOptions) {
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema ?? "pgboss",
      application_name: "imessage-codex-agent-queue",
      createSchema: true,
      migrate: true,
      useListenNotify: true,
    });
    this.boss.on("error", (error) => {
      options.onError?.(
        error instanceof Error
          ? error
          : new Error("pg-boss emitted a non-Error failure"),
      );
    });
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    try {
      await this.boss.start();
      for (const name of QUEUE_NAME_VALUES) {
        await this.boss.createQueue(name, {
          policy: QUEUE_POLICIES[name],
          notify: true,
          retryLimit: 5,
          retryDelay: 2,
          retryBackoff: true,
        });
      }
      await this.boss.schedule(
        QUEUE_NAMES.maintenanceRetention,
        "0 3 * * *",
        {},
        { tz: "UTC", key: "daily-retention", singletonKey: "daily-retention" },
      );
      this.started = true;
    } catch (error) {
      await this.boss.stop({ graceful: false, timeout: 1_000 }).catch(() => {});
      throw new Error(
        "Durable queue startup failed. Verify PostgreSQL >=13, pg-boss schema permissions, and DATABASE_URL before retrying.",
        { cause: error },
      );
    }
  }

  public async registerWorker<Name extends QueueName>(
    name: Name,
    handler: QueueHandler<Name>,
    localConcurrency = 1,
  ): Promise<string> {
    if (!this.started) {
      throw new Error(
        "Cannot register a queue worker before DurableQueue.start(). Start migrations and pg-boss first.",
      );
    }

    return this.boss.work<unknown>(
      name,
      { localConcurrency, batchSize: 1 },
      async (jobs: Job<unknown>[]) => {
        const job = jobs[0];
        if (job === undefined) {
          return;
        }
        const payload = parseQueuePayload(name, job.data);
        await handler(payload, job.signal);
      },
    );
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      await this.boss.stop({ graceful: true, timeout: 25_000 });
    } finally {
      this.started = false;
    }
  }
}

export { QUEUE_POLICIES };
