import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Layer from "effect/Layer";
import { makeS3ControlMrapHttpBinding } from "./BindingHttp.ts";
import { GetMultiRegionAccessPointRoutes } from "./GetMultiRegionAccessPointRoutes.ts";

export const GetMultiRegionAccessPointRoutesHttp = Layer.effect(
  GetMultiRegionAccessPointRoutes,
  makeS3ControlMrapHttpBinding({
    tag: "AWS.S3Control.GetMultiRegionAccessPointRoutes",
    operation: s3control.getMultiRegionAccessPointRoutes,
    actions: ["s3:GetMultiRegionAccessPointRoutes"],
  }),
);
