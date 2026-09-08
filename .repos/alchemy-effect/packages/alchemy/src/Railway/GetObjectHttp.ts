import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeRailwayS3Binding } from "./BucketBinding.ts";
import { GetObject } from "./GetObject.ts";

/**
 * HTTP implementation of {@link GetObject}. Calls distilled S3
 * `getObject` against the Railway endpoint with the bucket's credentials.
 *
 * @layer
 * @provides Railway.GetObject
 */
export const GetObjectHttp = Layer.effect(
  GetObject,
  makeRailwayS3Binding({
    tag: "Railway.GetObject",
    operation: S3.getObject,
  }),
);
