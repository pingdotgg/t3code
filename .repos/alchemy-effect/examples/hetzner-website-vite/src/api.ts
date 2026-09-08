import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Hetzner from "alchemy/Hetzner";
import { desc, sql } from "drizzle-orm";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ENSURE_NOTES_SQL, Notes } from "./schema.ts";
import { API_PORT, Box, NeonBranch } from "./shared.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const json = (value: unknown, status = 200) =>
  HttpServerResponse.json(value, { status, headers: cors });

/**
 * Effect HTTP API on the shared Hetzner Server. Reads `DATABASE_URL`
 * (the Neon branch URI) and serves `/notes` for the Vite SPA.
 */
export default class Api extends Hetzner.Service<Api>()(
  "Api",
  Effect.gen(function* () {
    const server = yield* Box;
    const branch = yield* NeonBranch;
    return {
      server,
      main: import.meta.url,
      port: API_PORT,
      env: {
        DATABASE_URL: branch.connectionUri,
      },
    };
  }),
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const databaseUrl = yield* Config.redacted("DATABASE_URL");
      const db = yield* Drizzle.Postgres(Effect.succeed(databaseUrl));
      const request = yield* HttpServerRequest;
      const path = new URL(request.url, "http://service").pathname;
      if (request.method === "OPTIONS") {
        return yield* json({}, 204);
      }
      yield* db.execute(sql.raw(ENSURE_NOTES_SQL));
      if (path === "/health") {
        return yield* json({ ok: true });
      }
      if (path === "/notes" && request.method === "GET") {
        const notes = yield* db
          .select()
          .from(Notes)
          .orderBy(desc(Notes.createdAt));
        return yield* json({ notes });
      }
      if (path === "/notes" && request.method === "POST") {
        const raw = yield* request.text.pipe(Effect.orDie);
        const payload = JSON.parse(raw) as { body?: unknown };
        const body =
          typeof payload.body === "string" ? payload.body.trim() : "";
        if (body.length === 0) {
          return yield* json({ error: "body required" }, 400);
        }
        const [note] = yield* db.insert(Notes).values({ body }).returning();
        return yield* json({ note }, 201);
      }
      return yield* json({ error: "not found" }, 404);
    }).pipe(
      Effect.catch((cause: unknown) =>
        json({ ok: false, error: String(cause) }, 500),
      ),
      Effect.orDie,
    ),
  }),
) {}
