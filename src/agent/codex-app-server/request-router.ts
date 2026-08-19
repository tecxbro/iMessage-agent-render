import { z } from "zod";

import type { ApplyPatchApprovalResponse } from "./generated/ApplyPatchApprovalResponse.js";
import type { ExecCommandApprovalResponse } from "./generated/ExecCommandApprovalResponse.js";
import type { ServerRequest } from "./generated/ServerRequest.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse.js";
import type { McpServerElicitationRequestResponse } from "./generated/v2/McpServerElicitationRequestResponse.js";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse.js";
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse.js";
import type { JsonValue } from "./generated/serde_json/JsonValue.js";
import type {
  AppServerRequest,
  AppServerRequestResolution,
} from "./protocol.js";

type ServerRequestByMethod<Method extends ServerRequest["method"]> = Extract<
  ServerRequest,
  { method: Method }
>;

export type ApprovalServerRequest = ServerRequestByMethod<
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "applyPatchApproval"
  | "execCommandApproval"
>;

export type ElicitationServerRequest = ServerRequestByMethod<
  "mcpServer/elicitation/request"
>;

export type UserInputServerRequest = ServerRequestByMethod<
  "item/tool/requestUserInput"
>;

export type ApprovalServerResponse =
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse
  | ApplyPatchApprovalResponse
  | ExecCommandApprovalResponse;

type DecisionProvenance = "authorized_user" | "application_policy";

/**
 * An opaque decision issued by application code. The router additionally
 * verifies the object identity against a private WeakMap, so a handler cannot
 * manufacture provenance by casting a public string-valued property.
 */
export interface CodeOwnedServerDecision<Result> {
  readonly result: Result;
}

const issuedDecisionProvenance = new WeakMap<object, DecisionProvenance>();

function issueDecision<Result>(
  provenance: DecisionProvenance,
  result: Result,
): CodeOwnedServerDecision<Result> {
  const decision = Object.freeze({ result });
  issuedDecisionProvenance.set(decision, provenance);
  return decision;
}

export function authorizedUserDecision<Result>(
  result: Result,
): CodeOwnedServerDecision<Result> {
  return issueDecision("authorized_user", result);
}

export function applicationPolicyDecision<Result>(
  result: Result,
): CodeOwnedServerDecision<Result> {
  return issueDecision("application_policy", result);
}

export interface CodexAppServerRequestHandlers {
  approval?(request: ApprovalServerRequest): Promise<
    CodeOwnedServerDecision<ApprovalServerResponse>
  >;
  elicitation?(request: ElicitationServerRequest): Promise<
    CodeOwnedServerDecision<McpServerElicitationRequestResponse>
  >;
  userInput?(request: UserInputServerRequest): Promise<
    CodeOwnedServerDecision<ToolRequestUserInputResponse>
  >;
}

const idSchema = z.string().trim().min(1).max(512);
const pathSchema = z.string().max(32_768);
const finiteNumberSchema = z.number().finite();

function isJsonValue(value: unknown): boolean {
  const pending: Array<{ depth: number; leaving?: boolean; value: unknown }> = [
    { depth: 0, value },
  ];
  const ancestors = new WeakSet<object>();
  let visited = 0;
  let stringCodeUnits = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.leaving) {
      ancestors.delete(current.value as object);
      continue;
    }
    visited += 1;
    if (visited > 10_000 || current.depth > 64) {
      return false;
    }
    if (
      current.value === null ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "string") {
      stringCodeUnits += current.value.length;
      if (stringCodeUnits > 1_000_000) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return false;
      }
      continue;
    }
    if (typeof current.value !== "object") {
      return false;
    }
    if (ancestors.has(current.value)) {
      return false;
    }
    ancestors.add(current.value);
    pending.push({ ...current, leaving: true });
    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        pending.push({ depth: current.depth + 1, value: entry });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const key of Reflect.ownKeys(current.value)) {
      if (typeof key !== "string") {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return false;
      }
      pending.push({ depth: current.depth + 1, value: descriptor.value });
    }
  }
  return true;
}

const jsonValueSchema = z.custom<JsonValue>(
  isJsonValue,
  "Expected a bounded JSON value.",
);

const modernApprovalParamsSchema = z
  .object({
    threadId: idSchema,
    turnId: idSchema,
    itemId: idSchema,
    startedAtMs: z.number().int().nonnegative(),
  })
  .strict();

const legacyApprovalParamsSchema = z
  .object({
    conversationId: idSchema,
    callId: idSchema,
  })
  .strict();

