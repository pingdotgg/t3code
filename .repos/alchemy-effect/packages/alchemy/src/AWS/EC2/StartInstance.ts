import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * `StartInstances` request with `InstanceIds` injected from the bound
 * {@link Instance}.
 */
export interface StartInstanceRequest extends Omit<
  ec2.StartInstancesRequest,
  "InstanceId" | "InstanceIds"
> {}

/**
 * Runtime binding for the `StartInstances` operation scoped to the bound
 * {@link Instance} (IAM action `ec2:StartInstances` on the instance ARN).
 *
 * Starts the stopped instance — the classic scheduled Lambda that powers dev
 * boxes on in the morning. Starting an already-running instance succeeds
 * without effect. Provide the implementation with
 * `Effect.provide(AWS.EC2.StartInstanceHttp)`.
 * @binding
 * @section Instance Lifecycle Control
 * @example Start the bound instance
 * ```typescript
 * // init — bind the operation to the instance
 * const startInstance = yield* AWS.EC2.StartInstance(instance);
 *
 * // runtime — power the instance on
 * const result = yield* startInstance();
 * console.log(result.StartingInstances?.[0]?.CurrentState?.Name);
 * ```
 */
export interface StartInstance extends Binding.Service<
  StartInstance,
  "AWS.EC2.StartInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: StartInstanceRequest,
    ) => Effect.Effect<ec2.StartInstancesResult, ec2.StartInstancesError>
  >
> {}

export const StartInstance = Binding.Service<StartInstance>(
  "AWS.EC2.StartInstance",
);
