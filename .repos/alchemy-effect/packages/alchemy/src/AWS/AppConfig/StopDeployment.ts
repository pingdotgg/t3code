import type * as appconfig from "@distilled.cloud/aws/appconfig";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";
import type { Environment } from "./Environment.ts";

export interface StopDeploymentRequest extends Omit<
  appconfig.StopDeploymentRequest,
  "ApplicationId" | "EnvironmentId"
> {}

/**
 * Stop (or revert) an AppConfig deployment from a Lambda (or other AWS
 * runtime). Stopping an in-progress rollout rolls it back; with
 * `AllowRevert: true` a completed deployment can be reverted within 72
 * hours.
 *
 * Provide `AppConfig.StopDeploymentHttp` on the hosting function's Effect to
 * implement the binding.
 *
 * @binding
 * @section Deploying Configuration at Runtime
 * @example Roll back an in-progress rollout
 * ```typescript
 * const stopDeployment = yield* AppConfig.StopDeployment(app, env);
 * yield* stopDeployment({ DeploymentNumber: 2 });
 * ```
 */
export interface StopDeployment extends Binding.Service<
  StopDeployment,
  "AWS.AppConfig.StopDeployment",
  (
    application: Application,
    environment: Environment,
  ) => Effect.Effect<
    (
      request: StopDeploymentRequest,
    ) => Effect.Effect<appconfig.Deployment, appconfig.StopDeploymentError>
  >
> {}
export const StopDeployment = Binding.Service<StopDeployment>(
  "AWS.AppConfig.StopDeployment",
);
