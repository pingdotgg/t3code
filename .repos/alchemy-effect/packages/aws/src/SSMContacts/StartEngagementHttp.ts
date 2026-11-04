import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeContactHttpBinding } from "./BindingHttp.ts";
import { StartEngagement } from "./StartEngagement.ts";

export const StartEngagementHttp = Layer.effect(
  StartEngagement,
  makeContactHttpBinding({
    tag: "AWS.SSMContacts.StartEngagement",
    operation: ssm.startEngagement,
    actions: ["ssm-contacts:StartEngagement"],
  }),
);
