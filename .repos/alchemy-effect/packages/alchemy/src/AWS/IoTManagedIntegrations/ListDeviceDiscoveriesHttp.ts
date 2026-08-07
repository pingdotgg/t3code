import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedIntegrationsHttpBinding } from "./BindingHttp.ts";
import { ListDeviceDiscoveries } from "./ListDeviceDiscoveries.ts";

export const ListDeviceDiscoveriesHttp = Layer.effect(
  ListDeviceDiscoveries,
  makeManagedIntegrationsHttpBinding({
    capability: "ListDeviceDiscoveries",
    iamActions: ["iotmanagedintegrations:ListDeviceDiscoveries"],
    operation: mi.listDeviceDiscoveries,
  }),
);
