import * as Cloudflare from "alchemy/Cloudflare";
import { makeDatabase } from "./prisma/generated/client.ts";
import { schemas } from "./prisma/generated/schemas.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Hyperdrive } from "./Db.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* makeDatabase(conn.connectionString);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        switch (request.method) {
          case "GET": {
            if (request.url === "/") {
              const users = yield* db.orm.public.User.all();
              return yield* HttpServerResponse.json({ users });
            }
            const id = request.url.split("/").pop() ?? "";
            const user = yield* db.orm.public.User.where({ id })
              .include("posts")
              .first();
            return yield* HttpServerResponse.json({ user });
          }
          case "POST": {
            const values = yield* Effect.sync(() => ({
              name: crypto.randomUUID(),
              email: crypto.randomUUID(),
            }));
            const row = yield* db.orm.public.User.create(values);
            const user = yield* Schema.decodeUnknownEffect(schemas.public.User)(
              row,
            );
            return yield* HttpServerResponse.json({ user });
          }
          case "DELETE": {
            const id = request.url.split("/").pop() ?? "";
            const user = yield* db.orm.public.User.where({ id }).delete();
            return yield* HttpServerResponse.json({ user });
          }
          default: {
            return yield* HttpServerResponse.json(
              { error: "Method not allowed" },
              { status: 405 },
            );
          }
        }
      }).pipe(
        Effect.catch((cause) =>
          HttpServerResponse.json(
            { ok: false, error: cause._tag },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
