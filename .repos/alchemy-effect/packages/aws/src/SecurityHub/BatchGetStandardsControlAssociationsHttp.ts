import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { BatchGetStandardsControlAssociations } from "./BatchGetStandardsControlAssociations.ts";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";

export const BatchGetStandardsControlAssociationsHttp = Layer.effect(
  BatchGetStandardsControlAssociations,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchGetStandardsControlAssociations",
    operation: securityhub.batchGetStandardsControlAssociations,
    actions: ["securityhub:BatchGetStandardsControlAssociations"],
  }),
);
