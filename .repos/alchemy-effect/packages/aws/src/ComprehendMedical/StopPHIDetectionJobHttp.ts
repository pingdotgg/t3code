import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { StopPHIDetectionJob } from "./StopPHIDetectionJob.ts";

export const StopPHIDetectionJobHttp = Layer.effect(
  StopPHIDetectionJob,
  makeComprehendMedicalHttpBinding({
    capability: "StopPHIDetectionJob",
    iamActions: ["comprehendmedical:StopPHIDetectionJob"],
    operation: comprehendmedical.stopPHIDetectionJob,
  }),
);
