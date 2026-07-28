import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:ListEffectiveDeployments`.
 *
 * Enumerates the deployments that apply to a core device, with each one's
 * per-device execution status (`SUCCEEDED`, `FAILED`, `IN_PROGRESS`, …) —
 * how a rollout monitor tracks a deployment landing on real hardware. The
 * caller supplies the core device thing name at runtime. Provide the
 * implementation with
 * `Effect.provide(AWS.GreengrassV2.ListEffectiveDeploymentsHttp)`.
 * @binding
 * @section Managing Core Devices
 * @example Track A Rollout On A Device
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listEffectiveDeployments = yield* AWS.GreengrassV2.ListEffectiveDeployments();
 *
 * // runtime
 * const { effectiveDeployments } = yield* listEffectiveDeployments({
 *   coreDeviceThingName: "MyCore",
 * });
 * ```
 */
export interface ListEffectiveDeployments extends Binding.Service<
  ListEffectiveDeployments,
  "AWS.GreengrassV2.ListEffectiveDeployments",
  () => Effect.Effect<
    (
      request: greengrassv2.ListEffectiveDeploymentsRequest,
    ) => Effect.Effect<
      greengrassv2.ListEffectiveDeploymentsResponse,
      greengrassv2.ListEffectiveDeploymentsError
    >
  >
> {}
export const ListEffectiveDeployments =
  Binding.Service<ListEffectiveDeployments>(
    "AWS.GreengrassV2.ListEffectiveDeployments",
  );
