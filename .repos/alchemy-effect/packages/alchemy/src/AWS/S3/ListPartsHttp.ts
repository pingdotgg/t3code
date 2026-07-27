import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { ListParts } from "./ListParts.ts";

export const ListPartsHttp = Layer.effect(
  ListParts,
  makeBucketHttpBinding({
    tag: "AWS.S3.ListParts",
    operation: S3.listParts,
    actions: ["s3:ListMultipartUploadParts"],
  }),
);
