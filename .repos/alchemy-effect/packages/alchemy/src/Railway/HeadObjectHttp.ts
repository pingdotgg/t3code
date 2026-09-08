import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeRailwayS3Binding } from "./BucketBinding.ts";
import { HeadObject } from "./HeadObject.ts";

/**
 * HTTP implementation of {@link HeadObject}. Calls distilled S3
 * `headObject` against the Railway endpoint with the bucket's credentials.
 *
 * @layer
 * @provides Railway.HeadObject
 */
export const HeadObjectHttp = Layer.effect(
  HeadObject,
  makeRailwayS3Binding({
    tag: "Railway.HeadObject",
    operation: S3.headObject,
  }),
);
