import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedIntegrationsHttpBinding } from "./BindingHttp.ts";
import { GetCustomEndpoint } from "./GetCustomEndpoint.ts";

export const GetCustomEndpointHttp = Layer.effect(
  GetCustomEndpoint,
  makeManagedIntegrationsHttpBinding({
    capability: "GetCustomEndpoint",
    iamActions: ["iotmanagedintegrations:GetCustomEndpoint"],
    operation: mi.getCustomEndpoint,
  }),
);
