import { createHash, createHmac } from "node:crypto";

import { and, eq, isNull, notInArray } from "drizzle-orm";

import type { AuthorizedSenderContext } from "../../security/authorize-sender.js";
import { fingerprintSenderHandle } from "../../security/authorize-sender.js";
import type { InboundTextForAuthorization } from "../../transport/message-loop.js";
import type { PersistedSpaceRoute } from "../../transport/space-resolver.js";
import type { Database } from "../client.js";
import {
  channelIdentities,
  deployments,
  owners,
  spaceMembers,
  spaces,
} from "../schema.js";

export interface OperationalRepositoryOptions {
  deploymentId: string;
  ownerHandles: readonly string[];
  fingerprintKey: string;
  encrypt(plaintext: string): Promise<string> | string;
  decrypt(ciphertext: string): Promise<string> | string;
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hexadecimal = bytes.toString("hex");
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
}

function routeFingerprint(
  deploymentId: string,
  routePhone: string | undefined,
  key: string,
): string | null {
  if (routePhone === undefined) {
    return null;
  }
  return createHmac("sha256", key)
    .update("imessage-agent-route-v1\0", "utf8")
    .update(deploymentId, "utf8")
    .update("\0", "utf8")
    .update(routePhone, "utf8")
    .digest("hex");
}

export class OperationalRepository {
  public constructor(
    private readonly database: Database,
    private readonly options: OperationalRepositoryOptions,
  ) {}

  /** Seeds the single private owner and makes the current env allowlist authoritative. */
  public async provisionDeployment(): Promise<void> {
    const ownerId = stableUuid(`${this.options.deploymentId}:primary-owner`);
    await this.database.transaction(async (transaction) => {
      await transaction
        .insert(deployments)
        .values({
          id: this.options.deploymentId,
          name: "iMessage Codex agent",
          defaultModelProfile: "main",
          status: "active",
        })
        .onConflictDoUpdate({
          target: deployments.id,
          set: {
            defaultModelProfile: "main",
            updatedAt: new Date(),
          },
        });
      await transaction
        .insert(owners)
        .values({
          id: ownerId,
          deploymentId: this.options.deploymentId,
          displayName: "Owner",
          timezone: "UTC",
          status: "active",
        })
        .onConflictDoNothing();

      const fingerprints: string[] = [];
      for (const handle of this.options.ownerHandles) {
        const fingerprint = fingerprintSenderHandle(
          this.options.deploymentId,
          handle,
          this.options.fingerprintKey,
        );
        fingerprints.push(fingerprint);
        await transaction
          .insert(channelIdentities)
          .values({
            id: stableUuid(`${this.options.deploymentId}:identity:${fingerprint}`),
            deploymentId: this.options.deploymentId,
            ownerId,
            platform: "imessage",
            normalizedHandleCiphertext: await this.options.encrypt(handle),
            handleFingerprint: fingerprint,
            role: "owner",
            verifiedAt: new Date(),
            revokedAt: null,
          })
          .onConflictDoUpdate({
            target: [
              channelIdentities.deploymentId,
              channelIdentities.platform,
              channelIdentities.handleFingerprint,
            ],
            set: {
              ownerId,
              normalizedHandleCiphertext: await this.options.encrypt(handle),
              role: "owner",
              verifiedAt: new Date(),
              revokedAt: null,
              updatedAt: new Date(),
            },
          });
      }

      await transaction
        .update(channelIdentities)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(channelIdentities.deploymentId, this.options.deploymentId),
            eq(channelIdentities.platform, "imessage"),
            eq(channelIdentities.role, "owner"),
            notInArray(channelIdentities.handleFingerprint, fingerprints),
          ),
        );
    });
  }

  public async findInternalSpaceId(
    deploymentId: string,
    inbound: InboundTextForAuthorization,
  ): Promise<string | undefined> {
    const fingerprint = routeFingerprint(
      deploymentId,
      inbound.space.routePhone,
      this.options.fingerprintKey,
    );
    const [row] = await this.database
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          eq(spaces.deploymentId, deploymentId),
          eq(spaces.platform, "imessage"),
          eq(spaces.externalSpaceGuid, inbound.space.spaceGuid),
          fingerprint === null
            ? isNull(spaces.routePhoneFingerprint)
            : eq(spaces.routePhoneFingerprint, fingerprint),
        ),
      )
      .limit(1);
    return row?.id;
  }

  public async upsertAuthorizedSpace(
    inbound: InboundTextForAuthorization,
    sender: AuthorizedSenderContext,
  ): Promise<string> {
    const existing = await this.findInternalSpaceId(sender.deploymentId, inbound);
    const fingerprint = routeFingerprint(
      sender.deploymentId,
      inbound.space.routePhone,
      this.options.fingerprintKey,
    );
    const id =
      existing ??
      stableUuid(
        `${sender.deploymentId}:space:${inbound.space.spaceGuid}:${fingerprint ?? "no-route"}`,
      );
    await this.database
      .insert(spaces)
      .values({
        id,
        deploymentId: sender.deploymentId,
        platform: "imessage",
        externalSpaceGuid: inbound.space.spaceGuid,
        routePhoneCiphertext:
          inbound.space.routePhone === undefined
            ? null
            : await this.options.encrypt(inbound.space.routePhone),
        routePhoneFingerprint: fingerprint,
        type: inbound.space.spaceType,
        lastMessageAt: inbound.receivedAt,
      })
      .onConflictDoUpdate({
        target: spaces.id,
        set: {
          type: inbound.space.spaceType,
          lastMessageAt: inbound.receivedAt,
          updatedAt: new Date(),
        },
      });
    await this.database
      .insert(spaceMembers)
      .values({
        spaceId: id,
        observedHandleFingerprint: sender.handleFingerprint,
        channelIdentityId: sender.identityId,
        isAuthorized: true,
        lastSeenAt: inbound.receivedAt,
      })
      .onConflictDoUpdate({
        target: [spaceMembers.spaceId, spaceMembers.observedHandleFingerprint],
        set: {
          channelIdentityId: sender.identityId,
          isAuthorized: true,
          lastSeenAt: inbound.receivedAt,
        },
      });
    return id;
  }

  public async getPersistedRoute(spaceId: string): Promise<PersistedSpaceRoute> {
    const [row] = await this.database
      .select({
        spaceGuid: spaces.externalSpaceGuid,
        spaceType: spaces.type,
        routePhoneCiphertext: spaces.routePhoneCiphertext,
      })
      .from(spaces)
      .where(
        and(
          eq(spaces.id, spaceId),
          eq(spaces.deploymentId, this.options.deploymentId),
        ),
      )
      .limit(1);
    if (row === undefined) {
      throw new Error("The persisted outbound space no longer exists.");
    }
    return {
      spaceGuid: row.spaceGuid,
      spaceType: row.spaceType,
      ...(row.routePhoneCiphertext === null
        ? {}
        : { routePhone: await this.options.decrypt(row.routePhoneCiphertext) }),
    };
  }
}
