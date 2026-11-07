import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedIntegrationsHttpBinding } from "./BindingHttp.ts";
import { ListSchemaVersions } from "./ListSchemaVersions.ts";

export const ListSchemaVersionsHttp = Layer.effect(
  ListSchemaVersions,
  makeManagedIntegrationsHttpBinding({
    capability: "ListSchemaVersions",
    iamActions: ["iotmanagedintegrations:ListSchemaVersions"],
    operation: mi.listSchemaVersions,
  }),
);
