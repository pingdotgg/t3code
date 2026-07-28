import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface ListFragmentsRequest extends Omit<
  kvam.ListFragmentsInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesisvideo:ListFragments` (archived media data
 * plane).
 *
 * Bind this operation to a `Stream` inside a function runtime to get a
 * callable that resolves the per-stream data endpoint (`GetDataEndpoint`)
 * and lists the media fragments stored in the requested timestamp range.
 * @binding
 * @section Reading Media
 * @example List Stored Fragments
 * ```typescript
 * // init
 * const listFragments = yield* AWS.KinesisVideo.ListFragments(stream);
 *
 * // runtime
 * const { Fragments } = yield* listFragments({
 *   FragmentSelector: {
 *     FragmentSelectorType: "SERVER_TIMESTAMP",
 *     TimestampRange: { StartTimestamp: start, EndTimestamp: end },
 *   },
 * });
 * ```
 */
export interface ListFragments extends Binding.Service<
  ListFragments,
  "AWS.KinesisVideo.ListFragments",
  <S extends Stream>(
    stream: S,
  ) => Effect.Effect<
    (
      request?: ListFragmentsRequest,
    ) => Effect.Effect<
      kvam.ListFragmentsOutput,
      kvam.ListFragmentsError | kv.GetDataEndpointError
    >
  >
> {}

export const ListFragments = Binding.Service<ListFragments>(
  "AWS.KinesisVideo.ListFragments",
);
