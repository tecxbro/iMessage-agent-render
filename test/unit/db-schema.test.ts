import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  carriedMessages,
  chains,
  messages,
  outboundBatches,
  outboundParts,
} from "../../src/db/schema.js";
import { stableClientGuid } from "../../src/db/repositories/outbound.js";

describe("database schema invariants", () => {
  it("defines durable deduplication, version, carry, and cursor constraints", () => {
    const messageIndexes = getTableConfig(messages).indexes.map(
      (index) => index.config.name,
    );
    const chainIndexes = getTableConfig(chains).indexes.map(
      (index) => index.config.name,
    );
    const carryIndexes = getTableConfig(carriedMessages).indexes.map(
      (index) => index.config.name,
    );
    const batchIndexes = getTableConfig(outboundBatches).indexes.map(
      (index) => index.config.name,
    );
    const partIndexes = getTableConfig(outboundParts).indexes.map(
      (index) => index.config.name,
    );

    expect(messageIndexes).toContain("messages_external_identity_unique");
    expect(chainIndexes).toContain("chains_space_version_unique");
    expect(carryIndexes).toContain("carried_messages_source_unique");
    expect(batchIndexes).toContain("outbound_batches_chain_unique");
    expect(partIndexes).toEqual(
      expect.arrayContaining([
        "outbound_parts_batch_position_unique",
        "outbound_parts_client_guid_unique",
      ]),
    );
    expect(
      getTableConfig(outboundBatches).checks.map((constraint) => constraint.name),
    ).toContain("outbound_batches_cursor_bounds");
  });

  it("derives stable per-position client GUIDs without message content", () => {
    const deploymentId = "00000000-0000-4000-8000-000000000001";
    const batchId = "00000000-0000-4000-8000-000000000002";
    const first = stableClientGuid(deploymentId, batchId, 0);

    expect(first).toBe(stableClientGuid(deploymentId, batchId, 0));
    expect(first).not.toBe(stableClientGuid(deploymentId, batchId, 1));
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
  });
});
