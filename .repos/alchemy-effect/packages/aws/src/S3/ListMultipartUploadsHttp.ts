import * as S3 from "@distilled.cloud/aws/s3";
import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { ListMultipartUploads } from "./ListMultipartUploads.ts";

export const ListMultipartUploadsHttp = Layer.effect(
  ListMultipartUploads,
  makeBucketHttpBinding({
    tag: "AWS.S3.ListMultipartUploads",
    operation: S3.listMultipartUploads,
    actions: ["s3:ListBucketMultipartUploads"],
    iamResources: "bucket",
  }),
);
