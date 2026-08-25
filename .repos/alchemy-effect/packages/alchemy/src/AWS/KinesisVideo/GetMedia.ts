import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvm from "@distilled.cloud/aws/kinesis-video-media";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetMediaRequest extends Omit<
  kvm.GetMediaInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesisvideo:GetMedia` (media data plane).
 *
 * Bind this operation to a `Stream` inside a function runtime to get a
 * callable that resolves the per-stream data endpoint (`GetDataEndpoint`)
 * and opens a media stream starting at the requested selector. The
 * response `Payload` is a streaming body of MKV-packaged media.
 * @binding
 * @section Reading Media
 * @example Read Media from the Earliest Fragment
 * ```typescript
 * // init
 * const getMedia = yield* AWS.KinesisVideo.GetMedia(stream);
 *
 * // runtime
 * const media = yield* getMedia({
 *   StartSelector: { StartSelectorType: "EARLIEST" },
 * });
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // Provide the GetMediaHttp layer on the Function's init Effect; merge
 * // with the other KinesisVideo layers when using several bindings.
 * export default MediaFunction.make(
 *   { main: import.meta.url, url: true, timeout: Duration.seconds(30) },
 *   Effect.gen(function* () {
 *     const stream = yield* AWS.KinesisVideo.Stream("Camera", {
 *       mediaType: "video/h264",
 *       dataRetention: "24 hours",
 *     });
 *     const getMedia = yield* AWS.KinesisVideo.GetMedia(stream);
 *     // ... read media.Payload in the fetch handler
 *     return { fetch: handler };
 *   }).pipe(Effect.provide(AWS.KinesisVideo.GetMediaHttp)),
 * );
 * ```
 */
export interface GetMedia extends Binding.Service<
  GetMedia,
  "AWS.KinesisVideo.GetMedia",
  <S extends Stream>(
    stream: S,
  ) => Effect.Effect<
    (
      request: GetMediaRequest,
    ) => Effect.Effect<
      kvm.GetMediaOutput,
      kvm.GetMediaError | kv.GetDataEndpointError
    >
  >
> {}

export const GetMedia = Binding.Service<GetMedia>("AWS.KinesisVideo.GetMedia");
