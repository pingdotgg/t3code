import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { GetObjectTagging } from "./GetObjectTagging.ts";

export const GetObjectTaggingHttp = Layer.effect(
  GetObjectTagging,
  makeBucketHttpBinding({
    tag: "AWS.S3.GetObjectTagging",
    operation: S3.getObjectTagging,
    actions: ["s3:GetObjectTagging", "s3:GetObjectVersionTagging"],
  }),
);
