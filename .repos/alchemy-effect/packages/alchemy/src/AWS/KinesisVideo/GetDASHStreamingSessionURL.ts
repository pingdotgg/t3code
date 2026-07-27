import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetDASHStreamingSessionURLRequest extends Omit<
  kvam.GetDASHStreamingSessionURLInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesisvideo:GetDASHStreamingSessionURL` (archived
 * media data plane).
 *
 * Bind this operation to a `Stream` inside a function runtime to get a
 * callable that resolves the per-stream data endpoint (`GetDataEndpoint`)
 * and returns a short-lived MPEG-DASH playback URL.
 * @binding
 * @section Reading Media
 * @example Live DASH Playback URL
 * ```typescript
 * // init
 * const getDash = yield* AWS.KinesisVideo.GetDASHStreamingSessionURL(stream);
 *
 * // runtime
 * const { DASHStreamingSessionURL } = yield* getDash({
 *   PlaybackMode: "LIVE",
 * });
 * ```
 */
export interface GetDASHStreamingSessionURL extends Binding.Service<
  GetDASHStreamingSessionURL,
  "AWS.KinesisVideo.GetDASHStreamingSessionURL",
  <S extends Stream>(
    stream: S,
  ) => Effect.Effect<
    (
      request?: GetDASHStreamingSessionURLRequest,
    ) => Effect.Effect<
      kvam.GetDASHStreamingSessionURLOutput,
      kvam.GetDASHStreamingSessionURLError | kv.GetDataEndpointError
    >
  >
> {}

export const GetDASHStreamingSessionURL =
  Binding.Service<GetDASHStreamingSessionURL>(
    "AWS.KinesisVideo.GetDASHStreamingSessionURL",
  );
