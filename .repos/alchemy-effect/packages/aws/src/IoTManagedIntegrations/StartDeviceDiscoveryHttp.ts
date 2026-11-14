import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedIntegrationsHttpBinding } from "./BindingHttp.ts";
import { StartDeviceDiscovery } from "./StartDeviceDiscovery.ts";

export const StartDeviceDiscoveryHttp = Layer.effect(
  StartDeviceDiscovery,
  makeManagedIntegrationsHttpBinding({
    capability: "StartDeviceDiscovery",
    iamActions: ["iotmanagedintegrations:StartDeviceDiscovery"],
    operation: mi.startDeviceDiscovery,
  }),
);
