import type * as ec2 from "@distilled.cloud/aws/ec2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FindImageOptions } from "./Image.ts";

/**
 * The `DescribeImages`-backed AMI lookup (IAM action `ec2:DescribeImages`;
 * `Describe*` actions do not support resource-level permissions, so the
 * runtime grant is on `*`). Returns the newest available image matching the
 * filters, or `undefined` when nothing matches.
 *
 * As a **data source**, invoke it at plan time via {@link getAmi} — the
 * result is an `Output` resolved during plan/deploy and inert inside
 * deployed bundles. As a **runtime binding**, bind it inside a Function to
 * look images up at runtime with the IAM grant attached automatically.
 * Provide the implementation with
 * `Effect.provide(AWS.EC2.GetAmiHttp)` (already registered by
 * `AWS.providers()` for plan-time use).
 * ### Looking Up Images
 * **Example:** Plan-time lookup (data source)
 * ```typescript
 * const instance = yield* AWS.EC2.Instance("web", {
 *   imageId: AWS.EC2.getAmi({
 *     owners: ["amazon"],
 *     name: ["al2023-ami-2023.*"],
 *   }).ImageId.as<string>(),
 *   instanceType: "t3.micro",
 *   subnetId: subnet.subnetId,
 * });
 * ```
 * **Example:** Runtime lookup inside a Function
 * ```typescript
 * // init — bind the operation
 * const getAmi = yield* AWS.EC2.GetAmi({
 *   owners: ["amazon"],
 *   name: ["al2023-ami-2023.*"],
 * });
 *
 * // runtime — read the newest matching image
 * const latest = yield* getAmi();
 * console.log(latest?.ImageId, latest?.CreationDate);
 * ```
 *
 * @binding
 */
export interface GetAmi extends Binding.Service<
  GetAmi,
  "AWS.EC2.GetAmi",
  (
    options: FindImageOptions,
  ) => Effect.Effect<
    () => Effect.Effect<ec2.Image | undefined, ec2.DescribeImagesError>
  >
> {}

export const GetAmi = Binding.Service<GetAmi>("AWS.EC2.GetAmi");

/**
 * Plan-time AMI lookup — the data-source form of {@link GetAmi} (what
 * Terraform calls a data source and Pulumi an invoke). Returns an
 * `Output<ec2.Image | undefined>` resolved during plan/deploy; safe to call
 * from composition code that is re-executed inside a deployed runtime
 * bundle. Prefer {@link image} (or the distro presets) when you only need
 * the AMI ID and want a missing image to fail the plan.
 */
export const getAmi = GetAmi.execute;
