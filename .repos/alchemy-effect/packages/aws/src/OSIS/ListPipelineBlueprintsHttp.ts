import * as osis from "@distilled.cloud/aws/osis";
import * as Layer from "effect/Layer";
import { makeOsisAccountHttpBinding } from "./BindingHttp.ts";
import { ListPipelineBlueprints } from "./ListPipelineBlueprints.ts";

export const ListPipelineBlueprintsHttp = Layer.effect(
  ListPipelineBlueprints,
  makeOsisAccountHttpBinding({
    tag: "AWS.OSIS.ListPipelineBlueprints",
    operation: osis.listPipelineBlueprints,
    actions: ["osis:ListPipelineBlueprints"],
  }),
);
