import * as osis from "@distilled.cloud/aws/osis";
import * as Layer from "effect/Layer";
import { makeOsisAccountHttpBinding } from "./BindingHttp.ts";
import { ListPipelineEndpointConnections } from "./ListPipelineEndpointConnections.ts";

export const ListPipelineEndpointConnectionsHttp = Layer.effect(
  ListPipelineEndpointConnections,
  makeOsisAccountHttpBinding({
    tag: "AWS.OSIS.ListPipelineEndpointConnections",
    operation: osis.listPipelineEndpointConnections,
    actions: ["osis:ListPipelineEndpointConnections"],
  }),
);
