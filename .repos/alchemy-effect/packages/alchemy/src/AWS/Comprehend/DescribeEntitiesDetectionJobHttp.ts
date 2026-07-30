import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DescribeEntitiesDetectionJob } from "./DescribeEntitiesDetectionJob.ts";

export const DescribeEntitiesDetectionJobHttp = Layer.effect(
  DescribeEntitiesDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DescribeEntitiesDetectionJob",
    operation: comprehend.describeEntitiesDetectionJob,
    actions: ["comprehend:DescribeEntitiesDetectionJob"],
  }),
);
