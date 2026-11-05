import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Layer from "effect/Layer";
import { makeS3ControlMrapHttpBinding } from "./BindingHttp.ts";
import { SubmitMultiRegionAccessPointRoutes } from "./SubmitMultiRegionAccessPointRoutes.ts";

export const SubmitMultiRegionAccessPointRoutesHttp = Layer.effect(
  SubmitMultiRegionAccessPointRoutes,
  makeS3ControlMrapHttpBinding({
    tag: "AWS.S3Control.SubmitMultiRegionAccessPointRoutes",
    operation: s3control.submitMultiRegionAccessPointRoutes,
    actions: ["s3:SubmitMultiRegionAccessPointRoutes"],
  }),
);
