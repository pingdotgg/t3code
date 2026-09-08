import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Drizzle from "@/Drizzle/MySQL.ts";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "./Stack.ts";
import { relations, Widgets } from "./schema.ts";

/**
 * Worker fixture that binds a Cloudflare Hyperdrive (pointed at a
 * PlanetScale MySQL password) and exercises Drizzle's Effect-native
 * MySQL client. Mirrors the Postgres Hyperdrive fixture, minus
 * `.returning()` / `onConflictDoUpdate` — MySQL has neither, so writes
 * re-select and upserts use `onDuplicateKeyUpdate`.
 */
export default class MySQLHyperdriveWorker extends Cloudflare.Worker<MySQLHyperdriveWorker>()(
  "PlanetscaleMySQLHyperdriveWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* Drizzle.MySQL(conn.connectionString, { relations });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/hyperdrive") {
          return yield* HttpServerResponse.json({
            host: yield* conn.host,
            port: yield* conn.port,
            user: yield* conn.user,
            database: yield* conn.database,
          });
        }

        if (request.method === "GET" && url.pathname === "/widgets") {
          const widgets = yield* db.select().from(Widgets);
          return yield* HttpServerResponse.json({ widgets });
        }

        if (request.method === "POST" && url.pathname === "/widgets") {
          const body = (yield* request.json) as { id: number; name: string };
          yield* db
            .insert(Widgets)
            .values({ id: body.id, name: body.name })
            .onDuplicateKeyUpdate({ set: { name: body.name } });
          const [inserted] = yield* db
            .select()
            .from(Widgets)
            .where(eq(Widgets.id, body.id));
          return yield* HttpServerResponse.json({ widget: inserted });
        }

        const idMatch = url.pathname.match(/^\/widgets\/(\d+)$/);
        if (request.method === "DELETE" && idMatch) {
          const id = Number(idMatch[1]);
          const [existing] = yield* db
            .select()
            .from(Widgets)
            .where(eq(Widgets.id, id));
          yield* db.delete(Widgets).where(eq(Widgets.id, id));
          return yield* HttpServerResponse.json({ widget: existing ?? null });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catch((cause: any) =>
          HttpServerResponse.json(
            { ok: false, error: String(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.Hyperdrive.ConnectBinding))),
) {}
