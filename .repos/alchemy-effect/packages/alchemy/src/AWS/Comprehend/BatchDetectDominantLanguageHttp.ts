import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { BatchDetectDominantLanguage } from "./BatchDetectDominantLanguage.ts";

export const BatchDetectDominantLanguageHttp = Layer.effect(
  BatchDetectDominantLanguage,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.BatchDetectDominantLanguage",
    operation: comprehend.batchDetectDominantLanguage,
    actions: ["comprehend:BatchDetectDominantLanguage"],
  }),
);
