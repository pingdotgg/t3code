import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Deployment } from "./Deployment.ts";

/**
 * Runtime binding for `greengrass:CancelDeployment`.
 *
 * Halts the bound {@link Deployment}'s rollout: core devices that already
 * received it keep running its components, but devices that have not yet
 * applied it never will. The deployment id is injected from the binding —
 * the canonical emergency-stop for a bad rollout. Provide the implementation
 * with `Effect.provide(AWS.GreengrassV2.CancelDeploymentHttp)`.
 * @binding
 * @section Monitoring Deployments
 * @example Emergency-Stop A Rollout
 * ```typescript
 * // init — bind the operation to the deployment
 * const cancelDeployment = yield* AWS.GreengrassV2.CancelDeployment(deployment);
 *
 * // runtime
 * yield* cancelDeployment();
 * ```
 */
export interface CancelDeployment extends Binding.Service<
  CancelDeployment,
  "AWS.GreengrassV2.CancelDeployment",
  (
    deployment: Deployment,
  ) => Effect.Effect<
    (
      request?: Omit<greengrassv2.CancelDeploymentRequest, "deploymentId">,
    ) => Effect.Effect<
      greengrassv2.CancelDeploymentResponse,
      greengrassv2.CancelDeploymentError
    >
  >
> {}
export const CancelDeployment = Binding.Service<CancelDeployment>(
  "AWS.GreengrassV2.CancelDeployment",
);
