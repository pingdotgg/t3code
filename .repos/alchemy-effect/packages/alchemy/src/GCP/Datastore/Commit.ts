import type * as datastore from "@distilled.cloud/gcp/datastore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "../Firestore/Database.ts";
import type { DatastoreDatabaseRequest } from "./BindingHttp.ts";

/** Request for {@link Commit}; project and database come from the bound database. */
export type CommitRequest =
  DatastoreDatabaseRequest<datastore.CommitProjectsRequest>;

/**
 * Runtime binding for Datastore `projects.commit`.
 *
 * Bind this operation to a Datastore-mode `GCP.Firestore.Database` in a Function/Action init
 * phase. Provide {@link CommitHttp}. The bound database supplies the
 * project and database id; mutations run against that database only.
 * The host is granted the role on the project under an IAM Condition
 * matching the database.
 *
 * ### Committing Mutations
 * **Example:** Upsert an entity
 * ```typescript
 * const database = yield* GCP.Firestore.Database("Tasks", {
 *   type: "DATASTORE_MODE",
 * });
 * const commit = yield* GCP.Datastore.Commit(database);
 * const result = yield* commit({
 *   body: {
 *     mode: "NON_TRANSACTIONAL",
 *     mutations: [
 *       {
 *         upsert: {
 *           key: { path: [{ kind: "Task", name: "t1" }] },
 *           properties: { title: { stringValue: "Ship" } },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @binding
 * @category Datastore
 */
export interface Commit extends Binding.Service<
  Commit,
  "GCP.Datastore.Commit",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: CommitRequest,
    ) => Effect.Effect<
      datastore.CommitResponse,
      datastore.CommitProjectsError,
      RuntimeContext
    >
  >
> {}

export const Commit = Binding.Service<Commit>("GCP.Datastore.Commit");
