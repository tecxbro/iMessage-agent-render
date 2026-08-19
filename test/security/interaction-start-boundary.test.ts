import { describe, expect, it, vi } from "vitest";

import type {
  InteractionAuthorizationRepositoryPort,
  InteractionAuthorizationSnapshot,
} from "../../src/security/interaction-authorization-repository.js";
import {
  InteractionPermitError,
  SecureInteractionPermit,
  SecureInteractionStartGate,
  type InteractionAppServerAction,
  type InteractionRateLimitPolicy,
  type InteractionSemaphoreLease,
  type InteractionSemaphorePort,
  type SecureInteractionPermitTarget,
  type SecureInteractionPermitRequest,
} from "../../src/security/secure-interaction-start-gate.js";

const spaceId = "00000000-0000-4000-8000-000000000001";
const interactionRunId = "00000000-0000-4000-8000-000000000002";
const deploymentId = "00000000-0000-4000-8000-000000000003";
const ownerId = "00000000-0000-4000-8000-000000000004";
const principalIdentityId = "00000000-0000-4000-8000-000000000005";
const contributorIdentityId = "00000000-0000-4000-8000-000000000006";
const now = new Date("2026-08-18T12:00:00.000Z");

function authorizedSnapshot(
  overrides: Partial<InteractionAuthorizationSnapshot> = {},
): InteractionAuthorizationSnapshot {
  return {
    interactionRunId,
    spaceId,
    generation: 3,
    runState: "starting",
    currentInteractionRunId: interactionRunId,
    currentGeneration: 3,
    deploymentId,
    deploymentStatus: "active",
    ownerId,
    ownerStatus: "active",
    principal: {
      identityId: principalIdentityId,
      deploymentId,
      ownerId,
      revokedAt: null,
    },
    capturedAuthorizationRevision: 7,
    currentAuthorizationRevision: 7,
    capturedContributorIdentityIds: [
      principalIdentityId,
      contributorIdentityId,
    ],
    unauthorizedContributorIdentityIds: [],
    capturedMessageCount: 2,
    unauthorizedMessageCount: 0,
    selectedModelId: "gpt-5.6-luna",
    selectedReasoningEffort: "high",
    selectedModelAvailable: true,
    ...overrides,
  };
}

class MutableAuthorizationRepository
  implements InteractionAuthorizationRepositoryPort
{
  public snapshot: InteractionAuthorizationSnapshot | null =
    authorizedSnapshot();

  public readonly loadCurrent = vi.fn(async () =>
    this.snapshot === null ? null : structuredClone(this.snapshot),
  );
}

class FakeSemaphore implements InteractionSemaphorePort {
  public available = true;
  public readonly release = vi.fn();
  public readonly tryAcquire = vi.fn(async () =>
    this.available
      ? ({ release: this.release } satisfies InteractionSemaphoreLease)
      : null,
  );
}

function allowedRateLimit(): ReturnType<InteractionRateLimitPolicy["consume"]> {
  return { allowed: true, remaining: 9, retryAfterMs: 0 };
}

function fixture() {
  const repository = new MutableAuthorizationRepository();
  const semaphore = new FakeSemaphore();
  const rateLimits: InteractionRateLimitPolicy = {
    consume: vi.fn(allowedRateLimit),
  };
  const gate = new SecureInteractionStartGate({
    repository,
    rateLimits,
    semaphore,
    permitTtlMs: 500,
    now: () => now,
  });
  return { gate, repository, rateLimits, semaphore };
}

function request(
  action: InteractionAppServerAction,
): SecureInteractionPermitRequest {
  return {
    action,
    spaceId,
    interactionRunId,
    generation: 3,
    selectedModelId: "gpt-5.6-luna",
    selectedReasoningEffort: "high",
  };
}

class PermitOnlyAppServer {
  public readonly actions = vi.fn(async (action: InteractionAppServerAction) =>
    `${action}:accepted`,
  );

  public async act(
    target: SecureInteractionPermitTarget,
    permit: SecureInteractionPermit,
  ): Promise<string> {
    return await permit.execute(
      target,
      async () => await this.actions(target.action),
      now,
    );
  }
}

