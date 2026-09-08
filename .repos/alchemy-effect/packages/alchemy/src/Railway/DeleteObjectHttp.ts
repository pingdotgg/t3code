import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeRailwayS3Binding } from "./BucketBinding.ts";
import { DeleteObject } from "./DeleteObject.ts";

/**
 * HTTP implementation of {@link DeleteObject}. Calls distilled S3
 * `deleteObject` against the Railway endpoint with the bucket's credentials.
 *
 * @layer
 * @provides Railway.DeleteObject
 */
export const DeleteObjectHttp = Layer.effect(
  DeleteObject,
  makeRailwayS3Binding({
    tag: "Railway.DeleteObject",
    operation: S3.deleteObject,
  }),
);
