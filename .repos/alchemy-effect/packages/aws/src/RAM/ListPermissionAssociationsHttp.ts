import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { ListPermissionAssociations } from "./ListPermissionAssociations.ts";

export const ListPermissionAssociationsHttp = Layer.effect(
  ListPermissionAssociations,
  makeRAMHttpBinding({
    capability: "ListPermissionAssociations",
    iamActions: ["ram:ListPermissionAssociations"],
    operation: ram.listPermissionAssociations,
  }),
);
