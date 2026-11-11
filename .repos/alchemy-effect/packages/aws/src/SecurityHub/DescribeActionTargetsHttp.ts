import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { DescribeActionTargets } from "./DescribeActionTargets.ts";

export const DescribeActionTargetsHttp = Layer.effect(
  DescribeActionTargets,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.DescribeActionTargets",
    operation: securityhub.describeActionTargets,
    actions: ["securityhub:DescribeActionTargets"],
  }),
);
