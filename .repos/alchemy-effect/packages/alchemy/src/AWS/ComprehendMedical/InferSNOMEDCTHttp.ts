import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { InferSNOMEDCT } from "./InferSNOMEDCT.ts";

export const InferSNOMEDCTHttp = Layer.effect(
  InferSNOMEDCT,
  makeComprehendMedicalHttpBinding({
    capability: "InferSNOMEDCT",
    iamActions: ["comprehendmedical:InferSNOMEDCT"],
    operation: comprehendmedical.inferSNOMEDCT,
  }),
);
