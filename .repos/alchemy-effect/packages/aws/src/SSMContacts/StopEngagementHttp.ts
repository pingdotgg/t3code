import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { StopEngagement } from "./StopEngagement.ts";

export const StopEngagementHttp = Layer.effect(
  StopEngagement,
  makeAccountHttpBinding({
    tag: "AWS.SSMContacts.StopEngagement",
    operation: ssm.stopEngagement,
    actions: ["ssm-contacts:StopEngagement"],
  }),
);
