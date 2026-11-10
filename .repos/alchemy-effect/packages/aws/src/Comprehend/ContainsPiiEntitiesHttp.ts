import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ContainsPiiEntities } from "./ContainsPiiEntities.ts";

export const ContainsPiiEntitiesHttp = Layer.effect(
  ContainsPiiEntities,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ContainsPiiEntities",
    operation: comprehend.containsPiiEntities,
    actions: ["comprehend:ContainsPiiEntities"],
  }),
);
