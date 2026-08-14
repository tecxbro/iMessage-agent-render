import type { RetentionRepository } from "../../db/repositories/retention.js";
import type { MaintenanceRetentionPayload } from "../payloads.js";

export interface RetentionHandlerDependencies {
  retention: Pick<RetentionRepository, "applyRetention">;
  rawMessageRetentionDays: number;
  failureRetentionDays: number;
  usageRetentionDays?: number;
  now?: () => Date;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}

export function createRetentionHandler(dependencies: RetentionHandlerDependencies) {
  return async (_payload: MaintenanceRetentionPayload): Promise<void> => {
    const now = dependencies.now?.() ?? new Date();
    await dependencies.retention.applyRetention({
      rawContentBefore: daysBefore(now, dependencies.rawMessageRetentionDays),
      failuresBefore: daysBefore(now, dependencies.failureRetentionDays),
      usageBefore: daysBefore(now, dependencies.usageRetentionDays ?? 90),
    });
  };
}
