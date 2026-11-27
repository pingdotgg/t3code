import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { GetObjectRetention } from "./GetObjectRetention.ts";

export const GetObjectRetentionHttp = Layer.effect(
  GetObjectRetention,
  makeBucketHttpBinding({
    tag: "AWS.S3.GetObjectRetention",
    operation: S3.getObjectRetention,
    actions: ["s3:GetObjectRetention"],
  }),
);
