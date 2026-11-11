import type { Hyperdrive } from "@cloudflare/workers-types";
import { Client } from "pg";

/**
 * Async Worker that binds a looked-up Hyperdrive configuration via
 * `env: { HD: lookup }` and runs SQL through it. Under `alchemy dev` the
 * connection string points at the lookup's `dev` origin.
 */
export default {
  async fetch(_request: Request, env: { HD: Hyperdrive }): Promise<Response> {
    const client = new Client({ connectionString: env.HD.connectionString });
    try {
      await client.connect();
      const result = await client.query("SELECT 1 + 1 AS sum, current_database() AS db");
      return Response.json({ row: result.rows[0], host: env.HD.host });
    } catch (error) {
      return new Response(String(error), { status: 500 });
    } finally {
      await client.end().catch(() => {});
    }
  },
};
