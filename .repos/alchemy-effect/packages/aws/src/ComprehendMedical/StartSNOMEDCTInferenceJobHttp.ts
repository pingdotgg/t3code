import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { StartSNOMEDCTInferenceJob } from "./StartSNOMEDCTInferenceJob.ts";

export const StartSNOMEDCTInferenceJobHttp = Layer.effect(
  StartSNOMEDCTInferenceJob,
  makeComprehendMedicalHttpBinding({
    capability: "StartSNOMEDCTInferenceJob",
    iamActions: ["comprehendmedical:StartSNOMEDCTInferenceJob"],
    operation: comprehendmedical.startSNOMEDCTInferenceJob,
    passRole: true,
  }),
);
