import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { DeleteObjectTagging } from "./DeleteObjectTagging.ts";

export const DeleteObjectTaggingHttp = Layer.effect(
  DeleteObjectTagging,
  makeBucketHttpBinding({
    tag: "AWS.S3.DeleteObjectTagging",
    operation: S3.deleteObjectTagging,
    actions: ["s3:DeleteObjectTagging", "s3:DeleteObjectVersionTagging"],
  }),
);
