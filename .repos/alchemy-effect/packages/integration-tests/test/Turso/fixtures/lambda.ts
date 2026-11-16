import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Drizzle from "@alchemy.run/drizzle/LibSQL";
import * as SQL from "@alchemy.run/sql/SQLite";
import * as Turso from "@alchemy.run/turso";
import { sql as drizzleSql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { LambdaDb } from "./resources.ts";

export default class TursoLambda extends Lambda.Function<TursoLambda>()(
  "TursoLambda",
  {
    main: import.meta.url,
    functionUrl: true,
    // @libsql/client loads a native binary in Node; install it for Linux.
    build: { install: ["@libsql/client"] },
  },
  Effect.gen(function* () {
    const conn = yield* Turso.Connect(LambdaDb);
    const sql = yield* SQL.LibSQL(conn);
    const db = yield* Drizzle.LibSQL(conn);
    return {
      fetch: Effect.gen(function* () {
        const [row] = yield* sql<{ answer: number }>`SELECT 41 + 1 AS answer`;
        const [viaDrizzle] = yield* db.all<{ two: number }>(drizzleSql`SELECT 2 AS two`);
        return yield* HttpServerResponse.json({ answer: row?.answer, two: viaDrizzle?.two });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Turso.ConnectHttp)),
) {}
