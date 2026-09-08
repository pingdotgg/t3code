import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeTigrisS3Binding } from "./BucketBinding.ts";
import { PutObject } from "./PutObject.ts";

/**
 * HTTP implementation of {@link PutObject}. Calls distilled S3
 * `putObject` against the Tigris endpoint with the bucket's credentials.
 *
 * @layer
 * @provides Fly.PutObject
 */
export const PutObjectHttp = Layer.effect(
  PutObject,
  makeTigrisS3Binding({
    tag: "Fly.PutObject",
    operation: S3.putObject,
  }),
);
