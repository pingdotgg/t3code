import type * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ServicesConnector } from "./ServicesConnector.ts";

export interface ExecuteQueryRequest extends Omit<
  firebasedataconnect.ExecuteQueryProjectsLocationsServicesConnectorsRequest,
  "name"
> {}

/**
 * Runtime binding for Data Connect `connectors.executeQuery`.
 *
 * Runs a named query defined on a {@link ServicesConnector}. Provide
 * {@link ExecuteQueryHttp}.
 *
 * ### Executing a Query
 * **Example:** Named connector query
 * ```typescript
 * const executeQuery = yield* GCP.FirebaseDataConnect.ExecuteQuery(
 *   connector,
 * );
 * const result = yield* executeQuery({
 *   body: { operationName: "ListNotes" },
 * });
 * ```
 *
 * @binding
 * @category FirebaseDataConnect
 */
export interface ExecuteQuery extends Binding.Service<
  ExecuteQuery,
  "GCP.FirebaseDataConnect.ExecuteQuery",
  (
    connector: ServicesConnector,
  ) => Effect.Effect<
    (
      request: ExecuteQueryRequest,
    ) => Effect.Effect<
      firebasedataconnect.ExecuteQueryResponse,
      firebasedataconnect.ExecuteQueryProjectsLocationsServicesConnectorsError,
      RuntimeContext
    >
  >
> {}

export const ExecuteQuery = Binding.Service<ExecuteQuery>(
  "GCP.FirebaseDataConnect.ExecuteQuery",
);
