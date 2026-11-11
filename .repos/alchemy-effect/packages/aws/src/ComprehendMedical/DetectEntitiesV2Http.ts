import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { DetectEntitiesV2 } from "./DetectEntitiesV2.ts";

export const DetectEntitiesV2Http = Layer.effect(
  DetectEntitiesV2,
  makeComprehendMedicalHttpBinding({
    capability: "DetectEntitiesV2",
    iamActions: ["comprehendmedical:DetectEntitiesV2"],
    operation: comprehendmedical.detectEntitiesV2,
  }),
);
