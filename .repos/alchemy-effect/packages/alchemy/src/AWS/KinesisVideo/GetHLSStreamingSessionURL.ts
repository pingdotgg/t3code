import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetHLSStreamingSessionURLRequest extends Omit<
  kvam.GetHLSStreamingSessionURLInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesisvideo:GetHLSStreamingSessionURL` (archived
 * media data plane).
 *
 * Bind this operation to a `Stream` inside a function runtime to get a
 * callable that resolves the per-stream data endpoint (`GetDataEndpoint`)
 * and returns a short-lived HLS playback URL.
 * @binding
 * @section Reading Media
 * @example Live HLS Playback URL
 * ```typescript
 * // init
 * const getHls = yield* AWS.KinesisVideo.GetHLSStreamingSessionURL(stream);
 *
 * // runtime
 * const { HLSStreamingSessionURL } = yield* getHls({
 *   PlaybackMode: "LIVE",
 * });
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // Provide the GetHLSStreamingSessionURLHttp layer on the Function's
 * // init Effect. Data-plane calls fan out to GetDataEndpoint first, so
 * // allow a generous timeout.
 * export default PlaybackFunction.make(
 *   { main: import.meta.url, url: true, timeout: Duration.seconds(30) },
 *   Effect.gen(function* () {
 *     const stream = yield* AWS.KinesisVideo.Stream("Camera", {
 *       mediaType: "video/h264",
 *       dataRetention: "24 hours",
 *     });
 *     const getHls = yield* AWS.KinesisVideo.GetHLSStreamingSessionURL(stream);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { HLSStreamingSessionURL } = yield* getHls({
 *           PlaybackMode: "LIVE",
 *         });
 *         return HttpServerResponse.json({ url: HLSStreamingSessionURL });
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.KinesisVideo.GetHLSStreamingSessionURLHttp)),
 * );
 * ```
 */
export interface GetHLSStreamingSessionURL extends Binding.Service<
  GetHLSStreamingSessionURL,
  "AWS.KinesisVideo.GetHLSStreamingSessionURL",
  <S extends Stream>(
    stream: S,
  ) => Effect.Effect<
    (
      request?: GetHLSStreamingSessionURLRequest,
    ) => Effect.Effect<
      kvam.GetHLSStreamingSessionURLOutput,
      kvam.GetHLSStreamingSessionURLError | kv.GetDataEndpointError
    >
  >
> {}

export const GetHLSStreamingSessionURL =
  Binding.Service<GetHLSStreamingSessionURL>(
    "AWS.KinesisVideo.GetHLSStreamingSessionURL",
  );
