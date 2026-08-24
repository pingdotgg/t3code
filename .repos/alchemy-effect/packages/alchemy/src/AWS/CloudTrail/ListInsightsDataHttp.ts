import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Layer from "effect/Layer";
import { makeCloudTrailAccountHttpBinding } from "./BindingHttp.ts";
import { ListInsightsData } from "./ListInsightsData.ts";

export const ListInsightsDataHttp = Layer.effect(
  ListInsightsData,
  makeCloudTrailAccountHttpBinding({
    tag: "AWS.CloudTrail.ListInsightsData",
    operation: cloudtrail.listInsightsData,
    actions: ["cloudtrail:ListInsightsData"],
  }),
);
