import * as osis from "@distilled.cloud/aws/osis";
import * as Layer from "effect/Layer";
import { makeOsisPipelineHttpBinding } from "./BindingHttp.ts";
import { RevokePipelineEndpointConnections } from "./RevokePipelineEndpointConnections.ts";

export const RevokePipelineEndpointConnectionsHttp = Layer.effect(
  RevokePipelineEndpointConnections,
  makeOsisPipelineHttpBinding({
    tag: "AWS.OSIS.RevokePipelineEndpointConnections",
    operation: osis.revokePipelineEndpointConnections,
    actions: ["osis:RevokePipelineEndpointConnections"],
    requestKey: "PipelineArn",
    identifier: (pipeline) => pipeline.pipelineArn,
  }),
);
