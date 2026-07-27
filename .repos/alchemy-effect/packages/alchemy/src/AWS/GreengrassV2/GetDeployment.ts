import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Deployment } from "./Deployment.ts";

/**
 * Runtime binding for `greengrass:GetDeployment`.
 *
 * Reads the bound {@link Deployment}'s full detail — status (`ACTIVE`,
 * `COMPLETED`, `CANCELED`, `FAILED`), component specs, IoT job linkage, and
 * whether it is still the latest revision for its target — so a function can
 * monitor a rollout. The deployment id is injected from the binding. Provide
 * the implementation with
 * `Effect.provide(AWS.GreengrassV2.GetDeploymentHttp)`.
 * @binding
 * @section Monitoring Deployments
 * @example Check A Deployment's Status
 * ```typescript
 * // init — bind the operation to the deployment
 * const getDeployment = yield* AWS.GreengrassV2.GetDeployment(deployment);
 *
 * // runtime
 * const detail = yield* getDeployment();
 * yield* Effect.log(`rollout is ${detail.deploymentStatus}`);
 * ```
 */
export interface GetDeployment extends Binding.Service<
  GetDeployment,
  "AWS.GreengrassV2.GetDeployment",
  (
    deployment: Deployment,
  ) => Effect.Effect<
    (
      request?: Omit<greengrassv2.GetDeploymentRequest, "deploymentId">,
    ) => Effect.Effect<
      greengrassv2.GetDeploymentResponse,
      greengrassv2.GetDeploymentError
    >
  >
> {}
export const GetDeployment = Binding.Service<GetDeployment>(
  "AWS.GreengrassV2.GetDeployment",
);