const networkPolicyAmendmentSchema = z
  .object({ host: z.string(), action: z.enum(["allow", "deny"]) })
  .strict();

const commandActionSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("read"), command: z.string(), name: z.string(), path: pathSchema })
    .strict(),
  z
    .object({ type: z.literal("listFiles"), command: z.string(), path: pathSchema.nullable() })
    .strict(),
  z
    .object({
      type: z.literal("search"),
      command: z.string(),
      query: z.string().nullable(),
      path: pathSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("unknown"), command: z.string() }).strict(),
]);

const commandApprovalParamsSchema = modernApprovalParamsSchema.extend({
  approvalId: idSchema.nullable().optional(),
  environmentId: idSchema.nullable(),
  reason: z.string().nullable().optional(),
  networkApprovalContext: z
    .object({
      host: z.string(),
      protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
    })
    .strict()
    .nullable()
    .optional(),
  command: z.string().nullable().optional(),
  cwd: pathSchema.nullable().optional(),
  commandActions: z.array(commandActionSchema).nullable().optional(),
  proposedExecpolicyAmendment: z.array(z.string()).nullable().optional(),
  proposedNetworkPolicyAmendments: z
    .array(networkPolicyAmendmentSchema)
    .nullable()
    .optional(),
});

const fileChangeApprovalParamsSchema = modernApprovalParamsSchema.extend({
  reason: z.string().nullable().optional(),
  grantRoot: pathSchema.nullable().optional(),
});

const fileSystemSpecialPathSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z.object({ kind: z.literal("minimal") }).strict(),
  z
    .object({ kind: z.literal("project_roots"), subpath: pathSchema.nullable() })
    .strict(),
  z.object({ kind: z.literal("tmpdir") }).strict(),
  z.object({ kind: z.literal("slash_tmp") }).strict(),
  z
    .object({
      kind: z.literal("unknown"),
      path: pathSchema,
      subpath: pathSchema.nullable(),
    })
    .strict(),
]);

const fileSystemPathSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: pathSchema }).strict(),
  z.object({ type: z.literal("glob_pattern"), pattern: z.string() }).strict(),
  z
    .object({ type: z.literal("special"), value: fileSystemSpecialPathSchema })
    .strict(),
]);

const fileSystemSandboxEntrySchema = z
  .object({
    path: fileSystemPathSchema,
    access: z.enum(["read", "write", "deny"]),
  })
  .strict();

const fileSystemPermissionsSchema = z
  .object({
    read: z.array(pathSchema).nullable(),
    write: z.array(pathSchema).nullable(),
    globScanMaxDepth: z.number().int().nonnegative().optional(),
    entries: z.array(fileSystemSandboxEntrySchema).optional(),
  })
  .strict();

const networkPermissionsSchema = z
  .object({ enabled: z.boolean().nullable() })
  .strict();

const permissionsApprovalParamsSchema = modernApprovalParamsSchema.extend({
  environmentId: idSchema.nullable(),
  cwd: pathSchema.min(1),
  reason: z.string().nullable(),
  permissions: z
    .object({
      network: networkPermissionsSchema.nullable(),
      fileSystem: fileSystemPermissionsSchema.nullable(),
    })
    .strict(),
});

const fileChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), content: z.string() }).strict(),
  z.object({ type: z.literal("delete"), content: z.string() }).strict(),
  z
    .object({
      type: z.literal("update"),
      unified_diff: z.string(),
      move_path: pathSchema.nullable(),
    })
    .strict(),
]);

const applyPatchApprovalParamsSchema = legacyApprovalParamsSchema.extend({
  fileChanges: z.record(z.string(), fileChangeSchema),
  reason: z.string().nullable(),
  grantRoot: z.string().nullable(),
});

const execCommandApprovalParamsSchema = legacyApprovalParamsSchema.extend({
  approvalId: z.string().nullable(),
  command: z.array(z.string()),
  cwd: z.string().trim().min(1),
  reason: z.string().nullable(),
  parsedCmd: z.array(
    z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("read"),
          cmd: z.string(),
          name: z.string(),
          path: pathSchema,
        })
        .strict(),
      z
        .object({
          type: z.literal("list_files"),
          cmd: z.string(),
          path: pathSchema.nullable(),
        })
        .strict(),
      z
        .object({
          type: z.literal("search"),
          cmd: z.string(),
          query: z.string().nullable(),
          path: pathSchema.nullable(),
        })
        .strict(),
      z.object({ type: z.literal("unknown"), cmd: z.string() }).strict(),
    ]),
  ),
});

