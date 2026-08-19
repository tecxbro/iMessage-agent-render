import { and, asc, eq, gt, isNotNull, lte } from "drizzle-orm";

import type { InteractionStartGatePort } from "../conversation/contracts.js";
import type { InteractionAuthorizationReference } from "../conversation/state.js";
import type { Database } from "../db/client.js";
import { conversationStates } from "../db/schema-fragments/conversation-actors.js";
import { ownerBindingRevisions } from "../db/schema-fragments/photon-installations.js";
import {
  channelIdentities,
  deployments,
  messages,
  owners,
  spaces,
} from "../db/schema.js";

/** Captures the currently authorized principal for a sequenced actor turn. */
export class ConversationAuthorizationGate implements InteractionStartGatePort {
  public constructor(private readonly database: Database) {}

  public async authorize(input: { spaceId: string; throughSequence: number }) {
    const rows = await this.database
      .select({
        deploymentId: spaces.deploymentId,
        deploymentStatus: deployments.status,
        ownerId: channelIdentities.ownerId,
        ownerStatus: owners.status,
        identityId: channelIdentities.id,
        revokedAt: channelIdentities.revokedAt,
        authorizationRevision: ownerBindingRevisions.ownerRevision,
      })
      .from(messages)
      .innerJoin(spaces, eq(spaces.id, messages.spaceId))
      .innerJoin(deployments, eq(deployments.id, spaces.deploymentId))
      .leftJoin(
        channelIdentities,
        eq(channelIdentities.id, messages.senderIdentityId),
      )
      .leftJoin(
        owners,
        and(
          eq(owners.id, channelIdentities.ownerId),
          eq(owners.deploymentId, spaces.deploymentId),
        ),
      )
      .innerJoin(
        conversationStates,
        eq(conversationStates.spaceId, messages.spaceId),
      )
      .leftJoin(
        ownerBindingRevisions,
        eq(ownerBindingRevisions.deploymentId, spaces.deploymentId),
      )
      .where(
        and(
          eq(messages.spaceId, input.spaceId),
          eq(messages.direction, "inbound"),
          isNotNull(messages.inputSequence),
          gt(messages.inputSequence, conversationStates.finalizedThroughSequence),
          lte(messages.inputSequence, input.throughSequence),
        ),
      )
      .orderBy(asc(messages.inputSequence), asc(messages.id));
    const principal = rows.at(-1);
    if (
      principal === undefined ||
      principal.identityId === null ||
      principal.ownerId === null ||
      principal.authorizationRevision === null ||
      principal.deploymentStatus !== "active" ||
      principal.ownerStatus !== "active" ||
      principal.revokedAt !== null ||
      rows.some(
        (row) =>
          row.deploymentId !== principal.deploymentId ||
          row.identityId === null ||
          row.ownerId === null ||
          row.ownerId !== principal.ownerId ||
          row.deploymentStatus !== "active" ||
          row.ownerStatus !== "active" ||
          row.revokedAt !== null ||
          row.authorizationRevision !== principal.authorizationRevision,
      )
    ) {
      return null;
    }
    return {
      deploymentId: principal.deploymentId,
      ownerId: principal.ownerId,
      identityId: principal.identityId,
      authorizationRevision: principal.authorizationRevision,
    };
  }

  public async revalidate(
    reference: InteractionAuthorizationReference,
  ): Promise<boolean> {
    const [row] = await this.database
      .select({
        deploymentStatus: deployments.status,
        ownerStatus: owners.status,
        ownerId: channelIdentities.ownerId,
        revokedAt: channelIdentities.revokedAt,
        authorizationRevision: ownerBindingRevisions.ownerRevision,
      })
      .from(channelIdentities)
      .innerJoin(deployments, eq(deployments.id, channelIdentities.deploymentId))
      .innerJoin(
        owners,
        and(
          eq(owners.id, channelIdentities.ownerId),
          eq(owners.deploymentId, channelIdentities.deploymentId),
        ),
      )
      .leftJoin(
        ownerBindingRevisions,
        eq(ownerBindingRevisions.deploymentId, channelIdentities.deploymentId),
      )
      .where(
        and(
          eq(channelIdentities.id, reference.identityId),
          eq(channelIdentities.deploymentId, reference.deploymentId),
        ),
      )
      .limit(1);
    return (
      row !== undefined &&
      row.ownerId === reference.ownerId &&
      row.deploymentStatus === "active" &&
      row.ownerStatus === "active" &&
      row.revokedAt === null &&
      row.authorizationRevision === reference.authorizationRevision
    );
  }
}
