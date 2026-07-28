import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `DescribeInstances` operation scoped to the bound
 * {@link Instance} (IAM action `ec2:DescribeInstances`; `Describe*` actions
 * do not support resource-level permissions, so the grant is on `*`).
 *
 * Returns the bound instance's live description — state, addresses, block
 * device mappings — e.g. a Lambda that reports whether a dev box is running.
 * Provide the implementation with
 * `Effect.provide(AWS.EC2.DescribeInstanceHttp)`.
 * @binding
 * @section Observing Instances
 * @example Read the bound instance's live state
 * ```typescript
 * // init — bind the operation to the instance
 * const describeInstance = yield* AWS.EC2.DescribeInstance(instance);
 *
 * // runtime — read the live description
 * const live = yield* describeInstance();
 * console.log(live?.State?.Name, live?.PrivateIpAddress);
 * ```
 */
export interface DescribeInstance extends Binding.Service<
  DescribeInstance,
  "AWS.EC2.DescribeInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    () => Effect.Effect<ec2.Instance | undefined, ec2.DescribeInstancesError>
  >
> {}

export const DescribeInstance = Binding.Service<DescribeInstance>(
  "AWS.EC2.DescribeInstance",
);
