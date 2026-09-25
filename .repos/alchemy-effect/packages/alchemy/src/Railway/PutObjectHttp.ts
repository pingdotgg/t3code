import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeRailwayS3Binding } from "./BucketBinding.ts";
import { PutObject } from "./PutObject.ts";

/**
 * HTTP implementation of {@link PutObject}. Calls distilled S3
 * `putObject` against the Railway endpoint with the bucket's credentials.
 *
 * @layer
 * @provides Railway.PutObject
 */
export const PutObjectHttp = Layer.effect(
  PutObject,
  makeRailwayS3Binding({
    tag: "Railway.PutObject",
    operation: S3.putObject,
  }),
);
