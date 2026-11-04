import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { ListResourceSharePermissions } from "./ListResourceSharePermissions.ts";

export const ListResourceSharePermissionsHttp = Layer.effect(
  ListResourceSharePermissions,
  makeRAMHttpBinding({
    capability: "ListResourceSharePermissions",
    iamActions: ["ram:ListResourceSharePermissions"],
    operation: ram.listResourceSharePermissions,
  }),
);
