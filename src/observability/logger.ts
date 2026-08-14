import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

import {
  REDACTED_VALUE,
  redactLogValue,
  redactSensitiveString,
} from "../security/redaction.js";

export { REDACTED_VALUE, redactLogValue, redactSensitiveString };

export const PINO_REDACTION_PATHS = [
  "password",
  "secret",
  "token",
  "authorization",
  "apiKey",
  "authJson",
  "databaseUrl",
  "environment",
  "env",
  "*.password",
  "*.secret",
  "*.token",
  "*.authorization",
  "*.apiKey",
  "*.authJson",
  "*.databaseUrl",
  "*.environment",
  "*.env",
] as const;

export interface StructuredLoggerOptions {
  level?: string;
  base?: Record<string, unknown> | null;
  protectedValues?: readonly string[];
}

export function createLogger(
  options: StructuredLoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const redact = (value: unknown) =>
    redactLogValue(value, { protectedValues: options.protectedValues ?? [] });
  const loggerOptions: LoggerOptions = {
    level: options.level ?? "info",
    base: options.base ?? { service: "imessage-codex-agent" },
    redact: {
      paths: [...PINO_REDACTION_PATHS],
      censor: REDACTED_VALUE,
    },
    formatters: {
      log(object) {
        return redact(object) as Record<string, unknown>;
      },
    },
    hooks: {
      logMethod(arguments_, method) {
        const redactedArguments = arguments_.map(redact) as Parameters<
          typeof method
        >;
        method.apply(this, redactedArguments);
      },
    },
    serializers: {
      err: redact,
    },
  };

  return destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, destination);
}

export const logger = createLogger();
