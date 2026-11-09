import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { BatchUpdateFindings } from "./BatchUpdateFindings.ts";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";

export const BatchUpdateFindingsHttp = Layer.effect(
  BatchUpdateFindings,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchUpdateFindings",
    operation: securityhub.batchUpdateFindings,
    actions: ["securityhub:BatchUpdateFindings"],
  }),
);
