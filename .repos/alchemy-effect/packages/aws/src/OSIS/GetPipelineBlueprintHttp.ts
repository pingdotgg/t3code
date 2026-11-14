import * as osis from "@distilled.cloud/aws/osis";
import * as Layer from "effect/Layer";
import { makeOsisAccountHttpBinding } from "./BindingHttp.ts";
import { GetPipelineBlueprint } from "./GetPipelineBlueprint.ts";

export const GetPipelineBlueprintHttp = Layer.effect(
  GetPipelineBlueprint,
  makeOsisAccountHttpBinding({
    tag: "AWS.OSIS.GetPipelineBlueprint",
    operation: osis.getPipelineBlueprint,
    actions: ["osis:GetPipelineBlueprint"],
  }),
);
