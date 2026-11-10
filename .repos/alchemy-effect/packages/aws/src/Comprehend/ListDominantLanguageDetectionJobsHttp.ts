import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ListDominantLanguageDetectionJobs } from "./ListDominantLanguageDetectionJobs.ts";

export const ListDominantLanguageDetectionJobsHttp = Layer.effect(
  ListDominantLanguageDetectionJobs,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ListDominantLanguageDetectionJobs",
    operation: comprehend.listDominantLanguageDetectionJobs,
    actions: ["comprehend:ListDominantLanguageDetectionJobs"],
  }),
);
