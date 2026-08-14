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
    sandboxMode: "workspace-write",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "on-request",
    consequentialActions: "propose-only",
  },
} as const satisfies Record<PermissionProfileName, CodexPermissionOptions>;

export function resolvePermissionProfile(
  profile: PermissionProfileName,
): CodexPermissionOptions {
  return codexPermissionOptionsSchema.parse(PERMISSION_PROFILES[profile]);
}
