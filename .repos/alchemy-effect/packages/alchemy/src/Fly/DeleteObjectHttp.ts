import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeTigrisS3Binding } from "./BucketBinding.ts";
import { DeleteObject } from "./DeleteObject.ts";

/**
 * HTTP implementation of {@link DeleteObject}. Calls distilled S3
 * `deleteObject` against the Tigris endpoint with the bucket's credentials.
 *
 * @layer
 * @provides Fly.DeleteObject
 */
export const DeleteObjectHttp = Layer.effect(
  DeleteObject,
  makeTigrisS3Binding({
    tag: "Fly.DeleteObject",
    operation: S3.deleteObject,
  }),
);
