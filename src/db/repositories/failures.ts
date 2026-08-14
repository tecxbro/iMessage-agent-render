import { redactLogValue, redactSensitiveString } from "../../observability/logger.js";
import type { Database } from "../client.js";
import { failureEvents } from "../schema.js";

export interface FailureEventInput {
  correlationType: string;
  correlationId: string;
  component: string;
  errorCode: string;
  retryable: boolean;
  safeMessage: string;
  payloadSummary?: Record<string, unknown>;
  retentionExpiresAt: Date;
}

function boundedSummary(
  summary: Record<string, unknown> | undefined,
  protectedValues: readonly string[],
): Record<string, unknown> {
  if (summary === undefined) {
    return {};
  }

  const redacted = redactLogValue(summary, { protectedValues }) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  return serialized.length <= 8_192
    ? redacted
    : { truncated: true, byteLength: Buffer.byteLength(serialized) };
}

export class FailureRepository {
  public constructor(
    private readonly database: Database,
    private readonly protectedValues: readonly string[] = [],
  ) {}

  public async recordFailureFailSafe(input: FailureEventInput): Promise<boolean> {
    try {
      await this.database.insert(failureEvents).values({
        correlationType: input.correlationType.slice(0, 64),
        correlationId: redactSensitiveString(
          input.correlationId,
          this.protectedValues,
        ).slice(0, 256),
        component: input.component.slice(0, 64),
        errorCode: input.errorCode.slice(0, 128),
        retryable: input.retryable,
        safeMessage: redactSensitiveString(
          input.safeMessage,
          this.protectedValues,
        ).slice(0, 2_048),
        payloadSummaryJson: boundedSummary(
          input.payloadSummary,
          this.protectedValues,
        ),
        retentionExpiresAt: input.retentionExpiresAt,
      });
      return true;
    } catch {
      // Diagnostics must never replace the original pipeline failure.
      return false;
    }
  }
}
