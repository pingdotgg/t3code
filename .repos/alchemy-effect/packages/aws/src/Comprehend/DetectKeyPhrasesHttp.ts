import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DetectKeyPhrases } from "./DetectKeyPhrases.ts";

export const DetectKeyPhrasesHttp = Layer.effect(
  DetectKeyPhrases,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DetectKeyPhrases",
    operation: comprehend.detectKeyPhrases,
    actions: ["comprehend:DetectKeyPhrases"],
  }),
);
