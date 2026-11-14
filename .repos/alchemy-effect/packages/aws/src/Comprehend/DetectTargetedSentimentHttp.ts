import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DetectTargetedSentiment } from "./DetectTargetedSentiment.ts";

export const DetectTargetedSentimentHttp = Layer.effect(
  DetectTargetedSentiment,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DetectTargetedSentiment",
    operation: comprehend.detectTargetedSentiment,
    actions: ["comprehend:DetectTargetedSentiment"],
  }),
);
