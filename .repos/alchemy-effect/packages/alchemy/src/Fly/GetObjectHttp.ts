import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeTigrisS3Binding } from "./BucketBinding.ts";
import { GetObject } from "./GetObject.ts";

/**
 * HTTP implementation of {@link GetObject}. Calls distilled S3
 * `getObject` against the Tigris endpoint with the bucket's credentials.
 *
 * @layer
 * @provides Fly.GetObject
 */
export const GetObjectHttp = Layer.effect(
  GetObject,
  makeTigrisS3Binding({
    tag: "Fly.GetObject",
    operation: S3.getObject,
  }),
);
