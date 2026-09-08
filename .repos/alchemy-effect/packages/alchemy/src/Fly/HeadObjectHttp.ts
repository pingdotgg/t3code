import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeTigrisS3Binding } from "./BucketBinding.ts";
import { HeadObject } from "./HeadObject.ts";

/**
 * HTTP implementation of {@link HeadObject}. Calls distilled S3
 * `headObject` against the Tigris endpoint with the bucket's credentials.
 *
 * @layer
 * @provides Fly.HeadObject
 */
export const HeadObjectHttp = Layer.effect(
  HeadObject,
  makeTigrisS3Binding({
    tag: "Fly.HeadObject",
    operation: S3.headObject,
  }),
);
