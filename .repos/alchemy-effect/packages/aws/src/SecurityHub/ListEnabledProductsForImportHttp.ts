import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { ListEnabledProductsForImport } from "./ListEnabledProductsForImport.ts";

export const ListEnabledProductsForImportHttp = Layer.effect(
  ListEnabledProductsForImport,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.ListEnabledProductsForImport",
    operation: securityhub.listEnabledProductsForImport,
    actions: ["securityhub:ListEnabledProductsForImport"],
  }),
);
