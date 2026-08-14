import type {
  ApprovalActor,
  ApprovalService,
} from "../security/approvals.js";
import type {
  AuthorizedCommandInterceptor,
  AuthorizedSenderContext,
  InternalSpaceLookup,
} from "../security/authorize-sender.js";
import type { InboundTextForAuthorization } from "../transport/message-loop.js";

const explicitApprovalPattern = /^\/(approve|reject)\s+([a-f0-9-]{36})$/iu;
const naturalApprove = new Set(["yes", "approve", "yes, approve"]);
const naturalReject = new Set(["no", "reject", "no, reject"]);

export interface CommandResult {
  handled: boolean;
  /** Safe deterministic response; never model-generated. */
  response?: string;
  approvalChanged?: "approved" | "rejected";
  canceled?: boolean;
}

export interface CancelCurrentChain {
  cancel(ownerId: string, spaceId: string, identityId: string): Promise<boolean>;
}

export interface AuthorizedCommandHandlerOptions {
  approvals: Pick<ApprovalService, "listPending" | "respond">;
  cancellation?: CancelCurrentChain;
}

export class AuthorizedCommandHandler {
  public constructor(private readonly options: AuthorizedCommandHandlerOptions) {}

  public async handle(
    actor: ApprovalActor,
    spaceId: string,
    text: string,
  ): Promise<CommandResult> {
    const normalized = text.trim();
    const lower = normalized.toLowerCase();
    if (lower === "/cancel") {
      if (this.options.cancellation === undefined) {
        return { handled: true, response: "Nothing is configured to cancel." };
      }
      const canceled = await this.options.cancellation.cancel(
        actor.ownerId,
        spaceId,
        actor.identityId,
      );
      return {
        handled: true,
        canceled,
        response: canceled
          ? "Canceled the current task in this conversation."
          : "There is no current task to cancel in this conversation.",
      };
    }

    const explicit = explicitApprovalPattern.exec(normalized);
    const naturalStatus = naturalApprove.has(lower)
      ? "approved"
      : naturalReject.has(lower)
        ? "rejected"
        : undefined;
    if (
      (explicit !== null || naturalStatus !== undefined) &&
      (actor.role !== "owner" || !actor.canApprove)
    ) {
      return {
        handled: true,
        response: "Only the active owner may approve or reject actions.",
      };
    }
    if (explicit?.[1] !== undefined && explicit[2] !== undefined) {
      return this.respond(
        actor,
        spaceId,
        explicit[2],
        explicit[1].toLowerCase() === "approve" ? "approved" : "rejected",
      );
    }
    if (naturalStatus !== undefined) {
      const pending = await this.options.approvals.listPending(actor, spaceId);
      if (pending.length !== 1) {
        return {
          handled: true,
          response:
            pending.length === 0
              ? "There is no live approval request in this conversation."
              : "More than one approval is pending. Reply with /approve <id> or /reject <id>.",
        };
      }
      return this.respond(
        actor,
        spaceId,
        pending[0]!.id,
        naturalStatus,
      );
    }

    if (normalized.startsWith("/")) {
      return {
        handled: true,
        response:
          "Unknown command. Use /approve <id>, /reject <id>, or /cancel.",
      };
    }
    return { handled: false };
  }

  private async respond(
    actor: ApprovalActor,
    spaceId: string,
    approvalId: string,
    status: "approved" | "rejected",
  ): Promise<CommandResult> {
    const changed = await this.options.approvals.respond(
      actor,
      spaceId,
      approvalId,
      status,
    );
    return {
      handled: true,
      ...(changed ? { approvalChanged: status } : {}),
      response: changed
        ? status === "approved"
          ? `Approved ${approvalId} for one exact execution.`
          : `Rejected ${approvalId}. No action will run.`
        : "That approval is unavailable, expired, already answered, or outside this conversation.",
    };
  }
}

export interface AuthorizedInboundCommandInterceptorOptions {
  deploymentId: string;
  spaces: InternalSpaceLookup;
  handler: AuthorizedCommandHandler;
  respond(
    inbound: InboundTextForAuthorization,
    safeResponse: string,
    context: { signal?: AbortSignal },
  ): Promise<void>;
}

/** Runs recognized commands before normal ingest can supersede their chain. */
export class AuthorizedInboundCommandInterceptor
  implements AuthorizedCommandInterceptor
{
  public constructor(
    private readonly options: AuthorizedInboundCommandInterceptorOptions,
  ) {}

  public async interceptAuthorized(
    inbound: InboundTextForAuthorization,
    sender: AuthorizedSenderContext,
    context: { signal?: AbortSignal },
  ): Promise<boolean> {
    const spaceId = await this.options.spaces.findInternalSpaceId(
      this.options.deploymentId,
      inbound,
    );
    if (spaceId === undefined) {
      return false;
    }
    const result = await this.options.handler.handle(
      {
        ownerId: sender.ownerId,
        identityId: sender.identityId,
        role: sender.role,
        canApprove: sender.canApprove,
      },
      spaceId,
      inbound.text,
    );
    if (!result.handled) {
      return false;
    }
    if (result.response !== undefined) {
      await this.options.respond(inbound, result.response, context);
    }
    return true;
  }
}
