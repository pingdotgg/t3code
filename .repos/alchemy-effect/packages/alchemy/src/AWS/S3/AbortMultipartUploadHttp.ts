import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { AbortMultipartUpload } from "./AbortMultipartUpload.ts";

export const AbortMultipartUploadHttp = Layer.effect(
  AbortMultipartUpload,
  makeBucketHttpBinding({
    tag: "AWS.S3.AbortMultipartUpload",
    operation: S3.abortMultipartUpload,
    actions: ["s3:AbortMultipartUpload"],
  }),
);
