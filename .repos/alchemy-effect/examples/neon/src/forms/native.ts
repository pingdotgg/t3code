import { attachDatabasePool } from "@neon/functions";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
attachDatabasePool(pool);

export default {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true });
    // A public Function URL is not protected by functions:invoke credentials.
    const token = process.env.APP_TOKEN;
    if (!token || request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response("Unauthorized", { status: 401 });
    const { rows } = await pool.query("SELECT current_database() AS database");
    console.log("database queried");
    return Response.json(rows);
  },
};
