import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Layer from "effect/Layer";
import { makeCloudTrailAccountHttpBinding } from "./BindingHttp.ts";
import { LookupEvents } from "./LookupEvents.ts";

export const LookupEventsHttp = Layer.effect(
  LookupEvents,
  makeCloudTrailAccountHttpBinding({
    tag: "AWS.CloudTrail.LookupEvents",
    operation: cloudtrail.lookupEvents,
    actions: ["cloudtrail:LookupEvents"],
  }),
);
