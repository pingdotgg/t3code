import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { PutPrincipalMapping } from "./PutPrincipalMapping.ts";

export const PutPrincipalMappingHttp = Layer.effect(
  PutPrincipalMapping,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.PutPrincipalMapping",
    operation: kendra.putPrincipalMapping,
    actions: ["kendra:PutPrincipalMapping"],
    subResources: ["data-source/*"],
  }),
);
