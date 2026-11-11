import * as osis from "@distilled.cloud/aws/osis";
import * as Layer from "effect/Layer";
import { makeOsisAccountHttpBinding } from "./BindingHttp.ts";
import { ValidatePipeline } from "./ValidatePipeline.ts";

export const ValidatePipelineHttp = Layer.effect(
  ValidatePipeline,
  makeOsisAccountHttpBinding({
    tag: "AWS.OSIS.ValidatePipeline",
    operation: osis.validatePipeline,
    actions: ["osis:ValidatePipeline"],
  }),
);
