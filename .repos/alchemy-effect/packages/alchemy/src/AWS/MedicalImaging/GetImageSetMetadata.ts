import type * as medicalimaging from "@distilled.cloud/aws/medical-imaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * `GetImageSetMetadata` request with `datastoreId` injected from the bound
 * data store.
 */
export interface GetImageSetMetadataRequest extends Omit<
  medicalimaging.GetImageSetMetadataRequest,
  "datastoreId"
> {}

/**
 * Runtime binding for the `GetImageSetMetadata` operation (IAM action
 * `medical-imaging:GetImageSetMetadata`), scoped to one {@link Datastore}.
 *
 * Streams the DICOM JSON metadata blob of an image set (gzip-encoded —
 * check `contentEncoding`). The metadata carries the patient/study/series
 * DICOM attributes plus the image frame ids used with {@link GetImageFrame}.
 * Provide the implementation with
 * `Effect.provide(AWS.MedicalImaging.GetImageSetMetadataHttp)`.
 *
 * @binding
 * @section Reading Image Sets
 * @example Read Image Set Metadata
 * ```typescript
 * const getMetadata = yield* MedicalImaging.GetImageSetMetadata(datastore);
 *
 * const metadata = yield* getMetadata({ imageSetId });
 * // metadata.imageSetMetadataBlob (streaming body), metadata.contentEncoding === "gzip"
 * ```
 */
export interface GetImageSetMetadata extends Binding.Service<
  GetImageSetMetadata,
  "AWS.MedicalImaging.GetImageSetMetadata",
  (
    datastore: Datastore,
  ) => Effect.Effect<
    (
      request: GetImageSetMetadataRequest,
    ) => Effect.Effect<
      medicalimaging.GetImageSetMetadataResponse,
      medicalimaging.GetImageSetMetadataError
    >
  >
> {}
export const GetImageSetMetadata = Binding.Service<GetImageSetMetadata>(
  "AWS.MedicalImaging.GetImageSetMetadata",
);
