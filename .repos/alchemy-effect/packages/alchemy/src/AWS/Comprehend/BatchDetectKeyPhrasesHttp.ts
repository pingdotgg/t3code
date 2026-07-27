import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { BatchDetectKeyPhrases } from "./BatchDetectKeyPhrases.ts";

export const BatchDetectKeyPhrasesHttp = Layer.effect(
  BatchDetectKeyPhrases,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.BatchDetectKeyPhrases",
    operation: comprehend.batchDetectKeyPhrases,
    actions: ["comprehend:BatchDetectKeyPhrases"],
  }),
);
