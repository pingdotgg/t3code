import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Layer from "effect/Layer";
import { makeB2biAccountHttpBinding } from "./BindingHttp.ts";
import { GenerateMapping } from "./GenerateMapping.ts";

export const GenerateMappingHttp = Layer.effect(
  GenerateMapping,
  makeB2biAccountHttpBinding({
    tag: "AWS.B2BI.GenerateMapping",
    operation: b2bi.generateMapping,
    // GenerateMapping invokes Amazon Bedrock through the caller's session
    // (verified live: "Access denied when invoking Bedrock's InvokeModel
    // API" without the grant). The account must also have Bedrock model
    // access enabled for the mapping model in the region.
    actions: ["b2bi:GenerateMapping", "bedrock:InvokeModel"],
  }),
);
