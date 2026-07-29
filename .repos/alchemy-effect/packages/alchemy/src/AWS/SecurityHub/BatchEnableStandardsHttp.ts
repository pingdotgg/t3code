import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { BatchEnableStandards } from "./BatchEnableStandards.ts";

export const BatchEnableStandardsHttp = Layer.effect(
  BatchEnableStandards,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchEnableStandards",
    operation: securityhub.batchEnableStandards,
    actions: ["securityhub:BatchEnableStandards"],
  }),
);
