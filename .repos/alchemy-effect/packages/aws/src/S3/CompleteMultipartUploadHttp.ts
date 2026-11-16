import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { CompleteMultipartUpload } from "./CompleteMultipartUpload.ts";

export const CompleteMultipartUploadHttp = Layer.effect(
  CompleteMultipartUpload,
  makeBucketHttpBinding({
    tag: "AWS.S3.CompleteMultipartUpload",
    operation: S3.completeMultipartUpload,
    actions: ["s3:PutObject"],
  }),
);
