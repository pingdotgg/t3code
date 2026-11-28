import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Layer from "effect/Layer";
import { makeS3ControlAccessPointHttpBinding } from "./BindingHttp.ts";
import { GetAccessPointPolicy } from "./GetAccessPointPolicy.ts";

export const GetAccessPointPolicyHttp = Layer.effect(
  GetAccessPointPolicy,
  makeS3ControlAccessPointHttpBinding({
    tag: "AWS.S3Control.GetAccessPointPolicy",
    operation: s3control.getAccessPointPolicy,
    actions: ["s3:GetAccessPointPolicy"],
  }),
);
