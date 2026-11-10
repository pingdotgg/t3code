import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { DeleteObject } from "./DeleteObject.ts";

export const DeleteObjectHttp = Layer.effect(
  DeleteObject,
  makeBucketHttpBinding({
    tag: "AWS.S3.DeleteObject",
    operation: S3.deleteObject,
    actions: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
  }),
);
