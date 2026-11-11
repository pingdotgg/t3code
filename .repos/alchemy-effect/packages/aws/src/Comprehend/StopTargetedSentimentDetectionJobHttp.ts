import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { StopTargetedSentimentDetectionJob } from "./StopTargetedSentimentDetectionJob.ts";

export const StopTargetedSentimentDetectionJobHttp = Layer.effect(
  StopTargetedSentimentDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.StopTargetedSentimentDetectionJob",
    operation: comprehend.stopTargetedSentimentDetectionJob,
    actions: ["comprehend:StopTargetedSentimentDetectionJob"],
  }),
);
