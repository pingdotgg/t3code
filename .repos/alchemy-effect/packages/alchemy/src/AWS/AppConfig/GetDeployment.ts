import type * as appconfig from "@distilled.cloud/aws/appconfig";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";
import type { Environment } from "./Environment.ts";

export interface GetDeploymentRequest extends Omit<
  appconfig.GetDeploymentRequest,
  "ApplicationId" | "EnvironmentId"
> {}

/**
 * Read an AppConfig deployment's status from a Lambda (or other AWS runtime)
 * — poll a rollout started with {@link StartDeployment} until it reaches a
 * terminal state (`COMPLETE`, `ROLLED_BACK`, `REVERTED`).
 *
 * Provide `AppConfig.GetDeploymentHttp` on the hosting function's Effect to
 * implement the binding.
 *
 * @binding
 * @section Deploying Configuration at Runtime
 * @example Check a rollout's progress
 * ```typescript
 * const getDeployment = yield* AppConfig.GetDeployment(app, env);
 * const deployment = yield* getDeployment({ DeploymentNumber: 2 });
 * // deployment.State, deployment.PercentageComplete
 * ```
 */
export interface GetDeployment extends Binding.Service<
  GetDeployment,
  "AWS.AppConfig.GetDeployment",
  (
    application: Application,
    environment: Environment,
  ) => Effect.Effect<
    (
      request: GetDeploymentRequest,
    ) => Effect.Effect<appconfig.Deployment, appconfig.GetDeploymentError>
  >
> {}
export const GetDeployment = Binding.Service<GetDeployment>(
  "AWS.AppConfig.GetDeployment",
);
