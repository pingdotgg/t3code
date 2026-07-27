import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Database } from "./Db.ts";
import { relations, Users } from "./schema.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const database = yield* Database;
    const d1 = yield* Cloudflare.D1.QueryDatabase(database);

    // drizzle-orm's `effect-d1` driver over the native D1 binding.
    const db = yield* Drizzle.D1(d1, { relations });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        switch (request.method) {
          case "GET": {
            if (request.url === "/") {
              const users = yield* db.select().from(Users);
              return yield* HttpServerResponse.json({ users });
            }
            const id = Number(request.url.split("/").pop());
            if (Number.isNaN(id)) {
              return yield* HttpServerResponse.json(
                { error: "Invalid user ID" },
                { status: 400 },
              );
            }
            const user = yield* db.query.Users.findFirst({
              where: { id },
              with: { posts: true },
            });
            return yield* HttpServerResponse.json({ user });
          }
          case "POST": {
            const user = yield* db
              .insert(Users)
              .values({
                name: crypto.randomUUID(),
                email: crypto.randomUUID(),
              })
              .returning();
            return yield* HttpServerResponse.json({ user });
          }
          case "DELETE": {
            const id = Number(request.url.split("/").pop());
            if (Number.isNaN(id)) {
              return yield* HttpServerResponse.json(
                { error: "Invalid user ID" },
                { status: 400 },
              );
            }
            const [user] = yield* db
              .delete(Users)
              .where(eq(Users.id, id))
              .returning();
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
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
