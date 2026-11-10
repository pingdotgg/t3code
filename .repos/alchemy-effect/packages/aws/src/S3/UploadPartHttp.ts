import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { UploadPart } from "./UploadPart.ts";

export const UploadPartHttp = Layer.effect(
  UploadPart,
  makeBucketHttpBinding({
    tag: "AWS.S3.UploadPart",
    operation: S3.uploadPart,
    actions: ["s3:PutObject"],
  }),
);
