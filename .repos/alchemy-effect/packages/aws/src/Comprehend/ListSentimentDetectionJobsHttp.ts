import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ListSentimentDetectionJobs } from "./ListSentimentDetectionJobs.ts";

export const ListSentimentDetectionJobsHttp = Layer.effect(
  ListSentimentDetectionJobs,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ListSentimentDetectionJobs",
    operation: comprehend.listSentimentDetectionJobs,
    actions: ["comprehend:ListSentimentDetectionJobs"],
  }),
);
