import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/**
 * Datastore-mode database the bindings are granted on (project roles under
 * an IAM Condition matching only this database).
 */
export const Tasks = GCP.Firestore.Database("Tasks", {
  type: "DATASTORE_MODE",
});

/** Entity the Commit probe upserts. */
export const COMMITTED = { kind: "Task", name: "probe-commit" } as const;
/** Entity the test seeds out of band for the Lookup / RunQuery probes. */
export const SEEDED = { kind: "Seeded", name: "probe-seeded" } as const;

/** The Datastore API names the default database `""`, not `(default)`. */
export const apiDatabaseId = (databaseId: string) =>
  databaseId === "(default)" ? "" : databaseId;

/**
 * Effect-native Cloud Run service exercising every Datastore binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class DatastoreBindingsHost extends GCP.Function<DatastoreBindingsHost>()(
  "DatastoreBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const database = yield* Tasks;
    const project = yield* database.project;
    const databaseId = yield* database.databaseId;
    const commit = yield* GCP.Datastore.Commit(Tasks);
    const lookup = yield* GCP.Datastore.Lookup(Tasks);
    const runQuery = yield* GCP.Datastore.RunQuery(Tasks);

    const keyOf = (path: { kind: string; name: string }) =>
      Effect.gen(function* () {
        return {
          partitionId: {
            projectId: yield* project,
            databaseId: apiDatabaseId(yield* databaseId),
          },
          path: [path],
        };
      });

    return {
      fetch: serveProbes({
        commit: Effect.gen(function* () {
          return yield* commit({
            body: {
              mode: "NON_TRANSACTIONAL",
              mutations: [
                {
                  upsert: {
                    key: yield* keyOf(COMMITTED),
                    properties: { title: { stringValue: "committed" } },
                  },
                },
              ],
            },
          });
        }),
        lookup: Effect.gen(function* () {
          return yield* lookup({ body: { keys: [yield* keyOf(SEEDED)] } });
        }),
        runQuery: Effect.gen(function* () {
          const { partitionId } = yield* keyOf(SEEDED);
          return yield* runQuery({
            body: { partitionId, query: { kind: [{ name: SEEDED.kind }] } },
          });
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Datastore.CommitHttp),
    Effect.provide(GCP.Datastore.LookupHttp),
    Effect.provide(GCP.Datastore.RunQueryHttp),
  ),
) {}
