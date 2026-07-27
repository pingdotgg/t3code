import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `elasticmapreduce:DescribeReleaseLabel` — reads one EMR release label — the applications (with versions) it ships and the OS releases it supports.
 * @binding
 * @section Release Catalog
 * @example Inspect a Release's Applications
 * ```typescript
 * const describeReleaseLabel = yield* AWS.EMR.DescribeReleaseLabel();
 *
 * const { Applications } = yield* describeReleaseLabel({
 *   ReleaseLabel: "emr-7.5.0",
 * });
 * ```
 */
export interface DescribeReleaseLabel extends Binding.Service<
  DescribeReleaseLabel,
  "AWS.EMR.DescribeReleaseLabel",
  () => Effect.Effect<
    (
      request?: SVC.DescribeReleaseLabelInput,
    ) => Effect.Effect<
      SVC.DescribeReleaseLabelOutput,
      SVC.DescribeReleaseLabelError
    >
  >
> {}
export const DescribeReleaseLabel = Binding.Service<DescribeReleaseLabel>(
  "AWS.EMR.DescribeReleaseLabel",
);
