import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DescribeKeyPhrasesDetectionJob } from "./DescribeKeyPhrasesDetectionJob.ts";

export const DescribeKeyPhrasesDetectionJobHttp = Layer.effect(
  DescribeKeyPhrasesDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DescribeKeyPhrasesDetectionJob",
    operation: comprehend.describeKeyPhrasesDetectionJob,
    actions: ["comprehend:DescribeKeyPhrasesDetectionJob"],
  }),
);
