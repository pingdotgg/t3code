import type { Hyperdrive } from "@cloudflare/workers-types";
import { Client } from "pg";

/** Queries the private Aurora database through Hyperdrive. */
export default {
  async fetch(_request: Request, env: { DB: Hyperdrive }): Promise<Response> {
    const client = new Client({ connectionString: env.DB.connectionString });
    try {
      await client.connect();
      const result = await client.query("select version()");
      return Response.json(result.rows[0]);
    } catch (error) {
      return new Response(String(error), { status: 500 });
    } finally {
      await client.end().catch(() => {});
    }
  },
};
