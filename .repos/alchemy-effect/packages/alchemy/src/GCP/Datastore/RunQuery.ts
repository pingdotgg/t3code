import type * as datastore from "@distilled.cloud/gcp/datastore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "../Firestore/Database.ts";
import type { DatastoreDatabaseRequest } from "./BindingHttp.ts";

/** Request for {@link RunQuery}; project and database come from the bound database. */
export type RunQueryRequest =
  DatastoreDatabaseRequest<datastore.RunQueryProjectsRequest>;

/**
 * Runtime binding for Datastore `projects.runQuery`.
 *
 * Bind this operation to a Datastore-mode `GCP.Firestore.Database` in a Function/Action init
 * phase. Provide {@link RunQueryHttp}. The bound database supplies the
 * project and database id; queries run against that database only.
 * The host is granted the role on the project under an IAM Condition
 * matching the database.
 *
 * ### Querying Entities
 * **Example:** Query a kind
 * ```typescript
 * const database = yield* GCP.Firestore.Database("Tasks", {
 *   type: "DATASTORE_MODE",
 * });
 * const runQuery = yield* GCP.Datastore.RunQuery(database);
 * const page = yield* runQuery({
 *   body: { query: { kind: [{ name: "Task" }] } },
 * });
 * ```
 *
 * @binding
 * @category Datastore
 */
export interface RunQuery extends Binding.Service<
  RunQuery,
  "GCP.Datastore.RunQuery",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: RunQueryRequest,
    ) => Effect.Effect<
      datastore.RunQueryResponse,
      datastore.RunQueryProjectsError,
      RuntimeContext
    >
  >
> {}

export const RunQuery = Binding.Service<RunQuery>("GCP.Datastore.RunQuery");
