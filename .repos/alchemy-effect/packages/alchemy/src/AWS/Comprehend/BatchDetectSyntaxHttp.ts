import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { BatchDetectSyntax } from "./BatchDetectSyntax.ts";

export const BatchDetectSyntaxHttp = Layer.effect(
  BatchDetectSyntax,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.BatchDetectSyntax",
    operation: comprehend.batchDetectSyntax,
    actions: ["comprehend:BatchDetectSyntax"],
  }),
);
