import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * `DescribeInstanceStatus` request with `InstanceIds` injected from the bound
 * {@link Instance}.
 */
export interface DescribeInstanceStatusRequest extends Omit<
  ec2.DescribeInstanceStatusRequest,
  "InstanceId" | "InstanceIds"
> {}

/**
 * Runtime binding for the `DescribeInstanceStatus` operation scoped to the
 * bound {@link Instance} (IAM action `ec2:DescribeInstanceStatus`;
 * `Describe*` actions do not support resource-level permissions, so the grant
 * is on `*`).
 *
 * Reads the instance's system/instance status checks and scheduled events —
 * e.g. a Lambda that alerts on failed reachability checks. Pass
 * `IncludeAllInstances: true` to also see the status while the instance is
 * stopped. Provide the implementation with
 * `Effect.provide(AWS.EC2.DescribeInstanceStatusHttp)`.
 * @binding
 * @section Observing Instances
 * @example Check the instance's status checks
 * ```typescript
 * // init — bind the operation to the instance
 * const describeStatus = yield* AWS.EC2.DescribeInstanceStatus(instance);
 *
 * // runtime — read status checks (even while stopped)
 * const result = yield* describeStatus({ IncludeAllInstances: true });
 * console.log(result.InstanceStatuses?.[0]?.InstanceStatus?.Status);
 * ```
 */
export interface DescribeInstanceStatus extends Binding.Service<
  DescribeInstanceStatus,
  "AWS.EC2.DescribeInstanceStatus",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: DescribeInstanceStatusRequest,
    ) => Effect.Effect<
      ec2.DescribeInstanceStatusResult,
      ec2.DescribeInstanceStatusError
    >
  >
> {}

export const DescribeInstanceStatus = Binding.Service<DescribeInstanceStatus>(
  "AWS.EC2.DescribeInstanceStatus",
);
