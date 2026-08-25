import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * `RebootInstances` request with `InstanceIds` injected from the bound
 * {@link Instance}.
 */
export interface RebootInstanceRequest extends Omit<
  ec2.RebootInstancesRequest,
  "InstanceId" | "InstanceIds"
> {}

/**
 * Runtime binding for the `RebootInstances` operation scoped to the bound
 * {@link Instance} (IAM action `ec2:RebootInstances` on the instance ARN).
 *
 * Requests an asynchronous reboot of the instance — e.g. a remediation Lambda
 * that bounces a wedged host after a failed health check. Provide the
 * implementation with `Effect.provide(AWS.EC2.RebootInstanceHttp)`.
 * @binding
 * @section Instance Lifecycle Control
 * @example Reboot the bound instance
 * ```typescript
 * // init — bind the operation to the instance
 * const rebootInstance = yield* AWS.EC2.RebootInstance(instance);
 *
 * // runtime — request the reboot (asynchronous)
 * yield* rebootInstance();
 * ```
 */
export interface RebootInstance extends Binding.Service<
  RebootInstance,
  "AWS.EC2.RebootInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: RebootInstanceRequest,
    ) => Effect.Effect<ec2.RebootInstancesResponse, ec2.RebootInstancesError>
  >
> {}

export const RebootInstance = Binding.Service<RebootInstance>(
  "AWS.EC2.RebootInstance",
);
