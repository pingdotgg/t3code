import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DescribeProjects` — describe the Rekognition projects (Custom Labels projects and custom moderation adapters) in the account.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DescribeProjects` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DescribeProjectsHttp)`.
 *
 * @binding
 * @section Custom Labels
 * @example List Projects
 * ```typescript
 * // init
 * const describeProjects = yield* AWS.Rekognition.DescribeProjects();
 *
 * // runtime
 * const page = yield* describeProjects({ MaxResults: 10 });
 * // page.ProjectDescriptions
 * ```
 */
export interface DescribeProjects extends Binding.Service<
  DescribeProjects,
  "AWS.Rekognition.DescribeProjects",
  () => Effect.Effect<
    (
      request?: rekognition.DescribeProjectsRequest,
    ) => Effect.Effect<
      rekognition.DescribeProjectsResponse,
      rekognition.DescribeProjectsError
    >
  >
> {}
export const DescribeProjects = Binding.Service<DescribeProjects>(
  "AWS.Rekognition.DescribeProjects",
);
