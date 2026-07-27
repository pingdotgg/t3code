import type * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

/**
 * Runtime binding for `mediaconnect:DescribeFlowSourceMetadata`.
 *
 * Reads the bound {@link Flow}'s ingest transport-stream metadata — the
 * programs and their video/audio/data streams — plus status messages about
 * the source. Useful for confidence monitoring of what is actually
 * arriving at the flow. A flow whose source is not currently receiving
 * content answers with `Messages` instead of media info. The flow ARN is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaConnect.DescribeFlowSourceMetadataHttp)`.
 * @binding
 * @section Observing Flows
 * @example Inspect the Incoming Transport Stream
 * ```typescript
 * // init — bind the operation to the flow
 * const sourceMetadata = yield* AWS.MediaConnect.DescribeFlowSourceMetadata(flow);
 *
 * // runtime
 * const { TransportMediaInfo, Messages } = yield* sourceMetadata();
 * const programs = TransportMediaInfo?.Programs ?? [];
 * ```
 */
export interface DescribeFlowSourceMetadata extends Binding.Service<
  DescribeFlowSourceMetadata,
  "AWS.MediaConnect.DescribeFlowSourceMetadata",
  (
    flow: Flow,
  ) => Effect.Effect<
    () => Effect.Effect<
      mediaconnect.DescribeFlowSourceMetadataResponse,
      mediaconnect.DescribeFlowSourceMetadataError
    >
  >
> {}
export const DescribeFlowSourceMetadata =
  Binding.Service<DescribeFlowSourceMetadata>(
    "AWS.MediaConnect.DescribeFlowSourceMetadata",
  );
