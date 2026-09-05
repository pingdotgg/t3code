import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { UploadPartCopy } from "./UploadPartCopy.ts";

export const UploadPartCopyHttp = Layer.effect(
  UploadPartCopy,
  makeBucketHttpBinding({
    tag: "AWS.S3.UploadPartCopy",
    operation: S3.uploadPartCopy,
    actions: ["s3:PutObject", "s3:GetObject"],
  }),
);
