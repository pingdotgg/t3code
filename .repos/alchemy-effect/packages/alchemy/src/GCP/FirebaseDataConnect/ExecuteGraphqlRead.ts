import type * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Service } from "./Service.ts";

export interface ExecuteGraphqlReadRequest extends Omit<
  firebasedataconnect.ExecuteGraphqlReadProjectsLocationsServicesRequest,
  "name"
> {}

/**
 * Runtime binding for Data Connect `services.executeGraphqlRead`.
 *
 * Same as {@link ExecuteGraphql} but rejects mutations. Provide
 * {@link ExecuteGraphqlReadHttp}.
 *
 * ### Reading GraphQL
 * **Example:** Read-only query
 * ```typescript
 * const executeGraphqlRead =
 *   yield* GCP.FirebaseDataConnect.ExecuteGraphqlRead(service);
 * const result = yield* executeGraphqlRead({
 *   body: { query: "{ __typename }" },
 * });
 * ```
 *
 * @binding
 * @category FirebaseDataConnect
 */
export interface ExecuteGraphqlRead extends Binding.Service<
  ExecuteGraphqlRead,
  "GCP.FirebaseDataConnect.ExecuteGraphqlRead",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: ExecuteGraphqlReadRequest,
    ) => Effect.Effect<
      firebasedataconnect.GraphqlResponse,
      firebasedataconnect.ExecuteGraphqlReadProjectsLocationsServicesError,
      RuntimeContext
    >
  >
> {}

export const ExecuteGraphqlRead = Binding.Service<ExecuteGraphqlRead>(
  "GCP.FirebaseDataConnect.ExecuteGraphqlRead",
);
