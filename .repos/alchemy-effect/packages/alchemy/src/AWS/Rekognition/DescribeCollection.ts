import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DescribeCollection` — describe a face collection — face count, face model version, ARN, and creation time.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DescribeCollection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DescribeCollectionHttp)`.
 *
 * @binding
 * @section Face Collections
 * @example Describe a Collection
 * ```typescript
 * // init
 * const describeCollection = yield* AWS.Rekognition.DescribeCollection();
 *
 * // runtime
 * const info = yield* describeCollection({ CollectionId: "tenant-42" });
 * // info.FaceCount, info.FaceModelVersion
 * ```
 */
export interface DescribeCollection extends Binding.Service<
  DescribeCollection,
  "AWS.Rekognition.DescribeCollection",
  () => Effect.Effect<
    (
      request: rekognition.DescribeCollectionRequest,
    ) => Effect.Effect<
      rekognition.DescribeCollectionResponse,
      rekognition.DescribeCollectionError
    >
  >
> {}
export const DescribeCollection = Binding.Service<DescribeCollection>(
  "AWS.Rekognition.DescribeCollection",
);
