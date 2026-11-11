import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { DescribePHIDetectionJob } from "./DescribePHIDetectionJob.ts";

export const DescribePHIDetectionJobHttp = Layer.effect(
  DescribePHIDetectionJob,
  makeComprehendMedicalHttpBinding({
    capability: "DescribePHIDetectionJob",
    iamActions: ["comprehendmedical:DescribePHIDetectionJob"],
    operation: comprehendmedical.describePHIDetectionJob,
  }),
);
