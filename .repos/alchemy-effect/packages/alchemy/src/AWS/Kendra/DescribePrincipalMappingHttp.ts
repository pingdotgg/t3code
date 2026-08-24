import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { DescribePrincipalMapping } from "./DescribePrincipalMapping.ts";

export const DescribePrincipalMappingHttp = Layer.effect(
  DescribePrincipalMapping,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.DescribePrincipalMapping",
    operation: kendra.describePrincipalMapping,
    actions: ["kendra:DescribePrincipalMapping"],
    subResources: ["data-source/*"],
  }),
);
