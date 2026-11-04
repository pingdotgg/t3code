import * as osis from "@distilled.cloud/aws/osis";
import * as Layer from "effect/Layer";
import { makeOsisPipelineHttpBinding } from "./BindingHttp.ts";
import { StartPipeline } from "./StartPipeline.ts";

export const StartPipelineHttp = Layer.effect(
  StartPipeline,
  makeOsisPipelineHttpBinding({
    tag: "AWS.OSIS.StartPipeline",
    operation: osis.startPipeline,
    actions: ["osis:StartPipeline"],
    requestKey: "PipelineName",
    identifier: (pipeline) => pipeline.pipelineName,
  }),
);
