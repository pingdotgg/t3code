import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ListKeyPhrasesDetectionJobs } from "./ListKeyPhrasesDetectionJobs.ts";

export const ListKeyPhrasesDetectionJobsHttp = Layer.effect(
  ListKeyPhrasesDetectionJobs,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ListKeyPhrasesDetectionJobs",
    operation: comprehend.listKeyPhrasesDetectionJobs,
    actions: ["comprehend:ListKeyPhrasesDetectionJobs"],
  }),
);
