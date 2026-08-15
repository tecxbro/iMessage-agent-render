import type { Job } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import { settleQueueJob } from "../../src/queue/boss.js";
import { QUEUE_NAMES } from "../../src/queue/names.js";

const chainId = "00000000-0000-4000-8000-000000000001";

function turnPlanJob(): Job<unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    name: QUEUE_NAMES.turnPlan,
    data: {
      chainId,
      expectedChainVersion: 1,
      expectedState: "queued",
    },
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
  };
}

describe("queue worker retry classification", () => {
  it("dead-letters a non-retryable handler error instead of retrying it", async () => {
    const handler = vi.fn(async () => {
      throw Object.assign(new Error("invalid structured output schema"), {
        code: "CODEX_STRUCTURED_OUTPUT_INVALID",
        retryable: false,
      });
    });

    await expect(
      settleQueueJob(QUEUE_NAMES.turnPlan, turnPlanJob(), handler),
    ).resolves.toEqual([
      {
        id: "00000000-0000-4000-8000-000000000002",
        status: "deadletter",
        output: {
          code: "CODEX_STRUCTURED_OUTPUT_INVALID",
          retryable: false,
        },
      },
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
