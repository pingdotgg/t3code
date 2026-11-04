import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedIntegrationsHttpBinding } from "./BindingHttp.ts";
import { SendConnectorEvent } from "./SendConnectorEvent.ts";

export const SendConnectorEventHttp = Layer.effect(
  SendConnectorEvent,
  makeManagedIntegrationsHttpBinding({
    capability: "SendConnectorEvent",
    iamActions: ["iotmanagedintegrations:SendConnectorEvent"],
    operation: mi.sendConnectorEvent,
  }),
);
