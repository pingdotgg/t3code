import * as Cloudflare from "@alchemy.run/cloudflare";
import * as SQL from "@alchemy.run/cloudflare/D1/SQL";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Db } from "./Db.ts";
import { LinkNotFound, newCode, type Link } from "./Link.ts";
import LinkRoom from "./LinkRoom.ts";
import { ShortyApi } from "./ShortyApi.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1.QueryDatabase(Db);
    const sql = yield* SQL.D1(d1);
    const rooms = yield* LinkRoom;

    const findLink = Effect.fn(function* (code: string) {
      const [link] = yield* sql<Link>`
        SELECT code, url, created_at AS "createdAt" FROM links WHERE code = ${code}`;
      if (!link) return yield* new LinkNotFound({ code });
      return link;
    });

    const handlers = HttpApiBuilder.group(ShortyApi, "links", (handlers) =>
      handlers
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            const link = { code: newCode(), url: payload.url, createdAt: new Date().toISOString() };
            yield* sql`
              INSERT INTO links (code, url, created_at)
              VALUES (${link.code}, ${link.url}, ${link.createdAt})`;
            return link;
          }).pipe(Effect.orDie),
        )
        .handle("list", () =>
          sql<Link>`
            SELECT code, url, created_at AS "createdAt" FROM links
            ORDER BY created_at DESC`.pipe(Effect.orDie),
        )
        .handle("get", ({ params }) =>
          findLink(params.code).pipe(Effect.catchTag("SqlError", Effect.die)),
        ),
    );

    const api = yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(ShortyApi).pipe(
        Layer.provide(handlers),
        Layer.provide(Http.Platform),
        Layer.provide(HttpRouter.cors()),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, first, code, action] = new URL(request.url, "http://localhost").pathname.split(
          "/",
        );

        // GET /links/:code/live → a WebSocket to the link's room
        if (first === "links" && code && action === "live") {
          return yield* rooms.getByName(code).fetch(request);
        }

        // GET /:code → count the click, then redirect
        if (request.method === "GET" && first && first !== "links" && code === undefined) {
          const link = yield* findLink(first);
          yield* rooms.getByName(link.code).record(1);
          return HttpServerResponse.redirect(link.url, { status: 302 });
        }

        return yield* api;
      }).pipe(
        Effect.catchTags({
          LinkNotFound: ({ code }) =>
            HttpServerResponse.json({ _tag: "LinkNotFound", code }, { status: 404 }),
          SqlError: () =>
            HttpServerResponse.json({ error: "database unavailable" }, { status: 503 }),
        }),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
