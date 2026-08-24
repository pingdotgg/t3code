import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendStartJobHttpBinding } from "./BindingHttp.ts";
import { StartSentimentDetectionJob } from "./StartSentimentDetectionJob.ts";

export const StartSentimentDetectionJobHttp = Layer.effect(
  StartSentimentDetectionJob,
  makeComprehendStartJobHttpBinding({
    tag: "AWS.Comprehend.StartSentimentDetectionJob",
    operation: comprehend.startSentimentDetectionJob,
    actions: ["comprehend:StartSentimentDetectionJob"],
  }),
);
