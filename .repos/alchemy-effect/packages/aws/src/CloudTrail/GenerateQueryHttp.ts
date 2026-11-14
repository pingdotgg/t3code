import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Layer from "effect/Layer";
import { makeCloudTrailEventDataStoreHttpBinding } from "./BindingHttp.ts";
import { GenerateQuery } from "./GenerateQuery.ts";

export const GenerateQueryHttp = Layer.effect(
  GenerateQuery,
  makeCloudTrailEventDataStoreHttpBinding({
    tag: "AWS.CloudTrail.GenerateQuery",
    operation: cloudtrail.generateQuery,
    actions: ["cloudtrail:GenerateQuery"],
    injectEventDataStores: true,
  }),
);
