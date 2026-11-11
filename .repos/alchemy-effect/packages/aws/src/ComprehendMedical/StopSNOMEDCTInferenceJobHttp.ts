import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { StopSNOMEDCTInferenceJob } from "./StopSNOMEDCTInferenceJob.ts";

export const StopSNOMEDCTInferenceJobHttp = Layer.effect(
  StopSNOMEDCTInferenceJob,
  makeComprehendMedicalHttpBinding({
    capability: "StopSNOMEDCTInferenceJob",
    iamActions: ["comprehendmedical:StopSNOMEDCTInferenceJob"],
    operation: comprehendmedical.stopSNOMEDCTInferenceJob,
  }),
);
