import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { PutObjectLegalHold } from "./PutObjectLegalHold.ts";

export const PutObjectLegalHoldHttp = Layer.effect(
  PutObjectLegalHold,
  makeBucketHttpBinding({
    tag: "AWS.S3.PutObjectLegalHold",
    operation: S3.putObjectLegalHold,
    actions: ["s3:PutObjectLegalHold"],
  }),
);
