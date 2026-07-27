import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedThingHttpBinding } from "./BindingHttp.ts";
import { GetManagedThingCapabilities } from "./GetManagedThingCapabilities.ts";

export const GetManagedThingCapabilitiesHttp = Layer.effect(
  GetManagedThingCapabilities,
  makeManagedThingHttpBinding({
    capability: "GetManagedThingCapabilities",
    iamActions: ["iotmanagedintegrations:GetManagedThingCapabilities"],
    operation: mi.getManagedThingCapabilities,
    key: "Identifier",
  }),
);
