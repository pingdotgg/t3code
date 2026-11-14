import type * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { LinkNotFound, newCode, type Link } from "./Link.ts";

export class LinkStoreError extends Data.TaggedError("LinkStoreError")<{ cause: unknown }> {}

/** Where links live. The Worker depends on this contract, never on a database. */
export class Links extends Context.Service<
  Links,
  {
    create(url: string): Effect.Effect<Link, LinkStoreError, Alchemy.RuntimeContext>;
    get(code: string): Effect.Effect<Link, LinkNotFound | LinkStoreError, Alchemy.RuntimeContext>;
    list(): Effect.Effect<readonly Link[], LinkStoreError, Alchemy.RuntimeContext>;
  }
>()("Links") {}

/** `Links` over any SQL database: D1, Postgres, … whatever provides a `SqlClient`. */
export const LinksSql = Layer.effect(
  Links,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storeError = (cause: unknown) => new LinkStoreError({ cause });

    return {
      create: (url: string) =>
        Effect.gen(function* () {
          const link = { code: newCode(), url, createdAt: new Date().toISOString() };
          yield* sql`
            INSERT INTO links (code, url, created_at)
            VALUES (${link.code}, ${link.url}, ${link.createdAt})`;
          return link;
        }).pipe(Effect.mapError(storeError)),
      get: (code: string) =>
        Effect.gen(function* () {
          const [link] = yield* sql<Link>`
            SELECT code, url, created_at AS "createdAt" FROM links WHERE code = ${code}`;
          if (!link) return yield* new LinkNotFound({ code });
          return link;
        }).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(storeError(cause)))),
      list: () =>
        sql<Link>`
          SELECT code, url, created_at AS "createdAt" FROM links
          ORDER BY created_at DESC`.pipe(Effect.mapError(storeError)),
    };
  }),
);
