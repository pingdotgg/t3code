import type * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Service } from "./Service.ts";

export interface ExecuteGraphqlRequest extends Omit<
  firebasedataconnect.ExecuteGraphqlProjectsLocationsServicesRequest,
  "name"
> {}

/**
 * Runtime binding for Data Connect `services.executeGraphql`.
 *
 * Executes any GraphQL query or mutation against the generated schema.
 * Provide {@link ExecuteGraphqlHttp}.
 *
 * ### Executing GraphQL
 * **Example:** Introspection-style query
 * ```typescript
 * const executeGraphql = yield* GCP.FirebaseDataConnect.ExecuteGraphql(
 *   service,
 * );
 * const result = yield* executeGraphql({
 *   body: { query: "{ __typename }" },
 * });
 * ```
 *
 * @binding
 * @category FirebaseDataConnect
 */
export interface ExecuteGraphql extends Binding.Service<
  ExecuteGraphql,
  "GCP.FirebaseDataConnect.ExecuteGraphql",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: ExecuteGraphqlRequest,
    ) => Effect.Effect<
      firebasedataconnect.GraphqlResponse,
      firebasedataconnect.ExecuteGraphqlProjectsLocationsServicesError,
      RuntimeContext
    >
  >
> {}

export const ExecuteGraphql = Binding.Service<ExecuteGraphql>(
  "GCP.FirebaseDataConnect.ExecuteGraphql",
);
