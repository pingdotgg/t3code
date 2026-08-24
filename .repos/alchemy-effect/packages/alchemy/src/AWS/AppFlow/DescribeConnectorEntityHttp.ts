import * as appflow from "@distilled.cloud/aws/appflow";
import * as Layer from "effect/Layer";
import { makeAppFlowHttpBinding } from "./BindingHttp.ts";
import type { ConnectorProfile } from "./ConnectorProfile.ts";
import { DescribeConnectorEntity } from "./DescribeConnectorEntity.ts";

export const DescribeConnectorEntityHttp = Layer.effect(
  DescribeConnectorEntity,
  makeAppFlowHttpBinding({
    action: "DescribeConnectorEntity",
    operation: appflow.describeConnectorEntity,
    identifier: (profile: ConnectorProfile) => profile.connectorProfileName,
    requestKey: "connectorProfileName",
    resources: (profile: ConnectorProfile) => [profile.connectorProfileArn],
  }),
);
