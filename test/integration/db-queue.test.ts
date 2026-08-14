import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DurableQueue } from "../../src/queue/boss.js";
import { QUEUE_NAMES } from "../../src/queue/names.js";
import { PgBossPublisher } from "../../src/queue/publisher.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const batchId = "20000000-0000-4000-8000-000000000001";
const chainId = "20000000-0000-4000-8000-000000000002";
const spaceId = "20000000-0000-4000-8000-000000000003";

describeDatabase("pg-boss durable queue", () => {
  let queue: DurableQueue;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    queue = new DurableQueue({ connectionString: databaseUrl });
    await queue.start();
    await queue.boss.deleteAllJobs(QUEUE_NAMES.outboundSend);
    await queue.boss.deleteAllJobs(QUEUE_NAMES.turnSynthesize);
    await queue.boss.deleteAllJobs(QUEUE_NAMES.inboundFlush);
  });

  afterAll(async () => {
    await queue?.stop();
  });

  it("creates one queued outbound job for concurrent singleton sends", async () => {
    const publisher = new PgBossPublisher(queue.boss);
    await Promise.all([
      publisher.enqueueOutboundSend({
        outboundBatchId: batchId,
        expectedState: "queued",
      }),
      publisher.enqueueOutboundSend({
        outboundBatchId: batchId,
        expectedState: "queued",
      }),
    ]);

    const jobs = await queue.boss.findJobs(QUEUE_NAMES.outboundSend, {
      queued: true,
    });
    expect(
      jobs.filter(
        (job) =>
          (job.data as { outboundBatchId?: string }).outboundBatchId === batchId,
      ),
    ).toHaveLength(1);
  });

  it("keeps one movable flush schedule per space", async () => {
    const publisher = new PgBossPublisher(queue.boss);
    await Promise.all([
      publisher.scheduleInboundFlush({ spaceId }, 4_000),
      publisher.scheduleInboundFlush({ spaceId }, 4_000),
    ]);
    const resetAt = Date.now();
    await publisher.scheduleInboundFlush({ spaceId }, 5_000);

    const jobs = await queue.boss.findJobs(QUEUE_NAMES.inboundFlush, {
      queued: true,
    });
    const matching = jobs.filter(
      (job) => (job.data as { spaceId?: string }).spaceId === spaceId,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.startAfter.getTime()).toBeGreaterThanOrEqual(
      resetAt + 4_900,
    );
  });

  it("creates one synthesis job per chain", async () => {
    const publisher = new PgBossPublisher(queue.boss);
    const payload = {
      chainId,
      expectedChainVersion: 1,
      expectedState: "executing" as const,
    };
    await Promise.all([
      publisher.enqueueTurnSynthesize(payload),
      publisher.enqueueTurnSynthesize(payload),
    ]);

    const jobs = await queue.boss.findJobs(QUEUE_NAMES.turnSynthesize, {
      queued: true,
    });
    expect(
      jobs.filter(
        (job) => (job.data as { chainId?: string }).chainId === chainId,
      ),
    ).toHaveLength(1);
  });
});
