import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Layer from "effect/Layer";
import { makeS3ControlAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateJobStatus } from "./UpdateJobStatus.ts";

export const UpdateJobStatusHttp = Layer.effect(
  UpdateJobStatus,
  makeS3ControlAccountHttpBinding({
    tag: "AWS.S3Control.UpdateJobStatus",
    operation: s3control.updateJobStatus,
    actions: ["s3:UpdateJobStatus"],
  }),
);
