import * as osis from "@distilled.cloud/aws/osis";
import * as Layer from "effect/Layer";
import { makeOsisPipelineHttpBinding } from "./BindingHttp.ts";
import { GetPipelineChangeProgress } from "./GetPipelineChangeProgress.ts";

export const GetPipelineChangeProgressHttp = Layer.effect(
  GetPipelineChangeProgress,
  makeOsisPipelineHttpBinding({
    tag: "AWS.OSIS.GetPipelineChangeProgress",
    operation: osis.getPipelineChangeProgress,
    actions: ["osis:GetPipelineChangeProgress"],
    requestKey: "PipelineName",
    identifier: (pipeline) => pipeline.pipelineName,
  }),
);
