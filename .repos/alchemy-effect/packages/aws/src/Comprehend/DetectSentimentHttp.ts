import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DetectSentiment } from "./DetectSentiment.ts";

export const DetectSentimentHttp = Layer.effect(
  DetectSentiment,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DetectSentiment",
    operation: comprehend.detectSentiment,
    actions: ["comprehend:DetectSentiment"],
  }),
);
