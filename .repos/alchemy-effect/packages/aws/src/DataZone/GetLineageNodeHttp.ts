import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { GetLineageNode } from "./GetLineageNode.ts";

export const GetLineageNodeHttp = Layer.effect(
  GetLineageNode,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetLineageNode",
    operation: datazone.getLineageNode,
    actions: ["datazone:GetLineageNode"],
  }),
);
