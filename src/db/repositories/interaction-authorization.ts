import { and, eq, isNull } from "drizzle-orm";

import {
  interactionAuthorizationReferenceSchema,
  type InteractionAuthorizationReference,
} from "../../conversation/state.js";
import type { Database, DatabaseTransaction } from "../client.js";
import { interactionAuthorizationReferences } from "../schema-fragments/conversation-actors.js";
import {
  channelIdentities,
  deployments,
  owners,
  spaces,
} from "../schema.js";

const authorizationSelection = {
  interactionRunId: interactionAuthorizationReferences.interactionRunId,
  deploymentId: interactionAuthorizationReferences.deploymentId,
  ownerId: interactionAuthorizationReferences.ownerId,
  identityId: interactionAuthorizationReferences.identityId,
  authorizationRevision:
    interactionAuthorizationReferences.authorizationRevision,
  createdAt: interactionAuthorizationReferences.createdAt,
};

export interface CaptureInteractionAuthorizationInput {
  interactionRunId: string;
  spaceId: string;
  authorization: Omit<
    InteractionAuthorizationReference,
    "interactionRunId" | "createdAt"
  >;
}

export async function captureInteractionAuthorization(
  transaction: DatabaseTransaction,
  input: CaptureInteractionAuthorizationInput,
): Promise<InteractionAuthorizationReference> {
  const [scope] = await transaction
    .select({
      spaceDeploymentId: spaces.deploymentId,
      identityDeploymentId: channelIdentities.deploymentId,
      identityOwnerId: channelIdentities.ownerId,
    })
    .from(spaces)
    .innerJoin(
      deployments,
      and(
        eq(deployments.id, spaces.deploymentId),
        eq(deployments.status, "active"),
      ),
    )
    .innerJoin(
      channelIdentities,
      and(
        eq(channelIdentities.id, input.authorization.identityId),
        isNull(channelIdentities.revokedAt),
      ),
    )
    .innerJoin(
      owners,
      and(
        eq(owners.id, input.authorization.ownerId),
        eq(owners.deploymentId, channelIdentities.deploymentId),
        eq(owners.status, "active"),
      ),
    )
    .where(eq(spaces.id, input.spaceId))
    .limit(1);
  if (
    scope === undefined ||
    scope.spaceDeploymentId !== input.authorization.deploymentId ||
    scope.identityDeploymentId !== input.authorization.deploymentId ||
    scope.identityOwnerId !== input.authorization.ownerId
  ) {
    throw new Error(
      "Interaction authorization does not match the active deployment, owner, identity, and space. Reauthorize before creating the run.",
    );
  }

  const [inserted] = await transaction
    .insert(interactionAuthorizationReferences)
    .values({
      interactionRunId: input.interactionRunId,
      deploymentId: input.authorization.deploymentId,
      ownerId: input.authorization.ownerId,
      identityId: input.authorization.identityId,
      authorizationRevision: input.authorization.authorizationRevision,
    })
    .returning(authorizationSelection);
  if (inserted === undefined) {
    throw new Error(
      "Interaction authorization capture returned no row. Roll back the starting run and inspect database constraints.",
    );
  }
  return interactionAuthorizationReferenceSchema.parse(inserted);
}

export class InteractionAuthorizationRepository {
  public constructor(private readonly database: Database) {}

  public async loadAuthorizationReference(
    interactionRunId: string,
  ): Promise<InteractionAuthorizationReference | null> {
    const [row] = await this.database
      .select(authorizationSelection)
      .from(interactionAuthorizationReferences)
      .where(
        eq(
          interactionAuthorizationReferences.interactionRunId,
          interactionRunId,
        ),
      )
      .limit(1);
    return row === undefined
      ? null
      : interactionAuthorizationReferenceSchema.parse(row);
  }
}
