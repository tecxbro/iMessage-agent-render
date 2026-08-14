import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";

import {
  REDACTED_VALUE,
  createLogger,
  redactLogValue,
  redactSensitiveString,
} from "../../src/observability/logger.js";

function captureDestination(lines: string[]): DestinationStream {
  return {
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
}

describe("structured logger redaction", () => {
  it("redacts phone, email, bearer, API-key, and database URL patterns", () => {
    const input = [
      "+15551234567",
      "(415) 555-2671",
      "owner@example.com",
      "Bearer token-value.123",
      "sk-exampleSecretKey12345",
      "postgresql://agent:password@db.example.com/agent",
    ].join(" ");
    const redacted = redactSensitiveString(input);

    expect(redacted).not.toContain("+15551234567");
    expect(redacted).not.toContain("(415) 555-2671");
    expect(redacted).not.toContain("owner@example.com");
    expect(redacted).not.toContain("token-value");
    expect(redacted).not.toContain("sk-exampleSecretKey12345");
    expect(redacted).not.toContain("password@db.example.com");
    expect(redacted).toContain(REDACTED_VALUE);
  });

  it("redacts raw-message and secret fields while preserving correlation IDs", () => {
    expect(
      redactLogValue({
        chainId: "chain-safe-id",
        messageId: "message-safe-id",
        text: "private message",
        nested: {
          apiKey: "secret-key",
          safeMessage: "Provider failed safely",
        },
      }),
    ).toEqual({
      chainId: "chain-safe-id",
      messageId: "message-safe-id",
      text: REDACTED_VALUE,
      nested: {
        apiKey: REDACTED_VALUE,
        safeMessage: "Provider failed safely",
      },
    });
  });

  it("applies redaction to structured fields and bare log messages", () => {
    const lines: string[] = [];
    const testLogger = createLogger(
      { level: "info", base: null },
      captureDestination(lines),
    );

    testLogger.info(
      {
        chainId: "chain-safe-id",
        authorization: "Bearer private-token",
        rawMessage: "hello from +15551234567",
      },
      "owner owner@example.com sent a message",
    );

    const output = lines.join("");
    expect(output).toContain("chain-safe-id");
    expect(output).not.toContain("private-token");
    expect(output).not.toContain("+15551234567");
    expect(output).not.toContain("owner@example.com");
    expect(output).toContain(REDACTED_VALUE);
  });
});
