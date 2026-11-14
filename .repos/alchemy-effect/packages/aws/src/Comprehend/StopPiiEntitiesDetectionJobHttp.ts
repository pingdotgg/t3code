import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { StopPiiEntitiesDetectionJob } from "./StopPiiEntitiesDetectionJob.ts";

export const StopPiiEntitiesDetectionJobHttp = Layer.effect(
  StopPiiEntitiesDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.StopPiiEntitiesDetectionJob",
    operation: comprehend.stopPiiEntitiesDetectionJob,
    actions: ["comprehend:StopPiiEntitiesDetectionJob"],
  }),
);
