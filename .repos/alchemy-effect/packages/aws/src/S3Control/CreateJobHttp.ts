import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Layer from "effect/Layer";
import { makeS3ControlAccountHttpBinding } from "./BindingHttp.ts";
import { CreateJob } from "./CreateJob.ts";

export const CreateJobHttp = Layer.effect(
  CreateJob,
  makeS3ControlAccountHttpBinding({
    tag: "AWS.S3Control.CreateJob",
    operation: s3control.createJob,
    actions: ["s3:CreateJob"],
    passRole: true,
  }),
);
