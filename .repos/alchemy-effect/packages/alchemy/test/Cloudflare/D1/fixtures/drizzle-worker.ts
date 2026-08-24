import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Drizzle from "@/Drizzle/index.ts";
import * as SQL from "@/SQL/D1.ts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DrizzleDb } from "./drizzle-database.ts";
import { Posts, relations, Users } from "./drizzle-schema.ts";

/**
 * Effect-native Worker exercising BOTH D1 client layers over one database:
 *
 * - `Drizzle.D1(d1, { relations })` — the drizzle-orm `effect-d1` driver
 *   (typed query builder + relational queries);
 * - `SQL.D1(d1)` — the raw `@effect/sql-d1` client
 *   (tagged-template SQL).
 */
export default class D1DrizzleWorker extends Cloudflare.Worker<D1DrizzleWorker>()(
  "D1DrizzleWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const database = yield* DrizzleDb;
    const d1 = yield* Cloudflare.D1.QueryDatabase(database);
    const db = yield* Drizzle.D1(d1, { relations });
    const sql = yield* SQL.D1(d1);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const segments = request.url.split("/").filter(Boolean);

        if (request.method === "POST" && request.url === "/users") {
          const body = (yield* request.json) as {
            name: string;
            email: string;
          };
          const [user] = yield* db
            .insert(Users)
            .values({ name: body.name, email: body.email })
            .returning();
          return yield* HttpServerResponse.json({ user });
        }

        if (request.method === "POST" && request.url === "/posts") {
          const body = (yield* request.json) as {
            userId: number;
            title: string;
          };
          const [post] = yield* db
            .insert(Posts)
            .values({ userId: body.userId, title: body.title })
            .returning();
          return yield* HttpServerResponse.json({ post });
        }

        if (request.method === "GET" && request.url === "/users") {
          const users = yield* db.select().from(Users);
          return yield* HttpServerResponse.json({ users });
        }

        // GET /users/:id — relational query (RQB v2) joining posts.
        if (
          request.method === "GET" &&
          segments[0] === "users" &&
          segments.length === 2
        ) {
          const id = Number(segments[1]);
          const user = yield* db.query.Users.findFirst({
            where: { id },
            with: { posts: true },
          });
          return yield* HttpServerResponse.json({ user });
        }

        // GET /sql/users — the raw @effect/sql-d1 client.
        if (request.method === "GET" && request.url === "/sql/users") {
          const rows = yield* sql`SELECT id, name, email FROM users`;
          return yield* HttpServerResponse.json({ rows });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
