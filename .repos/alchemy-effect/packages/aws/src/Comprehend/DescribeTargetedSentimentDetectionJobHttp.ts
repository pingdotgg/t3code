import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DescribeTargetedSentimentDetectionJob } from "./DescribeTargetedSentimentDetectionJob.ts";

export const DescribeTargetedSentimentDetectionJobHttp = Layer.effect(
  DescribeTargetedSentimentDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DescribeTargetedSentimentDetectionJob",
    operation: comprehend.describeTargetedSentimentDetectionJob,
    actions: ["comprehend:DescribeTargetedSentimentDetectionJob"],
  }),
);
