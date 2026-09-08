import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:PutLifecycleEventHookExecutionStatus` —
 * the canonical CodeDeploy data-plane call: a Lambda validation hook
 * (`BeforeAllowTraffic`/`AfterAllowTraffic` for Lambda deployments, plus
 * `BeforeInstall`/`AfterInstall`/`AfterAllowTestTraffic` for ECS) reports
 * `Succeeded` or `Failed` back to the paused deployment.
 * ### Lifecycle Hooks
 * **Example:** Report a Validation Result
 * ```typescript
 * const putHookStatus =
 *   yield* AWS.CodeDeploy.PutLifecycleEventHookExecutionStatus(group);
 *
 * yield* putHookStatus({
 *   deploymentId: event.DeploymentId,
 *   lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,
 *   status: "Succeeded",
 * });
 * ```
 *
 * @binding
 */
export interface PutLifecycleEventHookExecutionStatus extends Binding.Service<
  PutLifecycleEventHookExecutionStatus,
  "AWS.CodeDeploy.PutLifecycleEventHookExecutionStatus",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.PutLifecycleEventHookExecutionStatusInput,
    ) => Effect.Effect<
      SVC.PutLifecycleEventHookExecutionStatusOutput,
      SVC.PutLifecycleEventHookExecutionStatusError
    >
  >
> {}
export const PutLifecycleEventHookExecutionStatus =
  Binding.Service<PutLifecycleEventHookExecutionStatus>(
    "AWS.CodeDeploy.PutLifecycleEventHookExecutionStatus",
  );
