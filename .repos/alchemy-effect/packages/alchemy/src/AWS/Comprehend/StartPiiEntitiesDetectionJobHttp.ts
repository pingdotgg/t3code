import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendStartJobHttpBinding } from "./BindingHttp.ts";
import { StartPiiEntitiesDetectionJob } from "./StartPiiEntitiesDetectionJob.ts";

export const StartPiiEntitiesDetectionJobHttp = Layer.effect(
  StartPiiEntitiesDetectionJob,
  makeComprehendStartJobHttpBinding({
    tag: "AWS.Comprehend.StartPiiEntitiesDetectionJob",
    operation: comprehend.startPiiEntitiesDetectionJob,
    actions: ["comprehend:StartPiiEntitiesDetectionJob"],
  }),
);
