import { and, asc, eq, gt, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";

import {
  modelIdentifierSchema,
  reasoningEffortSchema,
} from "../config/model-profiles.js";
import type { InteractionRunState } from "../conversation/state.js";
import type { Database, DatabaseTransaction } from "../db/client.js";
import {
  conversationStates,
  interactionAuthorizationReferences,
  interactionRuns,
} from "../db/schema-fragments/conversation-actors.js";
import { modelSettingsReconciliation } from "../db/schema-fragments/model-settings-reconciliation.js";
import { ownerBindingRevisions } from "../db/schema-fragments/photon-installations.js";
import {
  channelIdentities,
  deployments,
  messages,
  owners,
} from "../db/schema.js";

export interface InteractionAuthorizationPrincipal {
  identityId: string;
  deploymentId: string;
  ownerId: string;
  revokedAt: Date | null;
}

export interface InteractionAuthorizationSnapshot {
  interactionRunId: string;
  spaceId: string;
  generation: number;
  runState: InteractionRunState;
  currentInteractionRunId: string | null;
  currentGeneration: number;
  deploymentId: string;
  deploymentStatus: "active" | "disabled" | "maintenance";
  ownerId: string;
  ownerStatus: "active" | "disabled";
  principal: InteractionAuthorizationPrincipal | null;
  capturedAuthorizationRevision: number;
  currentAuthorizationRevision: number | null;
  capturedContributorIdentityIds: readonly string[];
  unauthorizedContributorIdentityIds: readonly string[];
  capturedMessageCount: number;
  unauthorizedMessageCount: number;
  selectedModelId: string;
  selectedReasoningEffort: string;
  selectedModelAvailable: boolean;
}

export interface InteractionAuthorizationRepositoryPort {
  loadCurrent(input: {
    spaceId: string;
    interactionRunId: string;
    generation: number;
  }): Promise<InteractionAuthorizationSnapshot | null>;
}

interface ContributorRow {
  messageId: string;
  identityId: string | null;
  identityDeploymentId: string | null;
  identityOwnerId: string | null;
  revokedAt: Date | null;
}

const availableModelCatalogSchema = z
  .array(
    z
      .object({
        id: modelIdentifierSchema,
        model: modelIdentifierSchema,
        displayName: z.string().trim().min(1).max(256),
        supportedReasoningEfforts: z
          .array(
            z
              .object({
                reasoningEffort: reasoningEffortSchema,
                description: z.string().trim().max(512),
              })
              .strict(),
          )
          .min(1)
          .max(32),
        defaultReasoningEffort: reasoningEffortSchema,
        isDefault: z.boolean(),
      })
      .strict(),
  )
  .max(1_000);

function catalogSupportsSelection(
  catalog: unknown,
  modelId: string,
  reasoningEffort: string,
): boolean {
  const parsedCatalog = availableModelCatalogSchema.safeParse(catalog);
  const parsedModelId = modelIdentifierSchema.safeParse(modelId);
  const parsedEffort = reasoningEffortSchema.safeParse(reasoningEffort);
  if (!parsedCatalog.success || !parsedModelId.success || !parsedEffort.success) {
    return false;
  }
  return parsedCatalog.data.some(
    (model) =>
      model.id === parsedModelId.data &&
      model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === parsedEffort.data,
      ),
  );
}

function contributorIsAuthorized(
  row: ContributorRow,
  deploymentId: string,
  ownerId: string,
): boolean {
  return (
    row.identityId !== null &&
    row.identityDeploymentId === deploymentId &&
    row.identityOwnerId === ownerId &&
    row.revokedAt === null
  );
}

/**
 * Reads the run, immutable authorization reference, live identities, model
 * catalog, and every message contributor in one repeatable-read snapshot.
 * It does not acquire actor or row locks; the caller consumes the resulting
 * short-lived permit immediately before invoking the app-server action.
 */
