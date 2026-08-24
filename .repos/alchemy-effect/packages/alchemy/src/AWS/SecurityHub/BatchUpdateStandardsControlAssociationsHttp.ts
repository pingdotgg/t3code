import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { BatchUpdateStandardsControlAssociations } from "./BatchUpdateStandardsControlAssociations.ts";

export const BatchUpdateStandardsControlAssociationsHttp = Layer.effect(
  BatchUpdateStandardsControlAssociations,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchUpdateStandardsControlAssociations",
    operation: securityhub.batchUpdateStandardsControlAssociations,
    actions: ["securityhub:BatchUpdateStandardsControlAssociations"],
  }),
);
