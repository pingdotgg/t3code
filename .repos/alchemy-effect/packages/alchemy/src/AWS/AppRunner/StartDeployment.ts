import type * as apprunner from "@distilled.cloud/aws/apprunner";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

/**
 * Start a manual deployment of an App Runner {@link Service} from a Lambda
 * (or other AWS runtime) — App Runner re-pulls the latest image (or commit)
 * and rolls a new container fleet. The call is asynchronous; pair with
 * {@link ListOperations} to track the returned `OperationId` to completion.
 *
 * Provide `AppRunner.StartDeploymentHttp` on the hosting function's Effect
 * to implement the binding.
 *
 * @binding
 * @section Deploying at Runtime
 * @example Trigger a deployment and return its operation id
 * ```typescript
 * const startDeployment = yield* AppRunner.StartDeployment(service);
 * const { OperationId } = yield* startDeployment();
 * ```
 */
export interface StartDeployment extends Binding.Service<
  StartDeployment,
  "AWS.AppRunner.StartDeployment",
  (
    service: Service,
  ) => Effect.Effect<
    () => Effect.Effect<
      apprunner.StartDeploymentResponse,
      apprunner.StartDeploymentError
    >
  >
> {}
export const StartDeployment = Binding.Service<StartDeployment>(
  "AWS.AppRunner.StartDeployment",
);
