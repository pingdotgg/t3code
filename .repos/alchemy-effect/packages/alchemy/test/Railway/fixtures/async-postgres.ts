import { Client } from "pg";
import type { PostgresFnEnv } from "./async-postgres-fn.ts";

/**
 * Async (non-Effect) canvas Function. `DATABASE_URL` is a string env var
 * declared on the Function (`env: { DATABASE_URL: db.connectionUri }`).
 * `InferEnv` types `env.DATABASE_URL` as `string`.
 */
export default {
  async fetch(_request: Request, env: PostgresFnEnv): Promise<Response> {
    const client = new Client({
      connectionString: env.DATABASE_URL,
    });
    await client.connect();
    try {
      const result = await client.query("select 1 as ok");
      return Response.json({ rows: result.rows });
    } catch (error) {
      return Response.json(
        { ok: false, error: String(error) },
        { status: 500 },
      );
    } finally {
      await client.end();
    }
  },
};
