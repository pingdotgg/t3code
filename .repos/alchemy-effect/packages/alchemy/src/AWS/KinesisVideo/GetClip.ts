import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetClipRequest extends Omit<
  kvam.GetClipInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesisvideo:GetClip` (archived media data plane).
 *
 * Bind this operation to a `Stream` inside a function runtime to get a
 * callable that resolves the per-stream data endpoint (`GetDataEndpoint`)
 * and downloads an MP4 clip covering the requested fragment range. The
 * response `Payload` is a streaming body.
 * @binding
 * @section Reading Media
 * @example Download a Clip
 * ```typescript
 * // init
 * const getClip = yield* AWS.KinesisVideo.GetClip(stream);
 *
 * // runtime
 * const clip = yield* getClip({
 *   ClipFragmentSelector: {
 *     FragmentSelectorType: "SERVER_TIMESTAMP",
 *     TimestampRange: { StartTimestamp: start, EndTimestamp: end },
 *   },
 * });
 * ```
 */
export interface GetClip extends Binding.Service<
  GetClip,
  "AWS.KinesisVideo.GetClip",
  <S extends Stream>(
    stream: S,
  ) => Effect.Effect<
    (
      request: GetClipRequest,
    ) => Effect.Effect<
      kvam.GetClipOutput,
      kvam.GetClipError | kv.GetDataEndpointError
    >
  >
> {}

export const GetClip = Binding.Service<GetClip>("AWS.KinesisVideo.GetClip");
