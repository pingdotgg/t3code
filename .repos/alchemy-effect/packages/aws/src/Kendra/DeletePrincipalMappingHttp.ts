import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { DeletePrincipalMapping } from "./DeletePrincipalMapping.ts";

export const DeletePrincipalMappingHttp = Layer.effect(
  DeletePrincipalMapping,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.DeletePrincipalMapping",
    operation: kendra.deletePrincipalMapping,
    actions: ["kendra:DeletePrincipalMapping"],
    subResources: ["data-source/*"],
  }),
);
