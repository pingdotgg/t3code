import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { BatchDetectKeyPhrases } from "./BatchDetectKeyPhrases.ts";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";

export const BatchDetectKeyPhrasesHttp = Layer.effect(
  BatchDetectKeyPhrases,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.BatchDetectKeyPhrases",
    operation: comprehend.batchDetectKeyPhrases,
    actions: ["comprehend:BatchDetectKeyPhrases"],
  }),
);
