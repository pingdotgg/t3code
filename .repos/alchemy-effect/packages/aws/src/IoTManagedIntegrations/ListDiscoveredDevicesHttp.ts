import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedIntegrationsHttpBinding } from "./BindingHttp.ts";
import { ListDiscoveredDevices } from "./ListDiscoveredDevices.ts";

export const ListDiscoveredDevicesHttp = Layer.effect(
  ListDiscoveredDevices,
  makeManagedIntegrationsHttpBinding({
    capability: "ListDiscoveredDevices",
    iamActions: ["iotmanagedintegrations:ListDiscoveredDevices"],
    operation: mi.listDiscoveredDevices,
  }),
);
