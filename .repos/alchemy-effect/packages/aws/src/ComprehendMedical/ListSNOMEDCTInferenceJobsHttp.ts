import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { ListSNOMEDCTInferenceJobs } from "./ListSNOMEDCTInferenceJobs.ts";

export const ListSNOMEDCTInferenceJobsHttp = Layer.effect(
  ListSNOMEDCTInferenceJobs,
  makeComprehendMedicalHttpBinding({
    capability: "ListSNOMEDCTInferenceJobs",
    iamActions: ["comprehendmedical:ListSNOMEDCTInferenceJobs"],
    operation: comprehendmedical.listSNOMEDCTInferenceJobs,
  }),
);
