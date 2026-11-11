import * as osis from "@distilled.cloud/aws/osis";
import * as Layer from "effect/Layer";
import { makeOsisPipelineHttpBinding } from "./BindingHttp.ts";
import { StopPipeline } from "./StopPipeline.ts";

export const StopPipelineHttp = Layer.effect(
  StopPipeline,
  makeOsisPipelineHttpBinding({
    tag: "AWS.OSIS.StopPipeline",
    operation: osis.stopPipeline,
    actions: ["osis:StopPipeline"],
    requestKey: "PipelineName",
    identifier: (pipeline) => pipeline.pipelineName,
  }),
);
