import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link GetResourceDashboard} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type GetResourceDashboardInput = Omit<
  emr.GetResourceDashboardRequest,
  "applicationId"
>;

/**
 * Runtime binding for `emr-serverless:GetResourceDashboard`.
 *
 * Creates a pre-signed dashboard URL for a specific resource (e.g. a
 * worker) of the bound {@link Application}. Provide the implementation with
 * `Effect.provide(AWS.EMRServerless.GetResourceDashboardHttp)`.
 * @binding
 * @section Dashboards
 * @example Link To A Resource Dashboard
 * ```typescript
 * // init
 * const getResourceDashboard =
 *   yield* AWS.EMRServerless.GetResourceDashboard(app);
 *
 * // runtime
 * const { url } = yield* getResourceDashboard({ resourceId, resourceType });
 * ```
 */
export interface GetResourceDashboard extends Binding.Service<
  GetResourceDashboard,
  "AWS.EMRServerless.GetResourceDashboard",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: GetResourceDashboardInput,
    ) => Effect.Effect<
      emr.GetResourceDashboardResponse,
      emr.GetResourceDashboardError
    >
  >
> {}
export const GetResourceDashboard = Binding.Service<GetResourceDashboard>(
  "AWS.EMRServerless.GetResourceDashboard",
);