const userInputParamsSchema = z
  .object({
    threadId: idSchema,
    turnId: idSchema,
    itemId: idSchema,
    questions: z.array(
      z
        .object({
          id: idSchema,
          header: z.string(),
          question: z.string(),
          isOther: z.boolean(),
          isSecret: z.boolean(),
          options: z
            .array(
              z
                .object({ label: z.string(), description: z.string() })
                .strict(),
            )
            .nullable(),
        })
        .strict(),
    ),
    isBlocking: z.boolean(),
    autoResolutionMs: z.number().int().nonnegative().nullable(),
  })
  .strict();

const mcpElicitationConstOptionSchema = z
  .object({ const: z.string(), title: z.string() })
  .strict();
const mcpElicitationCommonFields = {
  title: z.string().optional(),
  description: z.string().optional(),
};
const mcpElicitationStringSchema = z
  .object({
    type: z.literal("string"),
    ...mcpElicitationCommonFields,
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    default: z.string().optional(),
  })
  .strict();
const mcpElicitationNumberSchema = z
  .object({
    type: z.enum(["number", "integer"]),
    ...mcpElicitationCommonFields,
    minimum: finiteNumberSchema.optional(),
    maximum: finiteNumberSchema.optional(),
    default: finiteNumberSchema.optional(),
  })
  .strict();
const mcpElicitationBooleanSchema = z
  .object({
    type: z.literal("boolean"),
    ...mcpElicitationCommonFields,
    default: z.boolean().optional(),
  })
  .strict();
const mcpElicitationEnumSchema = z.union([
  z
    .object({
      type: z.literal("string"),
      ...mcpElicitationCommonFields,
      enum: z.array(z.string()),
      enumNames: z.array(z.string()).optional(),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("string"),
      ...mcpElicitationCommonFields,
      oneOf: z.array(mcpElicitationConstOptionSchema),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("array"),
      ...mcpElicitationCommonFields,
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      items: z
        .union([
          z
            .object({ type: z.literal("string"), enum: z.array(z.string()) })
            .strict(),
          z
            .object({ anyOf: z.array(mcpElicitationConstOptionSchema) })
            .strict(),
        ]),
      default: z.array(z.string()).optional(),
    })
    .strict(),
]);
const mcpElicitationPrimitiveSchema = z.union([
  mcpElicitationEnumSchema,
  mcpElicitationStringSchema,
  mcpElicitationNumberSchema,
  mcpElicitationBooleanSchema,
]);
const mcpElicitationSchema = z
  .object({
    $schema: z.string().optional(),
    type: z.literal("object"),
    properties: z.record(z.string(), mcpElicitationPrimitiveSchema),
    required: z.array(z.string()).optional(),
  })
  .strict();

const elicitationCommonFields = {
  threadId: idSchema,
  turnId: idSchema.nullable(),
  serverName: idSchema,
  _meta: jsonValueSchema.nullable(),
  message: z.string(),
};
const elicitationParamsSchema = z.discriminatedUnion("mode", [
  z
    .object({
      ...elicitationCommonFields,
      mode: z.literal("form"),
      requestedSchema: mcpElicitationSchema,
    })
    .strict(),
  z
    .object({
      ...elicitationCommonFields,
      mode: z.literal("openai/form"),
      requestedSchema: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      ...elicitationCommonFields,
      mode: z.literal("url"),
      url: z.url(),
      elicitationId: idSchema,
    })
    .strict(),
]);

const commandDecisionSchema = z.union([
  z.literal("accept"),
  z.literal("acceptForSession"),
  z.literal("decline"),
  z.literal("cancel"),
  z
    .object({
      acceptWithExecpolicyAmendment: z
        .object({ execpolicy_amendment: z.array(z.string()) })
        .strict(),
    })
    .strict(),
  z
    .object({
      applyNetworkPolicyAmendment: z
        .object({ network_policy_amendment: networkPolicyAmendmentSchema })
        .strict(),
    })
    .strict(),
]);

const legacyDecisionSchema = z.union([
  z.literal("approved"),
  z.literal("approved_for_session"),
  z.literal("timed_out"),
  z.literal("abort"),
  z
    .object({
      approved_execpolicy_amendment: z.object({
        proposed_execpolicy_amendment: z.array(z.string()),
      }).strict(),
    })
    .strict(),
  z
    .object({
      network_policy_amendment: z
        .object({ network_policy_amendment: networkPolicyAmendmentSchema })
        .strict(),
    })
    .strict(),
  z
    .object({ denied: z.object({ rejection: z.string() }).strict() })
    .strict(),
]);

