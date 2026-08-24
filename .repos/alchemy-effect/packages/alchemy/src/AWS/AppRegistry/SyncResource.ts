import type * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:SyncResource`.
 *
 * Re-syncs a resource's AppRegistry system tags (`awsApplication`) with its
 * associated application — useful in remediation functions that repair
 * drifted application tags. The caller additionally needs permission to read
 * and update the target resource itself (e.g. `cloudformation:UpdateStack` +
 * `tag:GetResources` for a CloudFormation stack); grant those on the host
 * separately. Provide the implementation with
 * `Effect.provide(AWS.AppRegistry.SyncResourceHttp)`.
 * @binding
 * @section Syncing Resources
 * @example Re-sync a CloudFormation Stack's Application Tag
 * ```typescript
 * // init — account-level, no resource argument
 * const syncResource = yield* AWS.AppRegistry.SyncResource();
 *
 * // runtime
 * const result = yield* syncResource({
 *   resourceType: "CFN_STACK",
 *   resource: "my-stack",
 * });
 * console.log(result.actionTaken);
 * ```
 */
export interface SyncResource extends Binding.Service<
  SyncResource,
  "AWS.AppRegistry.SyncResource",
  () => Effect.Effect<
    (
      request: appregistry.SyncResourceRequest,
    ) => Effect.Effect<
      appregistry.SyncResourceResponse,
      appregistry.SyncResourceError
    >
  >
> {}

export const SyncResource = Binding.Service<SyncResource>(
  "AWS.AppRegistry.SyncResource",
);
