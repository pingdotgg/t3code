import * as appflow from "@distilled.cloud/aws/appflow";
import * as Layer from "effect/Layer";
import { makeAppFlowHttpBinding } from "./BindingHttp.ts";
import type { ConnectorProfile } from "./ConnectorProfile.ts";
import { ListConnectorEntities } from "./ListConnectorEntities.ts";

export const ListConnectorEntitiesHttp = Layer.effect(
  ListConnectorEntities,
  makeAppFlowHttpBinding({
    action: "ListConnectorEntities",
    operation: appflow.listConnectorEntities,
    identifier: (profile: ConnectorProfile) => profile.connectorProfileName,
    requestKey: "connectorProfileName",
    resources: (profile: ConnectorProfile) => [profile.connectorProfileArn],
  }),
);