const resultSchemas: Partial<Record<ServerRequest["method"], z.ZodType>> = {
  "item/commandExecution/requestApproval": z
    .object({ decision: commandDecisionSchema })
    .strict(),
  "item/fileChange/requestApproval": z
    .object({
      decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
    })
    .strict(),
  "item/permissions/requestApproval": z
    .object({
      permissions: z
        .object({
          network: networkPermissionsSchema.optional(),
          fileSystem: fileSystemPermissionsSchema.optional(),
        })
        .strict(),
      scope: z.enum(["turn", "session"]),
      strictAutoReview: z.boolean().optional(),
    })
    .strict(),
  applyPatchApproval: z.object({ decision: legacyDecisionSchema }).strict(),
  execCommandApproval: z.object({ decision: legacyDecisionSchema }).strict(),
  "mcpServer/elicitation/request": z
    .object({
      action: z.enum(["accept", "decline", "cancel"]),
      content: jsonValueSchema.nullable(),
      _meta: jsonValueSchema.nullable(),
    })
    .strict(),
  "item/tool/requestUserInput": z
    .object({
      answers: z.record(
        z.string(),
        z.object({ answers: z.array(z.string()) }).strict(),
      ),
    })
    .strict(),
};

export class CodexAppServerRequestRouter {
  public constructor(
    private readonly handlers: CodexAppServerRequestHandlers = {},
  ) {}

  public async route(
    request: AppServerRequest,
  ): Promise<AppServerRequestResolution> {
    if (this.#isApproval(request)) {
      const paramsSchema =
        request.method === "item/commandExecution/requestApproval"
          ? commandApprovalParamsSchema
          : request.method === "item/fileChange/requestApproval"
            ? fileChangeApprovalParamsSchema
            : request.method === "item/permissions/requestApproval"
              ? permissionsApprovalParamsSchema
              : request.method === "applyPatchApproval"
                ? applyPatchApprovalParamsSchema
                : execCommandApprovalParamsSchema;
      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) {
        return this.#rejected("Approval request was malformed.");
      }
      return await this.#handle(
        this.handlers.approval,
        {
          id: request.id,
          method: request.method,
          params: parsed.data,
        } as ApprovalServerRequest,
        "No authorized approval reviewer is configured.",
      );
    }

    if (request.method === "mcpServer/elicitation/request") {
      const parsed = elicitationParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return this.#rejected("Elicitation request was malformed.");
      }
      return await this.#handle(
        this.handlers.elicitation,
        {
          id: request.id,
          method: request.method,
          params: parsed.data,
        } as ElicitationServerRequest,
        "No authorized elicitation handler is configured.",
      );
    }

    if (request.method === "item/tool/requestUserInput") {
      const parsed = userInputParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return this.#rejected("User-input request was malformed.");
      }
      return await this.#handle(
        this.handlers.userInput,
        { id: request.id, method: request.method, params: parsed.data },
        "No authorized user-input handler is configured.",
      );
    }

    return {
      error: {
        code: -32_601,
        message: `Unsupported Codex App Server request: ${request.method}`,
      },
    };
  }

  #isApproval(request: AppServerRequest): request is ApprovalServerRequest {
    return (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "item/permissions/requestApproval" ||
      request.method === "applyPatchApproval" ||
      request.method === "execCommandApproval"
    );
  }

  async #handle<Request extends ServerRequest, Result>(
    handler:
      | ((request: Request) => Promise<CodeOwnedServerDecision<Result>>)
      | undefined,
    request: Request,
    unavailableMessage: string,
  ): Promise<AppServerRequestResolution> {
    if (handler === undefined) {
      return this.#rejected(unavailableMessage);
    }
    try {
      const decision = await handler(request);
      const resultSchema = resultSchemas[request.method];
      if (
        typeof decision !== "object" ||
        decision === null ||
        issuedDecisionProvenance.get(decision) === undefined ||
        resultSchema === undefined ||
        !isJsonValue(decision.result)
      ) {
        return this.#rejected("Server request decision failed validation.");
      }
      const result = resultSchema.safeParse(decision.result);
      if (!result.success) {
        return this.#rejected("Server request decision failed validation.");
      }
      return { result: result.data };
    } catch {
      return this.#rejected("Server request was rejected by the client.");
    }
  }

  #rejected(message: string): AppServerRequestResolution {
    return { error: { code: -32_000, message } };
  }
}
