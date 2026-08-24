import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { PutObjectTagging } from "./PutObjectTagging.ts";

export const PutObjectTaggingHttp = Layer.effect(
  PutObjectTagging,
  makeBucketHttpBinding({
    tag: "AWS.S3.PutObjectTagging",
    operation: S3.putObjectTagging,
    actions: ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"],
  }),
);
