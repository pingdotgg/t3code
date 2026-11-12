import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { ListPermissions } from "./ListPermissions.ts";

export const ListPermissionsHttp = Layer.effect(
  ListPermissions,
  makeRAMHttpBinding({
    capability: "ListPermissions",
    iamActions: ["ram:ListPermissions"],
    operation: ram.listPermissions,
  }),
);
