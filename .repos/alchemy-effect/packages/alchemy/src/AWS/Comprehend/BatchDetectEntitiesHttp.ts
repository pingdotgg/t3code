import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { BatchDetectEntities } from "./BatchDetectEntities.ts";

export const BatchDetectEntitiesHttp = Layer.effect(
  BatchDetectEntities,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.BatchDetectEntities",
    operation: comprehend.batchDetectEntities,
    actions: ["comprehend:BatchDetectEntities"],
  }),
);
