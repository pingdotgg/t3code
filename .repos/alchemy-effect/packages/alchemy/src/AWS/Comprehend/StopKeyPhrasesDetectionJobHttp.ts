import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { StopKeyPhrasesDetectionJob } from "./StopKeyPhrasesDetectionJob.ts";

export const StopKeyPhrasesDetectionJobHttp = Layer.effect(
  StopKeyPhrasesDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.StopKeyPhrasesDetectionJob",
    operation: comprehend.stopKeyPhrasesDetectionJob,
    actions: ["comprehend:StopKeyPhrasesDetectionJob"],
  }),
);
