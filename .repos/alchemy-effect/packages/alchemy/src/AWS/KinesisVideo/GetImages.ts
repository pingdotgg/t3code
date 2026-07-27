import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetImagesRequest extends Omit<
  kvam.GetImagesInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesisvideo:GetImages` (archived media data plane).
 *
 * Bind this operation to a `Stream` inside a function runtime to get a
 * callable that resolves the per-stream data endpoint (`GetDataEndpoint`)
 * and extracts base64-encoded still images (JPEG/PNG) from the stored
 * media at the requested sampling interval.
 * @binding
 * @section Reading Media
 * @example Extract Thumbnails
 * ```typescript
 * // init
 * const getImages = yield* AWS.KinesisVideo.GetImages(stream);
 *
 * // runtime
 * const { Images } = yield* getImages({
 *   ImageSelectorType: "SERVER_TIMESTAMP",
 *   StartTimestamp: start,
 *   EndTimestamp: end,
 *   Format: "JPEG",
 * });
 * ```
 */
export interface GetImages extends Binding.Service<
  GetImages,
  "AWS.KinesisVideo.GetImages",
  <S extends Stream>(
    stream: S,
  ) => Effect.Effect<
    (
      request: GetImagesRequest,
    ) => Effect.Effect<
      kvam.GetImagesOutput,
      kvam.GetImagesError | kv.GetDataEndpointError
    >
  >
> {}

export const GetImages = Binding.Service<GetImages>(
  "AWS.KinesisVideo.GetImages",
);
