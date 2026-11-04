import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeEngagement } from "./DescribeEngagement.ts";

export const DescribeEngagementHttp = Layer.effect(
  DescribeEngagement,
  makeAccountHttpBinding({
    tag: "AWS.SSMContacts.DescribeEngagement",
    operation: ssm.describeEngagement,
    actions: ["ssm-contacts:DescribeEngagement"],
  }),
);
