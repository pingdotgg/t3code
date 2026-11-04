import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { RestoreObject } from "./RestoreObject.ts";

export const RestoreObjectHttp = Layer.effect(
  RestoreObject,
  makeBucketHttpBinding({
    tag: "AWS.S3.RestoreObject",
    operation: S3.restoreObject,
    actions: ["s3:RestoreObject"],
  }),
);
