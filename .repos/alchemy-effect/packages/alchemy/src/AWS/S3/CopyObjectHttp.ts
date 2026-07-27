import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { CopyObject } from "./CopyObject.ts";

export const CopyObjectHttp = Layer.effect(
  CopyObject,
  makeBucketHttpBinding({
    tag: "AWS.S3.CopyObject",
    operation: S3.copyObject,
    actions: ["s3:PutObject", "s3:GetObject"],
  }),
);
