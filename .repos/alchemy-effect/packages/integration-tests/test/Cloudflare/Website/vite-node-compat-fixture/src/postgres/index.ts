import { Client } from "pg";

interface Env {
  DB_HOSTNAME: string;
  DB_PORT: string;
  DB_NAME: string;
  DB_USERNAME: string;
  DB_PASSWORD: string;
}

export default {
  async fetch(request, env, ctx) {
    const client = new Client({
      user: env.DB_USERNAME,
      password: env.DB_PASSWORD,
      host: env.DB_HOSTNAME,
      port: Number(env.DB_PORT),
      database: env.DB_NAME,
    });

    const url = new URL(request.url);
    if (url.pathname == "/send-query") {
      return testPostgresLibrary(client, ctx);
    } else {
      return new Response(client.host);
    }
  },
} satisfies ExportedHandler<Env>;

async function testPostgresLibrary(client: Client, ctx: ExecutionContext) {
  await client.connect();
  const result = await client.query(`SELECT * FROM rnacen.rnc_database`);
  // Return the first row as JSON
  const resp = Response.json(result.rows[0]);

  // Clean up the client
  ctx.waitUntil(client.end());
  return resp;
}
