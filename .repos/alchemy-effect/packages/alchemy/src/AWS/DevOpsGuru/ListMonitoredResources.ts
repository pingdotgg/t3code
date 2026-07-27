import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:ListMonitoredResources`.
 *
 * Lists the resources DevOps Guru is analyzing (or supports analyzing) — an audit of what the resource collection actually covers.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.ListMonitoredResourcesHttp)`.
 * @binding
 * @section Coverage Health
 * @example List Analyzed Resources
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listMonitoredResources = yield* AWS.DevOpsGuru.ListMonitoredResources();
 *
 * // runtime
 * const { MonitoredResourceIdentifiers } = yield* listMonitoredResources();
 * yield* Effect.log(`monitored: ${MonitoredResourceIdentifiers?.length}`);
 * ```
 */
export interface ListMonitoredResources extends Binding.Service<
  ListMonitoredResources,
  "AWS.DevOpsGuru.ListMonitoredResources",
  () => Effect.Effect<
    (
      request?: devopsguru.ListMonitoredResourcesRequest,
    ) => Effect.Effect<
      devopsguru.ListMonitoredResourcesResponse,
      devopsguru.ListMonitoredResourcesError
    >
  >
> {}
export const ListMonitoredResources = Binding.Service<ListMonitoredResources>(
  "AWS.DevOpsGuru.ListMonitoredResources",
);
