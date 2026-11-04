import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { GetObject } from "./GetObject.ts";

export const GetObjectHttp = Layer.effect(
  GetObject,
  makeBucketHttpBinding({
    tag: "AWS.S3.GetObject",
    operation: S3.getObject,
    actions: ["s3:GetObject", "s3:GetObjectVersion"],
    listBucket: true,
  }),
);
