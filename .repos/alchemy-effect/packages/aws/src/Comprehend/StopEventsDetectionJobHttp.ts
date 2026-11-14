import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { StopEventsDetectionJob } from "./StopEventsDetectionJob.ts";

export const StopEventsDetectionJobHttp = Layer.effect(
  StopEventsDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.StopEventsDetectionJob",
    operation: comprehend.stopEventsDetectionJob,
    actions: ["comprehend:StopEventsDetectionJob"],
  }),
);
