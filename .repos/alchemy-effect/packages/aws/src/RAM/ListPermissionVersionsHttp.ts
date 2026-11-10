import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { ListPermissionVersions } from "./ListPermissionVersions.ts";

export const ListPermissionVersionsHttp = Layer.effect(
  ListPermissionVersions,
  makeRAMHttpBinding({
    capability: "ListPermissionVersions",
    iamActions: ["ram:ListPermissionVersions"],
    operation: ram.listPermissionVersions,
  }),
);
