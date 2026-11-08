import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { PutObjectRetention } from "./PutObjectRetention.ts";

export const PutObjectRetentionHttp = Layer.effect(
  PutObjectRetention,
  makeBucketHttpBinding({
    tag: "AWS.S3.PutObjectRetention",
    operation: S3.putObjectRetention,
    actions: ["s3:PutObjectRetention"],
  }),
);
