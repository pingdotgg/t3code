import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { BatchImportFindings } from "./BatchImportFindings.ts";

export const BatchImportFindingsHttp = Layer.effect(
  BatchImportFindings,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchImportFindings",
    operation: securityhub.batchImportFindings,
    actions: ["securityhub:BatchImportFindings"],
  }),
);
