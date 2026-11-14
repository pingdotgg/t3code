import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendStartJobHttpBinding } from "./BindingHttp.ts";
import { StartKeyPhrasesDetectionJob } from "./StartKeyPhrasesDetectionJob.ts";

export const StartKeyPhrasesDetectionJobHttp = Layer.effect(
  StartKeyPhrasesDetectionJob,
  makeComprehendStartJobHttpBinding({
    tag: "AWS.Comprehend.StartKeyPhrasesDetectionJob",
    operation: comprehend.startKeyPhrasesDetectionJob,
    actions: ["comprehend:StartKeyPhrasesDetectionJob"],
  }),
);
