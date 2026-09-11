import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeRailwayS3Binding } from "./BucketBinding.ts";
import { ListObjectsV2 } from "./ListObjectsV2.ts";

/**
 * HTTP implementation of {@link ListObjectsV2}. Calls distilled S3
 * `listObjectsV2` against the Railway endpoint with the bucket's credentials.
 *
 * @layer
 * @provides Railway.ListObjectsV2
 */
export const ListObjectsV2Http = Layer.effect(
  ListObjectsV2,
  makeRailwayS3Binding({
    tag: "Railway.ListObjectsV2",
    operation: S3.listObjectsV2,
  }),
);
