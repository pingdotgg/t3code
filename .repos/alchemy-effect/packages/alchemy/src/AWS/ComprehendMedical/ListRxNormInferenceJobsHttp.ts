import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { ListRxNormInferenceJobs } from "./ListRxNormInferenceJobs.ts";

export const ListRxNormInferenceJobsHttp = Layer.effect(
  ListRxNormInferenceJobs,
  makeComprehendMedicalHttpBinding({
    capability: "ListRxNormInferenceJobs",
    iamActions: ["comprehendmedical:ListRxNormInferenceJobs"],
    operation: comprehendmedical.listRxNormInferenceJobs,
  }),
);
