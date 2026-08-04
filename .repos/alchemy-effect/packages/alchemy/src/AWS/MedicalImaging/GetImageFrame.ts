import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `GetImageFrame` request with `datastoreId` injected from the bound data
 * store.
 */
export interface GetImageFrameRequest extends Omit<
  medicalimaging.GetImageFrameRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `GetImageFrame` operation (IAM action
 * `medical-imaging:GetImageFrame`), scoped to one {@link Datastore}.
 *
 * Streams the pixel data of a single image frame (HTJ2K- or
 * JPEG2000-encoded, per the data store's `losslessStorageFormat`). Image
 * frame ids come from the image set metadata blob read with
 * {@link GetImageSetMetadata}. Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.GetImageFrameHttp)`.
 *
 * @binding
 * @section Reading Image Frames
 * @example Fetch an Image Frame's Pixel Data
 * ```typescript
 * const getImageFrame = yield* MedicalImaging.GetImageFrame(datastore);
 *
 * const frame = yield* getImageFrame({
 *   imageSetId,
 *   imageFrameInformation: { imageFrameId },
 * });
 * // frame.imageFrameBlob (streaming body), frame.contentType
 * ```
 */
export interface GetImageFrame extends Binding.Service<
  GetImageFrame,
  "AWS.MedicalImaging.GetImageFrame",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request: GetImageFrameRequest,
    ) => Effect.Effect<
      medicalimaging.GetImageFrameResponse,
      medicalimaging.GetImageFrameError
    >
  >
> {}
export const GetImageFrame = Binding.Service<GetImageFrame>(
  "AWS.MedicalImaging.GetImageFrame",
);
