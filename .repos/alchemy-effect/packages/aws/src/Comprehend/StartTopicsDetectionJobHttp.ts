import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendStartJobHttpBinding } from "./BindingHttp.ts";
import { StartTopicsDetectionJob } from "./StartTopicsDetectionJob.ts";

export const StartTopicsDetectionJobHttp = Layer.effect(
  StartTopicsDetectionJob,
  makeComprehendStartJobHttpBinding({
    tag: "AWS.Comprehend.StartTopicsDetectionJob",
    operation: comprehend.startTopicsDetectionJob,
    actions: ["comprehend:StartTopicsDetectionJob"],
  }),
);
