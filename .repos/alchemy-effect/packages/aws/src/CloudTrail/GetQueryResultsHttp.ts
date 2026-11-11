import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Layer from "effect/Layer";
import { makeCloudTrailEventDataStoreHttpBinding } from "./BindingHttp.ts";
import { GetQueryResults } from "./GetQueryResults.ts";

export const GetQueryResultsHttp = Layer.effect(
  GetQueryResults,
  makeCloudTrailEventDataStoreHttpBinding({
    tag: "AWS.CloudTrail.GetQueryResults",
    operation: cloudtrail.getQueryResults,
    actions: ["cloudtrail:GetQueryResults"],
  }),
);
