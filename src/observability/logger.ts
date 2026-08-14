import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

export const REDACTED_VALUE = "[Redacted]";

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

const sensitiveKeys = new Set([
  "password",
  "secret",
  "token",
  "authorization",
  "apikey",
  "authjson",
  "databaseurl",
  "openaiapikey",
  "spectrumprojectsecret",
  "supermemoryapikey",
  "appencryptionkey",
  "environment",
  "env",
  "text",
  "body",
  "content",
  "rawmessage",
  "messagebody",
  "prompt",
  "commandoutput",
  "sender",
  "senderhandle",
  "emailaddress",
  "phonenumber",
]);

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const phonePattern = /(?<![\w-])\+[1-9]\d{7,14}(?![\w-])/gu;
const formattedPhonePattern =
  /(?<![\w-])(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])/gu;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const openAiKeyPattern = /\bsk-[A-Za-z0-9_-]{12,}\b/gu;
const databaseUrlPattern = /\bpostgres(?:ql)?:\/\/[^\s]+/giu;
const credentialUrlPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const assignmentTokenPattern =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret)=([^\s&]+)/giu;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return sensitiveKeys.has(normalizeKey(key));
}

export function redactSensitiveString(value: string): string {
  return value
    .replace(bearerPattern, REDACTED_VALUE)
    .replace(openAiKeyPattern, REDACTED_VALUE)
    .replace(databaseUrlPattern, REDACTED_VALUE)
    .replace(credentialUrlPattern, `$1${REDACTED_VALUE}@`)
    .replace(assignmentTokenPattern, `$1=${REDACTED_VALUE}`)
    .replace(emailPattern, REDACTED_VALUE)
    .replace(formattedPhonePattern, REDACTED_VALUE)
    .replace(phonePattern, REDACTED_VALUE);
}

function redactLogValueInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    return {
      type: value.name,
      message: redactSensitiveString(value.message),
      stack:
        value.stack === undefined
          ? undefined
          : redactSensitiveString(value.stack),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValueInternal(entry, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key)
      ? REDACTED_VALUE
      : redactLogValueInternal(entry, seen);
  }
  return redacted;
}

export function redactLogValue(value: unknown): unknown {
  return redactLogValueInternal(value, new WeakSet<object>());
}

export interface StructuredLoggerOptions {
  level?: string;
  base?: Record<string, unknown> | null;
}

export function createLogger(
  options: StructuredLoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? "info",
    base: options.base ?? { service: "imessage-codex-agent" },
    redact: {
      paths: [...PINO_REDACTION_PATHS],
      censor: REDACTED_VALUE,
    },
    formatters: {
      log(object) {
        return redactLogValue(object) as Record<string, unknown>;
      },
    },
    hooks: {
      logMethod(arguments_, method) {
        const redactedArguments = arguments_.map((argument) =>
          redactLogValue(argument),
        ) as Parameters<typeof method>;
        method.apply(this, redactedArguments);
      },
    },
    serializers: {
      err: (error) => redactLogValue(error),
    },
  };

  return destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, destination);
}

export const logger = createLogger();
