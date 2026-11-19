import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { DetectPHI } from "./DetectPHI.ts";

export const DetectPHIHttp = Layer.effect(
  DetectPHI,
  makeComprehendMedicalHttpBinding({
    capability: "DetectPHI",
    iamActions: ["comprehendmedical:DetectPHI"],
    operation: comprehendmedical.detectPHI,
  }),
);
