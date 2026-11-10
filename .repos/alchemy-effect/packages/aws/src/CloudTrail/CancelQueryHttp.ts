import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Layer from "effect/Layer";
import { makeCloudTrailEventDataStoreHttpBinding } from "./BindingHttp.ts";
import { CancelQuery } from "./CancelQuery.ts";

export const CancelQueryHttp = Layer.effect(
  CancelQuery,
  makeCloudTrailEventDataStoreHttpBinding({
    tag: "AWS.CloudTrail.CancelQuery",
    operation: cloudtrail.cancelQuery,
    actions: ["cloudtrail:CancelQuery"],
  }),
);
