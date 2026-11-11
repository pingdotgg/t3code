import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DescribeEventsDetectionJob } from "./DescribeEventsDetectionJob.ts";

export const DescribeEventsDetectionJobHttp = Layer.effect(
  DescribeEventsDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DescribeEventsDetectionJob",
    operation: comprehend.describeEventsDetectionJob,
    actions: ["comprehend:DescribeEventsDetectionJob"],
  }),
);
