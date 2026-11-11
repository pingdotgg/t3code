import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { StopSentimentDetectionJob } from "./StopSentimentDetectionJob.ts";

export const StopSentimentDetectionJobHttp = Layer.effect(
  StopSentimentDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.StopSentimentDetectionJob",
    operation: comprehend.stopSentimentDetectionJob,
    actions: ["comprehend:StopSentimentDetectionJob"],
  }),
);
