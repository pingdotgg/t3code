import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DetectEntities } from "./DetectEntities.ts";

export const DetectEntitiesHttp = Layer.effect(
  DetectEntities,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DetectEntities",
    operation: comprehend.detectEntities,
    actions: ["comprehend:DetectEntities"],
  }),
);
