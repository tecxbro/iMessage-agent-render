import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("migration 0012 outbound origin union", () => {
  it("preserves chain rows while adding an exclusive interaction origin", async () => {
    const migration = await readFile(
      resolve("src/db/migrations/0012_outbound_origin_union.sql"),
      "utf8",
    );

    expect(migration).toContain(
      'ALTER TABLE "outbound_batches" ALTER COLUMN "chain_id" DROP NOT NULL',
    );
    expect(migration).toContain(
      'ALTER TABLE "outbound_batches" ADD COLUMN "interaction_run_id" uuid',
    );
    expect(migration).toContain(
      'CONSTRAINT "outbound_batches_interaction_run_id_interaction_runs_id_fk" FOREIGN KEY ("interaction_run_id") REFERENCES "public"."interaction_runs"("id") ON DELETE cascade',
    );
    expect(migration).toContain(
      '"chain_id" is not null and "outbound_batches"."interaction_run_id" is null',
    );
    expect(migration).toContain(
      '"chain_id" is null and "outbound_batches"."interaction_run_id" is not null',
    );
    expect(migration).not.toMatch(/^\s*(?:delete|truncate|update)\b/imu);
  });
});
