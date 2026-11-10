import type { Hyperdrive } from "@cloudflare/workers-types";
import { Client } from "pg";

/**
 * Async Worker that binds the Access-protected Hyperdrive via
 * `env: { HD: connection }` and runs a query through it.
 */
export default {
  async fetch(_request: Request, env: { HD: Hyperdrive }): Promise<Response> {
    const client = new Client({ connectionString: env.HD.connectionString });
    try {
      await client.connect();
      const result = await client.query("select 'through-access' as via");
      return Response.json(result.rows[0]);
    } catch (error) {
      return new Response(String(error), { status: 500 });
    } finally {
      await client.end().catch(() => {});
    }
  },
};
