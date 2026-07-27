import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { HeadObject } from "./HeadObject.ts";

export const HeadObjectHttp = Layer.effect(
  HeadObject,
  makeBucketHttpBinding({
    tag: "AWS.S3.HeadObject",
    operation: S3.headObject,
    actions: ["s3:GetObject"],
  }),
);
