import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { Database } from "./Database.ts";
import { ExecuteSql, type ExecuteSqlRequest } from "./ExecuteSql.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";

/**
 * HTTP implementation of {@link ExecuteSql}.
 *
 * Reuses one multiplexed session per database for the life of the runtime
 * instance (multiplexed sessions serve concurrent requests and are never
 * deleted by the client). A session the server has dropped
 * (`SessionNotFound`) is replaced once and the statement retried.
 *
 * @layer
 * @provides GCP.Spanner.ExecuteSql
 */
export const ExecuteSqlHttp = Layer.effect(
  ExecuteSql,
  Effect.gen(function* () {
    const createSession =
      yield* spanner.createProjectsInstancesDatabasesSessions;
    const executeSql =
      yield* spanner.executeSqlProjectsInstancesDatabasesSessions;
    // Session names by database name; plain values, safe to keep per instance.
    const sessions = new Map<string, string>();
    const lock = yield* Semaphore.make(1);

    const sessionFor = (database: string, stale?: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const cached = sessions.get(database);
          if (cached !== undefined && cached !== stale) return cached;
          const session = yield* createSession({
            database,
            body: { session: { multiplexed: true } },
          });
          const name = session.name ?? "";
          sessions.set(database, name);
          return name;
        }),
      );

    return Effect.fn(function* (database: Database) {
      yield* bindGcpHost({
        tag: "GCP.Spanner.ExecuteSql",
        resource: database,
        iam: [
          grantFor(
            { role: "roles/spanner.databaseUser", on: "spanner.database" },
            database.name,
          ),
        ],
      });
      const name = yield* database.name;
      return Effect.fn(`GCP.Spanner.ExecuteSql(${database.LogicalId})`)(
        function* (request: ExecuteSqlRequest) {
          const databaseName = yield* name;
          const session = yield* sessionFor(databaseName);
          return yield* executeSql({ session, body: request }).pipe(
            Effect.catchTag("SessionNotFound", () =>
              Effect.gen(function* () {
                const fresh = yield* sessionFor(databaseName, session);
                return yield* executeSql({ session: fresh, body: request });
              }),
            ),
          );
        },
      );
    });
  }),
);
