import postgres, { type PostgresClient } from "@prisma-next/postgres/runtime";
import { Pool } from "pg";
import type { Contract } from "./contract.d";
import contractJson from "./contract.json" with { type: "json" };

type Db = PostgresClient<Contract>;

let cached: { db: Db; pool: Pool } | undefined;

export function getDb(): Db {
  if (!cached) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required for Prisma Next queries.");
    }

    const poolMax = process.env.PRISMA_TANSTACK_PG_POOL_MAX;
    const pool = new Pool({
      connectionString,
      ...(poolMax === undefined ? {} : { max: Number(poolMax) }),
    });

    pool.on("error", (error) => {
      console.error("[prisma-tanstack-start] pg pool error:", error.message);
    });

    cached = {
      db: postgres<Contract>({
        contractJson,
        binding: { kind: "pgPool", pool },
      }),
      pool,
    };
  }

  return cached.db;
}

export async function closeDb() {
  if (!cached) return;
  const { pool } = cached;
  cached = undefined;
  await pool.end();
}

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    await closeDb();
  });
}
