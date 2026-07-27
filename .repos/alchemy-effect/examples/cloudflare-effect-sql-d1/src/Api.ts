import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Database } from "./database.ts";

export interface User {
  readonly id: number;
  readonly email: string;
  readonly name: string;
  readonly created_at: number;
}

/**
 * A Worker querying D1 through `@effect/sql-d1` — tagged-template SQL over
 * the native binding. Interpolated values are parameterized, every query is
 * an Effect, and failures surface as typed `SqlError`s.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1.QueryDatabase(Database);
    const sql = yield* SQL.D1(d1);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        switch (request.method) {
          case "GET": {
            if (request.url === "/") {
              const users = yield* sql<User>`
                SELECT * FROM users ORDER BY id
              `;
              return yield* HttpServerResponse.json({ users });
            }
            const id = Number(request.url.split("/").pop());
            if (Number.isNaN(id)) {
              return yield* HttpServerResponse.json(
                { error: "Invalid user ID" },
                { status: 400 },
              );
            }
            const [user] = yield* sql<User>`
              SELECT * FROM users WHERE id = ${id}
            `;
            return yield* HttpServerResponse.json({ user: user ?? null });
          }
          case "POST": {
            const [user] = yield* sql<User>`
              INSERT INTO users (name, email)
              VALUES (${crypto.randomUUID()}, ${crypto.randomUUID()})
              RETURNING *
            `;
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
            const [user] = yield* sql<User>`
              DELETE FROM users WHERE id = ${id} RETURNING *
            `;
            return yield* HttpServerResponse.json({ user: user ?? null });
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
