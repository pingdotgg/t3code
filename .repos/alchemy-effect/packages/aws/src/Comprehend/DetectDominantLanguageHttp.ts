import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DetectDominantLanguage } from "./DetectDominantLanguage.ts";

export const DetectDominantLanguageHttp = Layer.effect(
  DetectDominantLanguage,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DetectDominantLanguage",
    operation: comprehend.detectDominantLanguage,
    actions: ["comprehend:DetectDominantLanguage"],
  }),
);
