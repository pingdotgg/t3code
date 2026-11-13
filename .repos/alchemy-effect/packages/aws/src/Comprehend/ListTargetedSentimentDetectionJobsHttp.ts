import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ListTargetedSentimentDetectionJobs } from "./ListTargetedSentimentDetectionJobs.ts";

export const ListTargetedSentimentDetectionJobsHttp = Layer.effect(
  ListTargetedSentimentDetectionJobs,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ListTargetedSentimentDetectionJobs",
    operation: comprehend.listTargetedSentimentDetectionJobs,
    actions: ["comprehend:ListTargetedSentimentDetectionJobs"],
  }),
);
