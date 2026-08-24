import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { StopDominantLanguageDetectionJob } from "./StopDominantLanguageDetectionJob.ts";

export const StopDominantLanguageDetectionJobHttp = Layer.effect(
  StopDominantLanguageDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.StopDominantLanguageDetectionJob",
    operation: comprehend.stopDominantLanguageDetectionJob,
    actions: ["comprehend:StopDominantLanguageDetectionJob"],
  }),
);
