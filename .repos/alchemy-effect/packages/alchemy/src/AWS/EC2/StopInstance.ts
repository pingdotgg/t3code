import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * `StopInstances` request with `InstanceIds` injected from the bound
 * {@link Instance}.
 */
export interface StopInstanceRequest extends Omit<
  ec2.StopInstancesRequest,
  "InstanceId" | "InstanceIds"
> {}

/**
 * Runtime binding for the `StopInstances` operation scoped to the bound
 * {@link Instance} (IAM action `ec2:StopInstances` on the instance ARN).
 *
 * Stops the running instance — the other half of the scheduled
 * start/stop-Lambda pattern that powers dev fleets off overnight. Pass
 * `Hibernate: true` for hibernation-enabled instances. Provide the
 * implementation with `Effect.provide(AWS.EC2.StopInstanceHttp)`.
 * @binding
 * @section Instance Lifecycle Control
 * @example Stop the bound instance
 * ```typescript
 * // init — bind the operation to the instance
 * const stopInstance = yield* AWS.EC2.StopInstance(instance);
 *
 * // runtime — power the instance off
 * const result = yield* stopInstance();
 * console.log(result.StoppingInstances?.[0]?.CurrentState?.Name);
 * ```
 */
export interface StopInstance extends Binding.Service<
  StopInstance,
  "AWS.EC2.StopInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: StopInstanceRequest,
    ) => Effect.Effect<ec2.StopInstancesResult, ec2.StopInstancesError>
  >
> {}

export const StopInstance = Binding.Service<StopInstance>(
  "AWS.EC2.StopInstance",
);
