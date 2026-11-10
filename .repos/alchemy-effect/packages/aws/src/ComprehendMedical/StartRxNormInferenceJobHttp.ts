import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { StartRxNormInferenceJob } from "./StartRxNormInferenceJob.ts";

export const StartRxNormInferenceJobHttp = Layer.effect(
  StartRxNormInferenceJob,
  makeComprehendMedicalHttpBinding({
    capability: "StartRxNormInferenceJob",
    iamActions: ["comprehendmedical:StartRxNormInferenceJob"],
    operation: comprehendmedical.startRxNormInferenceJob,
    passRole: true,
  }),
);
