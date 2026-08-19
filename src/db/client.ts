import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export interface DatabaseClient {
  readonly database: Database;
  readonly pool: Pool;
  close(): Promise<void>;
  checkReady(): Promise<void>;
}

export interface DatabaseClientOptions {
  connectionString: string;
  applicationName?: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
  ssl?: PoolConfig["ssl"];
}

export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? "imessage-codex-agent",
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    ...(options.statementTimeoutMs === undefined
      ? {}
      : { statement_timeout: options.statementTimeoutMs }),
    ...(options.queryTimeoutMs === undefined
      ? {}
      : { query_timeout: options.queryTimeoutMs }),
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  });
  const database = drizzle({ client: pool, schema });

  return {
    database,
    pool,
    async close() {
      await pool.end();
    },
    async checkReady() {
      const client = await pool.connect();
      try {
        await client.query("select 1");
      } finally {
        client.release();
      }
    },
  };
}
