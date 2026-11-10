import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { CreateMultipartUpload } from "./CreateMultipartUpload.ts";

export const CreateMultipartUploadHttp = Layer.effect(
  CreateMultipartUpload,
  makeBucketHttpBinding({
    tag: "AWS.S3.CreateMultipartUpload",
    operation: S3.createMultipartUpload,
    actions: ["s3:PutObject"],
  }),
);
