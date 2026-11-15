import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import { ListModelManifestNodes } from "./ListModelManifestNodes.ts";
import type { ModelManifest } from "./ModelManifest.ts";

export const ListModelManifestNodesHttp = Layer.effect(
  ListModelManifestNodes,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.ListModelManifestNodes",
    operation: iotfleetwise.listModelManifestNodes,
    actions: ["iotfleetwise:ListModelManifestNodes"],
    requestKey: "name",
    identifier: (model: ModelManifest) => model.modelManifestName,
    resources: (model: ModelManifest) => [model.modelManifestArn],
  }),
);
