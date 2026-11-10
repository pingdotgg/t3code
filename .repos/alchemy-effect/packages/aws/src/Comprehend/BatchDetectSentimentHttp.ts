import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { BatchDetectSentiment } from "./BatchDetectSentiment.ts";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";

export const BatchDetectSentimentHttp = Layer.effect(
  BatchDetectSentiment,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.BatchDetectSentiment",
    operation: comprehend.batchDetectSentiment,
    actions: ["comprehend:BatchDetectSentiment"],
  }),
);
