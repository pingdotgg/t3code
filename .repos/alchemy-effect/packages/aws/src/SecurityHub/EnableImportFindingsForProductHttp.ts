import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { EnableImportFindingsForProduct } from "./EnableImportFindingsForProduct.ts";

export const EnableImportFindingsForProductHttp = Layer.effect(
  EnableImportFindingsForProduct,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.EnableImportFindingsForProduct",
    operation: securityhub.enableImportFindingsForProduct,
    actions: ["securityhub:EnableImportFindingsForProduct"],
  }),
);
