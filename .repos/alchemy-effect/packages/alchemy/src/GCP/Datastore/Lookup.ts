import type * as datastore from "@distilled.cloud/gcp/datastore_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "../Firestore/Database.ts";
import type { DatastoreDatabaseRequest } from "./BindingHttp.ts";

/** Request for {@link Lookup}; project and database come from the bound database. */
export type LookupRequest =
  DatastoreDatabaseRequest<datastore.LookupProjectsRequest>;

/**
 * Runtime binding for Datastore `projects.lookup`.
 *
 * Bind this operation to a Datastore-mode `GCP.Firestore.Database` in a Function/Action init
 * phase. Provide {@link LookupHttp}. The bound database supplies the
 * project and database id; lookups run against that database only.
 * The host is granted the role on the project under an IAM Condition
 * matching the database.
 *
 * ### Looking Up Entities
 * **Example:** Lookup by key
 * ```typescript
 * const database = yield* GCP.Firestore.Database("Tasks", {
 *   type: "DATASTORE_MODE",
 * });
 * const lookup = yield* GCP.Datastore.Lookup(database);
 * const result = yield* lookup({
 *   body: {
 *     keys: [{ path: [{ kind: "Task", name: "t1" }] }],
 *   },
 * });
 * ```
 *
 * @binding
 * @category Datastore
 */
export interface Lookup extends Binding.Service<
  Lookup,
  "GCP.Datastore.Lookup",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: LookupRequest,
    ) => Effect.Effect<
      datastore.LookupResponse,
      datastore.LookupProjectsError,
      RuntimeContext
    >
  >
> {}

export const Lookup = Binding.Service<Lookup>("GCP.Datastore.Lookup");
