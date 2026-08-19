import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

describe("conversation actor boundaries", () => {
  it("freezes every required conversation and delivery port name", async () => {
    const conversation = await source("src/conversation/contracts.ts");
    const delivery = await source("src/delivery/contracts.ts");

    for (const port of [
      "ConversationRepositoryPort",
      "InteractionRuntimePort",
      "InteractionStartGatePort",
      "InteractionPresencePort",
      "InteractionContextLoaderPort",
      "InteractionTaskPort",
      "InteractionDeliveryPort",
      "InteractionWakePublisherPort",
      "ActorRegistryPort",
    ]) {
      expect(conversation).toContain(`export interface ${port}`);
    }
    for (const port of [
      "DeliveryRepositoryPort",
      "DeliveryTransportPort",
      "DeliveryWakePublisherPort",
      "DeliveryCoordinatorPort",
    ]) {
      expect(delivery).toContain(`export interface ${port}`);
    }
  });

  it.each([
    "src/conversation/contracts.ts",
    "src/conversation/state.ts",
    "src/conversation/errors.ts",
    "src/delivery/contracts.ts",
  ])("keeps %s independent of implementation modules", async (path) => {
    const contents = await source(path);

    expect(contents).not.toMatch(/from\s+["'][^"']*db\//u);
    expect(contents).not.toMatch(/from\s+["'][^"']*agent\//u);
    expect(contents).not.toMatch(/from\s+["'][^"']*transport\//u);
    expect(contents).not.toMatch(
      /from\s+["'][^"']*queue\/(?:boss|handlers|pipeline|publisher)/u,
    );
  });

  it("does not register conversation or delivery coordinator workers yet", async () => {
    const production = await source("src/runtime/production-bootstrap.ts");
    const pipeline = await source("src/queue/pipeline.ts");

    for (const legacyRuntime of [production, pipeline]) {
      expect(legacyRuntime).not.toContain("interactionCoordinate");
      expect(legacyRuntime).not.toContain("outboundCoordinate");
      expect(legacyRuntime).not.toContain("conversation/contracts");
      expect(legacyRuntime).not.toContain("delivery/contracts");
    }
  });

  it("keeps the new schema fragment independent of queue and runtime code", async () => {
    const contents = await source(
      "src/db/schema-fragments/conversation-actors.ts",
    );

    expect(contents).not.toMatch(/from\s+["'][^"']*queue\//u);
    expect(contents).not.toMatch(/from\s+["'][^"']*runtime\//u);
    expect(contents).not.toMatch(/from\s+["'][^"']*transport\//u);
  });
});
