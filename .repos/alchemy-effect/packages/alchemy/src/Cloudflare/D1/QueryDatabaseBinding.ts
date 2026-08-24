import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Database } from "./Database.ts";
import {
  type QueryDatabaseClient,
  PreparedStatement,
  QueryDatabase,
} from "./QueryDatabase.ts";

export const QueryDatabaseBinding = Layer.effect(
  QueryDatabase,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (database: Database) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${database}`({
          bindings: [
            {
              type: "d1",
              name: database.LogicalId,
              databaseId: database.databaseId,
            },
          ],
        });
      }

      const rawEff = Effect.sync(
        () => (env as Record<string, runtime.D1Database>)[database.LogicalId]!,
      );

      return {
        raw: rawEff,
        prepare: (query: string) => new PreparedStatement(query, [], rawEff),
        exec: (query: string) =>
          Effect.flatMap(rawEff, (raw) =>
            Effect.promise(() => raw.exec(query)),
          ),
        batch: <T = unknown>(statements: PreparedStatement[]) =>
          Effect.flatMap(rawEff, (raw) =>
            Effect.promise(() =>
              raw.batch<T>(statements.map((s) => s._build(raw))),
            ),
          ),
      } satisfies QueryDatabaseClient;
    });
  }),
);
