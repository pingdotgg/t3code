import * as osis from "@distilled.cloud/aws/osis";
import * as Layer from "effect/Layer";
import { makeOsisPipelineHttpBinding } from "./BindingHttp.ts";
import { GetPipeline } from "./GetPipeline.ts";

export const GetPipelineHttp = Layer.effect(
  GetPipeline,
  makeOsisPipelineHttpBinding({
    tag: "AWS.OSIS.GetPipeline",
    operation: osis.getPipeline,
    actions: ["osis:GetPipeline"],
    requestKey: "PipelineName",
    identifier: (pipeline) => pipeline.pipelineName,
  }),
);
