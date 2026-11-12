import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { GetObjectLegalHold } from "./GetObjectLegalHold.ts";

export const GetObjectLegalHoldHttp = Layer.effect(
  GetObjectLegalHold,
  makeBucketHttpBinding({
    tag: "AWS.S3.GetObjectLegalHold",
    operation: S3.getObjectLegalHold,
    actions: ["s3:GetObjectLegalHold"],
  }),
);
