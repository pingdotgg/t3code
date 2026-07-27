import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Layer from "effect/Layer";
import { makeS3ControlAccessPointHttpBinding } from "./BindingHttp.ts";
import { GetAccessPoint } from "./GetAccessPoint.ts";

export const GetAccessPointHttp = Layer.effect(
  GetAccessPoint,
  makeS3ControlAccessPointHttpBinding({
    tag: "AWS.S3Control.GetAccessPoint",
    operation: s3control.getAccessPoint,
    actions: ["s3:GetAccessPoint"],
  }),
);
