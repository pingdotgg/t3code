import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { StopEntitiesDetectionJob } from "./StopEntitiesDetectionJob.ts";

export const StopEntitiesDetectionJobHttp = Layer.effect(
  StopEntitiesDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.StopEntitiesDetectionJob",
    operation: comprehend.stopEntitiesDetectionJob,
    actions: ["comprehend:StopEntitiesDetectionJob"],
  }),
);
