import * as Effect from "effect/Effect";
import type { Database } from "../Firestore/Database.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

/**
 * A Datastore request with the project and database filled in from the
 * bound database: callers only supply the request body (minus
 * `databaseId`).
 */
export type DatastoreDatabaseRequest<
  I extends {
    projectId: string;
    requestParams?: string;
    body?: { databaseId?: string };
  },
> = Omit<I, "projectId" | "requestParams" | "body"> & {
  body?: Omit<NonNullable<I["body"]>, "databaseId">;
};

/** The Datastore API names the default database `""`, not `(default)`. */
const apiDatabaseId = (databaseId: string) =>
  databaseId === "(default)" ? "" : databaseId;

/**
 * Shared HTTP scaffolding for Datastore bindings.
 *
 * Grants the role on the project under an IAM Condition matching only the
 * bound database, and pins every request to that database's project and id.
 * NOT exported from index.ts.
 */
export const makeDatastoreHttpBinding = <
  I extends {
    projectId: string;
    requestParams?: string;
    body?: { databaseId?: string };
  },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (database: Database) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: database,
        iam: [grantFor(options.iam, database.name)],
      });
      const project = yield* database.project;
      const databaseId = yield* database.databaseId;
      return Effect.fn(`${options.tag}(${database.LogicalId})`)(function* (
        request: DatastoreDatabaseRequest<I>,
      ) {
        const projectId = yield* project;
        const id = apiDatabaseId(yield* databaseId);
        return yield* run({
          ...request,
          projectId,
          // Named databases require the routing header.
          requestParams:
            id.length > 0
              ? `project_id=${projectId}&database_id=${id}`
              : undefined,
          body: { ...request.body, databaseId: id },
        } as I);
      });
    });
  });
