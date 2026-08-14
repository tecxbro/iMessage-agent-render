import { z } from "zod";

export const PERMISSION_PROFILE_NAMES = [
  "read",
  "workspace-write",
  "network-read",
  "approval-required",
] as const;

export const permissionProfileNameSchema = z.enum(PERMISSION_PROFILE_NAMES);

export const codexPermissionOptionsSchema = z
  .object({
    sandboxMode: z.enum(["read-only", "workspace-write"]),
    networkAccessEnabled: z.boolean(),
    webSearchMode: z.enum(["disabled", "live"]),
    approvalPolicy: z.enum(["never", "on-request"]),
    consequentialActions: z.enum(["forbidden", "propose-only"]),
  })
  .strict();

export type PermissionProfileName = z.infer<
  typeof permissionProfileNameSchema
>;
export type CodexPermissionOptions = z.infer<
  typeof codexPermissionOptionsSchema
>;

export type AuthorizedSenderRole = "owner" | "collaborator";

export class PermissionEscalationError extends Error {
  public readonly code = "PERMISSION_ESCALATION_REJECTED";

  public constructor(
    public readonly requested: PermissionProfileName,
    public readonly maximum: PermissionProfileName,
  ) {
    super(
      `Permission profile ${requested} exceeds the code-authorized ${maximum} grant. Reject the task without starting Codex.`,
    );
    this.name = "PermissionEscalationError";
  }
}

export const PERMISSION_PROFILES = {
  read: {
    sandboxMode: "read-only",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    consequentialActions: "forbidden",
  },
  "workspace-write": {
    sandboxMode: "workspace-write",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    consequentialActions: "propose-only",
  },
  "network-read": {
    sandboxMode: "read-only",
    networkAccessEnabled: false,
    webSearchMode: "live",
    approvalPolicy: "never",
    consequentialActions: "forbidden",
  },
  "approval-required": {
    // This is a proposal lane, not an application approval. The model may
    // describe an exact consequential action, but only deterministic code may
    // consume the resulting database approval and execute the stored payload.
    sandboxMode: "read-only",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    consequentialActions: "propose-only",
  },
} as const satisfies Record<PermissionProfileName, CodexPermissionOptions>;

interface PermissionCapabilities {
  filesystemWrite: boolean;
  webSearch: boolean;
  mayProposeConsequentialAction: boolean;
}

const PROFILE_CAPABILITIES = {
  read: {
    filesystemWrite: false,
    webSearch: false,
    mayProposeConsequentialAction: false,
  },
  "workspace-write": {
    filesystemWrite: true,
    webSearch: false,
    mayProposeConsequentialAction: true,
  },
  "network-read": {
    filesystemWrite: false,
    webSearch: true,
    mayProposeConsequentialAction: false,
  },
  "approval-required": {
    filesystemWrite: false,
    webSearch: false,
    mayProposeConsequentialAction: true,
  },
} as const satisfies Record<PermissionProfileName, PermissionCapabilities>;

function isCapabilitySubset(
  requested: PermissionCapabilities,
  maximum: PermissionCapabilities,
): boolean {
  return (
    (!requested.filesystemWrite || maximum.filesystemWrite) &&
    (!requested.webSearch || maximum.webSearch) &&
    (!requested.mayProposeConsequentialAction ||
      maximum.mayProposeConsequentialAction)
  );
}

/**
 * Rejects model-proposed permission escalation. The maximum grant comes from
 * deterministic owner/workspace policy; it is never read from model output.
 */
export function enforcePermissionGrant(
  requested: PermissionProfileName,
  maximum: PermissionProfileName,
): PermissionProfileName {
  if (
    !isCapabilitySubset(
      PROFILE_CAPABILITIES[requested],
      PROFILE_CAPABILITIES[maximum],
    )
  ) {
    throw new PermissionEscalationError(requested, maximum);
  }
  return requested;
}

/** Collaborators are always read-only; owners still require a configured cap. */
export function maximumPermissionForRole(
  role: AuthorizedSenderRole,
  configuredOwnerMaximum: PermissionProfileName,
): PermissionProfileName {
  return role === "owner" ? configuredOwnerMaximum : "read";
}

export function resolvePermissionProfile(
  profile: PermissionProfileName,
): CodexPermissionOptions {
  return codexPermissionOptionsSchema.parse(PERMISSION_PROFILES[profile]);
}