export class InteractionAuthorizationRepository
  implements InteractionAuthorizationRepositoryPort
{
  public constructor(private readonly database: Database) {}

  public async loadCurrent(input: {
    spaceId: string;
    interactionRunId: string;
    generation: number;
  }): Promise<InteractionAuthorizationSnapshot | null> {
    return await this.database.transaction(
      async (transaction) => await this.loadInTransaction(transaction, input),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  private async loadInTransaction(
    transaction: DatabaseTransaction,
    input: {
      spaceId: string;
      interactionRunId: string;
      generation: number;
    },
  ): Promise<InteractionAuthorizationSnapshot | null> {
    const [row] = await transaction
      .select({
        interactionRunId: interactionRuns.id,
        spaceId: interactionRuns.spaceId,
        generation: interactionRuns.generation,
        runState: interactionRuns.state,
        acceptedThroughSequence: interactionRuns.acceptedThroughSequence,
        selectedModelId: interactionRuns.modelId,
        selectedReasoningEffort: interactionRuns.reasoningEffort,
        currentInteractionRunId: conversationStates.activeInteractionRunId,
        currentGeneration: conversationStates.actorGeneration,
        finalizedThroughSequence: conversationStates.finalizedThroughSequence,
        deploymentId: interactionAuthorizationReferences.deploymentId,
        deploymentStatus: deployments.status,
        ownerId: interactionAuthorizationReferences.ownerId,
        ownerStatus: owners.status,
        principalIdentityId: interactionAuthorizationReferences.identityId,
        principalDeploymentId: channelIdentities.deploymentId,
        principalOwnerId: channelIdentities.ownerId,
        principalRevokedAt: channelIdentities.revokedAt,
        capturedAuthorizationRevision:
          interactionAuthorizationReferences.authorizationRevision,
        currentAuthorizationRevision: ownerBindingRevisions.ownerRevision,
        modelSourceState: modelSettingsReconciliation.sourceState,
        modelCatalog: modelSettingsReconciliation.catalogJson,
      })
      .from(interactionRuns)
      .innerJoin(
        conversationStates,
        eq(conversationStates.spaceId, interactionRuns.spaceId),
      )
      .innerJoin(
        interactionAuthorizationReferences,
        eq(
          interactionAuthorizationReferences.interactionRunId,
          interactionRuns.id,
        ),
      )
      .innerJoin(
        deployments,
        eq(deployments.id, interactionAuthorizationReferences.deploymentId),
      )
      .innerJoin(
        owners,
        and(
          eq(owners.id, interactionAuthorizationReferences.ownerId),
          eq(
            owners.deploymentId,
            interactionAuthorizationReferences.deploymentId,
          ),
        ),
      )
      .leftJoin(
        channelIdentities,
        eq(channelIdentities.id, interactionAuthorizationReferences.identityId),
      )
      .leftJoin(
        ownerBindingRevisions,
        eq(
          ownerBindingRevisions.deploymentId,
          interactionAuthorizationReferences.deploymentId,
        ),
      )
      .leftJoin(
        modelSettingsReconciliation,
        eq(
          modelSettingsReconciliation.deploymentId,
          interactionAuthorizationReferences.deploymentId,
        ),
      )
      .where(
        and(
          eq(interactionRuns.id, input.interactionRunId),
          eq(interactionRuns.spaceId, input.spaceId),
          eq(interactionRuns.generation, input.generation),
        ),
      )
      .limit(1);
    if (row === undefined) return null;

    const contributorRows = await transaction
      .select({
        messageId: messages.id,
        identityId: messages.senderIdentityId,
        identityDeploymentId: channelIdentities.deploymentId,
        identityOwnerId: channelIdentities.ownerId,
        revokedAt: channelIdentities.revokedAt,
      })
      .from(messages)
      .leftJoin(
        channelIdentities,
        eq(messages.senderIdentityId, channelIdentities.id),
      )
      .where(
        and(
          eq(messages.spaceId, row.spaceId),
          eq(messages.direction, "inbound"),
          isNotNull(messages.inputSequence),
          gt(messages.inputSequence, row.finalizedThroughSequence),
          lte(messages.inputSequence, row.acceptedThroughSequence),
        ),
      )
      .orderBy(asc(messages.inputSequence), asc(messages.id));

    const unauthorizedRows = contributorRows.filter(
      (contributor) =>
        !contributorIsAuthorized(contributor, row.deploymentId, row.ownerId),
    );
    const capturedContributorIdentityIds = [
      ...new Set(
        contributorRows.flatMap((contributor) =>
          contributor.identityId === null ? [] : [contributor.identityId],
        ),
      ),
    ];
    const unauthorizedContributorIdentityIds = [
      ...new Set(
        unauthorizedRows.flatMap((contributor) =>
          contributor.identityId === null ? [] : [contributor.identityId],
        ),
      ),
    ];
    const principal =
      row.principalDeploymentId === null || row.principalOwnerId === null
        ? null
        : {
            identityId: row.principalIdentityId,
            deploymentId: row.principalDeploymentId,
            ownerId: row.principalOwnerId,
            revokedAt: row.principalRevokedAt,
          };

    return {
      interactionRunId: row.interactionRunId,
      spaceId: row.spaceId,
      generation: row.generation,
      runState: row.runState,
      currentInteractionRunId: row.currentInteractionRunId,
      currentGeneration: row.currentGeneration,
      deploymentId: row.deploymentId,
      deploymentStatus: row.deploymentStatus,
      ownerId: row.ownerId,
      ownerStatus: row.ownerStatus,
      principal,
      capturedAuthorizationRevision: row.capturedAuthorizationRevision,
      currentAuthorizationRevision: row.currentAuthorizationRevision,
      capturedContributorIdentityIds,
      unauthorizedContributorIdentityIds,
      capturedMessageCount: contributorRows.length,
      unauthorizedMessageCount: unauthorizedRows.length,
      selectedModelId: row.selectedModelId,
      selectedReasoningEffort: row.selectedReasoningEffort,
      selectedModelAvailable:
        row.modelSourceState === "available" &&
        catalogSupportsSelection(
          row.modelCatalog,
          row.selectedModelId,
          row.selectedReasoningEffort,
        ),
    };
  }
}
