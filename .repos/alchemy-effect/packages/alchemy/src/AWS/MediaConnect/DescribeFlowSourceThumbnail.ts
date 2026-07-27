import type * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

/**
 * Runtime binding for `mediaconnect:DescribeFlowSourceThumbnail`.
 *
 * Fetches a thumbnail of the content currently arriving at the bound
 * {@link Flow}'s source (base64-encoded, refreshed every few seconds) —
 * the building block for visual confidence monitoring. Thumbnails are
 * only generated while the flow is running and `sourceMonitoringConfig`
 * has thumbnails enabled; otherwise the response carries
 * `ThumbnailMessages` explaining why no image is available. The flow ARN
 * is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaConnect.DescribeFlowSourceThumbnailHttp)`.
 * @binding
 * @section Observing Flows
 * @example Render a Confidence Thumbnail
 * ```typescript
 * // init — bind the operation to the flow
 * const sourceThumbnail = yield* AWS.MediaConnect.DescribeFlowSourceThumbnail(flow);
 *
 * // runtime
 * const { ThumbnailDetails } = yield* sourceThumbnail();
 * const image = ThumbnailDetails?.Thumbnail; // base64-encoded JPEG
 * ```
 */
export interface DescribeFlowSourceThumbnail extends Binding.Service<
  DescribeFlowSourceThumbnail,
  "AWS.MediaConnect.DescribeFlowSourceThumbnail",
  (
    flow: Flow,
  ) => Effect.Effect<
    () => Effect.Effect<
      mediaconnect.DescribeFlowSourceThumbnailResponse,
      mediaconnect.DescribeFlowSourceThumbnailError
    >
  >
> {}
export const DescribeFlowSourceThumbnail =
  Binding.Service<DescribeFlowSourceThumbnail>(
    "AWS.MediaConnect.DescribeFlowSourceThumbnail",
  );
