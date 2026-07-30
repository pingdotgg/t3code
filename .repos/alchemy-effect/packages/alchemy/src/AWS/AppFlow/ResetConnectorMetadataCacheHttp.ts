import * as appflow from "@distilled.cloud/aws/appflow";
import * as Layer from "effect/Layer";
import { makeAppFlowHttpBinding } from "./BindingHttp.ts";
import type { ConnectorProfile } from "./ConnectorProfile.ts";
import { ResetConnectorMetadataCache } from "./ResetConnectorMetadataCache.ts";

export const ResetConnectorMetadataCacheHttp = Layer.effect(
  ResetConnectorMetadataCache,
  makeAppFlowHttpBinding({
    action: "ResetConnectorMetadataCache",
    operation: appflow.resetConnectorMetadataCache,
    identifier: (profile: ConnectorProfile) => profile.connectorProfileName,
    requestKey: "connectorProfileName",
    resources: (profile: ConnectorProfile) => [profile.connectorProfileArn],
  }),
);
