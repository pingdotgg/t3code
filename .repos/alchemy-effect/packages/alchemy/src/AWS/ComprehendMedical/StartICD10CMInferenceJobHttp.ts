import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { StartICD10CMInferenceJob } from "./StartICD10CMInferenceJob.ts";

export const StartICD10CMInferenceJobHttp = Layer.effect(
  StartICD10CMInferenceJob,
  makeComprehendMedicalHttpBinding({
    capability: "StartICD10CMInferenceJob",
    iamActions: ["comprehendmedical:StartICD10CMInferenceJob"],
    operation: comprehendmedical.startICD10CMInferenceJob,
    passRole: true,
  }),
);
