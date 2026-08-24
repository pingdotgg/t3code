import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetMediaForFragmentListRequest extends Omit<
  kvam.GetMediaForFragmentListInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesisvideo:GetMediaForFragmentList` (archived
 * media data plane).
 *
 * Bind this operation to a `Stream` inside a function runtime to get a
 * callable that resolves the per-stream data endpoint (`GetDataEndpoint`)
 * and downloads MKV-packaged media for an explicit list of fragment
 * numbers (typically discovered via `ListFragments`). The response
 * `Payload` is a streaming body.
 * @binding
 * @section Reading Media
 * @example Fetch Media for Specific Fragments
 * ```typescript
 * // init
 * const getFragmentMedia =
 *   yield* AWS.KinesisVideo.GetMediaForFragmentList(stream);
 *
 * // runtime
 * const media = yield* getFragmentMedia({
 *   Fragments: fragments.map((f) => f.FragmentNumber!),
 * });
 * ```
 */
export interface GetMediaForFragmentList extends Binding.Service<
  GetMediaForFragmentList,
  "AWS.KinesisVideo.GetMediaForFragmentList",
  <S extends Stream>(
    stream: S,
  ) => Effect.Effect<
    (
      request: GetMediaForFragmentListRequest,
    ) => Effect.Effect<
      kvam.GetMediaForFragmentListOutput,
      kvam.GetMediaForFragmentListError | kv.GetDataEndpointError
    >
  >
> {}

export const GetMediaForFragmentList = Binding.Service<GetMediaForFragmentList>(
  "AWS.KinesisVideo.GetMediaForFragmentList",
);
