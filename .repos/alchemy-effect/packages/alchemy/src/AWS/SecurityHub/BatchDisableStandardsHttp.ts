import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { BatchDisableStandards } from "./BatchDisableStandards.ts";

export const BatchDisableStandardsHttp = Layer.effect(
  BatchDisableStandards,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchDisableStandards",
    operation: securityhub.batchDisableStandards,
    actions: ["securityhub:BatchDisableStandards"],
  }),
);