function target(
  action: InteractionAppServerAction,
): SecureInteractionPermitTarget {
  const requested = request(action);
  return {
    action: requested.action,
    spaceId: requested.spaceId,
    interactionRunId: requested.interactionRunId,
    generation: requested.generation,
  };
}

describe("secure interaction app-server boundary", () => {
  it("blocks turn/start when the principal is revoked after ingestion", async () => {
    const { gate, repository, semaphore } = fixture();
    const appServer = new PermitOnlyAppServer();

    repository.snapshot = authorizedSnapshot({
      principal: {
        identityId: principalIdentityId,
        deploymentId,
        ownerId,
        revokedAt: new Date("2026-08-18T12:00:01.000Z"),
      },
    });

    await expect(gate.issuePermit(request("turn/start"))).rejects.toMatchObject({
      code: "INTERACTION_START_PRINCIPAL_REVOKED",
      retryable: false,
    });
    expect(appServer.actions).not.toHaveBeenCalled();
    expect(semaphore.tryAcquire).not.toHaveBeenCalled();
  });

  it("blocks turn/steer when a captured contributor is revoked after start", async () => {
    const { gate, repository, semaphore } = fixture();
    const appServer = new PermitOnlyAppServer();

    const startPermit = await gate.issuePermit(request("turn/start"));
    await expect(appServer.act(target("turn/start"), startPermit)).resolves.toBe(
      "turn/start:accepted",
    );
    expect(semaphore.release).toHaveBeenCalledOnce();

    repository.snapshot = authorizedSnapshot({
      runState: "active",
      unauthorizedContributorIdentityIds: [contributorIdentityId],
      unauthorizedMessageCount: 1,
    });
    await expect(gate.issuePermit(request("turn/steer"))).rejects.toMatchObject({
      code: "INTERACTION_START_CONTRIBUTOR_UNAUTHORIZED",
    });
    expect(appServer.actions).toHaveBeenCalledTimes(1);
    expect(semaphore.tryAcquire).toHaveBeenCalledTimes(1);
  });

  it("denies a stale generation before rate-limit, semaphore, or app-server work", async () => {
    const { gate, repository, rateLimits, semaphore } = fixture();
    const appServer = new PermitOnlyAppServer();
    repository.snapshot = authorizedSnapshot({ currentGeneration: 4 });

    await expect(gate.issuePermit(request("turn/start"))).rejects.toMatchObject({
      code: "INTERACTION_START_STALE_RUN",
    });
    expect(rateLimits.consume).not.toHaveBeenCalled();
    expect(semaphore.tryAcquire).not.toHaveBeenCalled();
    expect(appServer.actions).not.toHaveBeenCalled();
  });

  it("revalidates after acquiring start capacity and releases a stale lease", async () => {
    const { gate, repository, semaphore } = fixture();
    semaphore.tryAcquire.mockImplementationOnce(async () => {
      repository.snapshot = authorizedSnapshot({
        principal: {
          identityId: principalIdentityId,
          deploymentId,
          ownerId,
          revokedAt: new Date("2026-08-18T12:00:01.000Z"),
        },
      });
      return { release: semaphore.release };
    });

    await expect(gate.issuePermit(request("turn/start"))).rejects.toMatchObject({
      code: "INTERACTION_START_PRINCIPAL_REVOKED",
    });
    expect(repository.loadCurrent).toHaveBeenCalledTimes(2);
    expect(semaphore.release).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "inactive deployment",
      { deploymentStatus: "maintenance" as const },
      "INTERACTION_START_DEPLOYMENT_INACTIVE",
    ],
    [
      "inactive owner",
      { ownerStatus: "disabled" as const },
      "INTERACTION_START_OWNER_INACTIVE",
    ],
    [
      "stale authorization revision",
      { currentAuthorizationRevision: 8 },
      "INTERACTION_START_AUTHORIZATION_REVISION_STALE",
    ],
    [
      "unavailable selected model",
      { selectedModelAvailable: false },
      "INTERACTION_START_MODEL_UNAVAILABLE",
    ],
  ])("denies %s before issuing a permit", async (_label, overrides, code) => {
    const { gate, repository } = fixture();
    repository.snapshot = authorizedSnapshot(overrides);

    await expect(gate.issuePermit(request("turn/start"))).rejects.toMatchObject({
      code,
    });
  });

  it("checks interaction rate limits for every action and the semaphore only for start", async () => {
    const start = fixture();
    const startPermit = await start.gate.issuePermit(request("turn/start"));
    startPermit.dispose();
    expect(start.rateLimits.consume).toHaveBeenCalledWith({
      ownerId,
      action: "turn/start",
      now,
    });
    expect(start.semaphore.tryAcquire).toHaveBeenCalledOnce();
    expect(start.semaphore.release).toHaveBeenCalledOnce();

    const steer = fixture();
    steer.repository.snapshot = authorizedSnapshot({ runState: "active" });
    const steerPermit = await steer.gate.issuePermit(request("turn/steer"));
    steerPermit.dispose();
    expect(steer.rateLimits.consume).toHaveBeenCalledWith({
      ownerId,
      action: "turn/steer",
      now,
    });
    expect(steer.semaphore.tryAcquire).not.toHaveBeenCalled();

    const interrupt = fixture();
    interrupt.repository.snapshot = authorizedSnapshot({ runState: "active" });
    const interruptPermit = await interrupt.gate.issuePermit(
      request("turn/interrupt"),
    );
    interruptPermit.dispose();
    expect(interrupt.rateLimits.consume).toHaveBeenCalledWith({
      ownerId,
      action: "turn/interrupt",
      now,
    });
    expect(interrupt.semaphore.tryAcquire).not.toHaveBeenCalled();
  });

  it("denies a rate-limited action and a start without semaphore capacity", async () => {
    const limited = fixture();
    vi.mocked(limited.rateLimits.consume).mockReturnValue({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1_000,
    });
    await expect(
      limited.gate.issuePermit(request("turn/interrupt")),
    ).rejects.toMatchObject({ code: "INTERACTION_START_RATE_LIMITED" });

    const saturated = fixture();
    saturated.semaphore.available = false;
    await expect(
      saturated.gate.issuePermit(request("turn/start")),
    ).rejects.toMatchObject({
      code: "INTERACTION_START_SEMAPHORE_UNAVAILABLE",
    });
  });

  it("returns a code-owned, action-bound, one-use, short-lived permit", async () => {
    const { gate, semaphore } = fixture();
    const appServer = new PermitOnlyAppServer();
    const permit = await gate.issuePermit(request("turn/start"));

    await expect(
      appServer.act(target("turn/steer"), permit),
    ).rejects.toMatchObject({ code: "INTERACTION_PERMIT_ACTION_MISMATCH" });
    await expect(
      appServer.act(
        { ...target("turn/start"), interactionRunId: `${interactionRunId}-other` },
        permit,
      ),
    ).rejects.toMatchObject({ code: "INTERACTION_PERMIT_TARGET_MISMATCH" });
    await expect(appServer.act(target("turn/start"), permit)).resolves.toBe(
      "turn/start:accepted",
    );
    await expect(
      appServer.act(target("turn/start"), permit),
    ).rejects.toMatchObject({
      code: "INTERACTION_PERMIT_ALREADY_USED",
    });
    expect(semaphore.release).toHaveBeenCalledOnce();

    expect(
      () =>
        new SecureInteractionPermit(Symbol("forged"), {
          action: "turn/start",
          spaceId,
          interactionRunId,
          generation: 3,
          expiresAtMs: now.getTime() + 1_000,
          ttlMs: 1_000,
          lease: null,
        }),
    ).toThrowError(InteractionPermitError);

    const expiring = fixture();
    const expiringPermit = await expiring.gate.issuePermit(
      request("turn/start"),
    );
    await expect(
      expiringPermit.execute(
        target("turn/start"),
        async () => "too late",
        new Date(now.getTime() + 500),
      ),
    ).rejects.toMatchObject({ code: "INTERACTION_PERMIT_EXPIRED" });
    expect(expiring.semaphore.release).toHaveBeenCalledOnce();
  });
});
