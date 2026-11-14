import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { InferRxNorm } from "./InferRxNorm.ts";

export const InferRxNormHttp = Layer.effect(
  InferRxNorm,
  makeComprehendMedicalHttpBinding({
    capability: "InferRxNorm",
    iamActions: ["comprehendmedical:InferRxNorm"],
    operation: comprehendmedical.inferRxNorm,
  }),
);
