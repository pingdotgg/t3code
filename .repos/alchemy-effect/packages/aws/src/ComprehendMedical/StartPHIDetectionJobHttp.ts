import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { StartPHIDetectionJob } from "./StartPHIDetectionJob.ts";

export const StartPHIDetectionJobHttp = Layer.effect(
  StartPHIDetectionJob,
  makeComprehendMedicalHttpBinding({
    capability: "StartPHIDetectionJob",
    iamActions: ["comprehendmedical:StartPHIDetectionJob"],
    operation: comprehendmedical.startPHIDetectionJob,
    passRole: true,
  }),
);
