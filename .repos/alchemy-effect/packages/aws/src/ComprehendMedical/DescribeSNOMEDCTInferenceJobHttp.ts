import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { DescribeSNOMEDCTInferenceJob } from "./DescribeSNOMEDCTInferenceJob.ts";

export const DescribeSNOMEDCTInferenceJobHttp = Layer.effect(
  DescribeSNOMEDCTInferenceJob,
  makeComprehendMedicalHttpBinding({
    capability: "DescribeSNOMEDCTInferenceJob",
    iamActions: ["comprehendmedical:DescribeSNOMEDCTInferenceJob"],
    operation: comprehendmedical.describeSNOMEDCTInferenceJob,
  }),
);
