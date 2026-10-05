import type * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ServicesConnector } from "./ServicesConnector.ts";

export interface ExecuteMutationRequest extends Omit<
  firebasedataconnect.ExecuteMutationProjectsLocationsServicesConnectorsRequest,
  "name"
> {}

/**
 * Runtime binding for Data Connect `connectors.executeMutation`.
 *
 * Runs a named mutation defined on a {@link ServicesConnector}. Provide
 * {@link ExecuteMutationHttp}.
 *
 * ### Executing a Mutation
 * **Example:** Named connector mutation
 * ```typescript
 * const executeMutation = yield* GCP.FirebaseDataConnect.ExecuteMutation(
 *   connector,
 * );
 * const result = yield* executeMutation({
 *   body: {
 *     operationName: "CreateNote",
 *     variables: { title: "hello" },
 *   },
 * });
 * ```
 *
 * @binding
 * @category FirebaseDataConnect
 */
export interface ExecuteMutation extends Binding.Service<
  ExecuteMutation,
  "GCP.FirebaseDataConnect.ExecuteMutation",
  (
    connector: ServicesConnector,
  ) => Effect.Effect<
    (
      request: ExecuteMutationRequest,
    ) => Effect.Effect<
      firebasedataconnect.ExecuteMutationResponse,
      firebasedataconnect.ExecuteMutationProjectsLocationsServicesConnectorsError,
      RuntimeContext
    >
  >
> {}

export const ExecuteMutation = Binding.Service<ExecuteMutation>(
  "GCP.FirebaseDataConnect.ExecuteMutation",
);
