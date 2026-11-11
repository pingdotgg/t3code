import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedIntegrationsHttpBinding } from "./BindingHttp.ts";
import { GetSchemaVersion } from "./GetSchemaVersion.ts";

export const GetSchemaVersionHttp = Layer.effect(
  GetSchemaVersion,
  makeManagedIntegrationsHttpBinding({
    capability: "GetSchemaVersion",
    iamActions: ["iotmanagedintegrations:GetSchemaVersion"],
    operation: mi.getSchemaVersion,
  }),
);
