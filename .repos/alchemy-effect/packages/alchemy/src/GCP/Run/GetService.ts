import type * as cloudrun from "@distilled.cloud/gcp/run_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Service } from "./Service.ts";

export interface GetServiceRequest extends Omit<
  cloudrun.GetProjectsLocationsServicesRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Run `services.get`.
 *
 * Bind this operation to a {@link Service} in a Function/Action init phase.
 * Provide {@link GetServiceHttp}.
 *
 * ### Reading a Service
 * **Example:** Get the bound service
 * ```typescript
 * const getService = yield* GCP.Run.GetService(api);
 * const live = yield* getService();
 * ```
 *
 * @binding
 * @category Run
 */
export interface GetService extends Binding.Service<
  GetService,
  "GCP.Run.GetService",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request?: GetServiceRequest,
    ) => Effect.Effect<
      cloudrun.GoogleCloudRunV2Service,
      cloudrun.GetProjectsLocationsServicesError,
      RuntimeContext
    >
  >
> {}

export const GetService = Binding.Service<GetService>("GCP.Run.GetService");
