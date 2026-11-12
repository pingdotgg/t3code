import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { GetObjectAttributes } from "./GetObjectAttributes.ts";

export const GetObjectAttributesHttp = Layer.effect(
  GetObjectAttributes,
  makeBucketHttpBinding({
    tag: "AWS.S3.GetObjectAttributes",
    operation: S3.getObjectAttributes,
    actions: [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectAttributes",
      "s3:GetObjectVersionAttributes",
    ],
    listBucket: true,
  }),
);
