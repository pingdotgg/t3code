import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Layer from "effect/Layer";
import { makeManagedThingHttpBinding } from "./BindingHttp.ts";
import { ListManagedThingSchemas } from "./ListManagedThingSchemas.ts";

export const ListManagedThingSchemasHttp = Layer.effect(
  ListManagedThingSchemas,
  makeManagedThingHttpBinding({
    capability: "ListManagedThingSchemas",
    iamActions: ["iotmanagedintegrations:ListManagedThingSchemas"],
    operation: mi.listManagedThingSchemas,
    key: "Identifier",
  }),
);
