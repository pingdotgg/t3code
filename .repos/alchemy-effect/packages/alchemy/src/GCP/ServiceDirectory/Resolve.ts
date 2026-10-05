import type * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Service } from "./Service.ts";

export interface ResolveRequest extends Omit<
  servicedirectory.ResolveProjectsLocationsNamespacesServicesRequest,
  "name"
> {}

/**
 * Runtime binding for Service Directory `services.resolve`.
 *
 * Looks up a {@link Service} and its endpoints. Bind this operation in a
 * Function/Action init phase. Provide {@link ResolveHttp}.
 *
 * ### Resolving a Service
 * **Example:** Resolve endpoints
 * ```typescript
 * const resolve = yield* GCP.ServiceDirectory.Resolve(api);
 * const { service } = yield* resolve();
 * ```
 *
 * **Example:** Filter endpoints
 * ```typescript
 * const { service } = yield* resolve({
 *   body: { endpointFilter: "port>8080", maxEndpoints: 10 },
 * });
 * ```
 *
 * @binding
 * @category ServiceDirectory
 */
export interface Resolve extends Binding.Service<
  Resolve,
  "GCP.ServiceDirectory.Resolve",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request?: ResolveRequest,
    ) => Effect.Effect<
      servicedirectory.ResolveServiceResponse,
      servicedirectory.ResolveProjectsLocationsNamespacesServicesError,
      RuntimeContext
    >
  >
> {}

export const Resolve = Binding.Service<Resolve>("GCP.ServiceDirectory.Resolve");
