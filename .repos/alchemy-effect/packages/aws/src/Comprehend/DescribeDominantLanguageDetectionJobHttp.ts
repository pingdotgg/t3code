import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DescribeDominantLanguageDetectionJob } from "./DescribeDominantLanguageDetectionJob.ts";

export const DescribeDominantLanguageDetectionJobHttp = Layer.effect(
  DescribeDominantLanguageDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DescribeDominantLanguageDetectionJob",
    operation: comprehend.describeDominantLanguageDetectionJob,
    actions: ["comprehend:DescribeDominantLanguageDetectionJob"],
  }),
);
