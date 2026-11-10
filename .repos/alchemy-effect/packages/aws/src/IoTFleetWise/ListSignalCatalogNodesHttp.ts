import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import { ListSignalCatalogNodes } from "./ListSignalCatalogNodes.ts";
import type { SignalCatalog } from "./SignalCatalog.ts";

export const ListSignalCatalogNodesHttp = Layer.effect(
  ListSignalCatalogNodes,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.ListSignalCatalogNodes",
    operation: iotfleetwise.listSignalCatalogNodes,
    actions: ["iotfleetwise:ListSignalCatalogNodes"],
    requestKey: "name",
    identifier: (catalog: SignalCatalog) => catalog.signalCatalogName,
    resources: (catalog: SignalCatalog) => [catalog.signalCatalogArn],
  }),
);
