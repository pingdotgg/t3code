import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { BatchDetectTargetedSentiment } from "./BatchDetectTargetedSentiment.ts";

export const BatchDetectTargetedSentimentHttp = Layer.effect(
  BatchDetectTargetedSentiment,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.BatchDetectTargetedSentiment",
    operation: comprehend.batchDetectTargetedSentiment,
    actions: ["comprehend:BatchDetectTargetedSentiment"],
  }),
);
