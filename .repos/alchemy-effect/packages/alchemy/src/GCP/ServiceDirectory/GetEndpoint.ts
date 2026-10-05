import type * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Endpoint } from "./Endpoint.ts";

export interface GetEndpointRequest extends Omit<
  servicedirectory.GetProjectsLocationsNamespacesServicesEndpointsRequest,
  "name"
> {}

/**
 * Runtime binding for Service Directory `endpoints.get`.
 *
 * Bind this operation to an {@link Endpoint} in a Function/Action init
 * phase. Provide {@link GetEndpointHttp}.
 *
 * ### Reading an Endpoint
 * **Example:** Get the bound endpoint
 * ```typescript
 * const getEndpoint = yield* GCP.ServiceDirectory.GetEndpoint(api);
 * const live = yield* getEndpoint();
 * ```
 *
 * @binding
 * @category ServiceDirectory
 */
export interface GetEndpoint extends Binding.Service<
  GetEndpoint,
  "GCP.ServiceDirectory.GetEndpoint",
  (
    endpoint: Endpoint,
  ) => Effect.Effect<
    (
      request?: GetEndpointRequest,
    ) => Effect.Effect<
      servicedirectory.Endpoint,
      servicedirectory.GetProjectsLocationsNamespacesServicesEndpointsError,
      RuntimeContext
    >
  >
> {}

export const GetEndpoint = Binding.Service<GetEndpoint>(
  "GCP.ServiceDirectory.GetEndpoint",
);
