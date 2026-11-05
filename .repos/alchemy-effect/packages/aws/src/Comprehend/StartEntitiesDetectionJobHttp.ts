import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendStartJobHttpBinding } from "./BindingHttp.ts";
import { StartEntitiesDetectionJob } from "./StartEntitiesDetectionJob.ts";

export const StartEntitiesDetectionJobHttp = Layer.effect(
  StartEntitiesDetectionJob,
  makeComprehendStartJobHttpBinding({
    tag: "AWS.Comprehend.StartEntitiesDetectionJob",
    operation: comprehend.startEntitiesDetectionJob,
    actions: ["comprehend:StartEntitiesDetectionJob"],
  }),
);
