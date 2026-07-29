import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DescribeProjectVersions` — describe the model versions of a Rekognition project — training status, evaluation results, and hosting status.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DescribeProjectVersions` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DescribeProjectVersionsHttp)`.
 *
 * @binding
 * @section Custom Labels
 * @example Describe Model Versions
 * ```typescript
 * // init
 * const describeProjectVersions = yield* AWS.Rekognition.DescribeProjectVersions();
 *
 * // runtime
 * const page = yield* describeProjectVersions({ ProjectArn: projectArn });
 * // page.ProjectVersionDescriptions
 * ```
 */
export interface DescribeProjectVersions extends Binding.Service<
  DescribeProjectVersions,
  "AWS.Rekognition.DescribeProjectVersions",
  () => Effect.Effect<
    (
      request: rekognition.DescribeProjectVersionsRequest,
    ) => Effect.Effect<
      rekognition.DescribeProjectVersionsResponse,
      rekognition.DescribeProjectVersionsError
    >
  >
> {}
export const DescribeProjectVersions = Binding.Service<DescribeProjectVersions>(
  "AWS.Rekognition.DescribeProjectVersions",
);
