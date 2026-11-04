import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { GetPermission } from "./GetPermission.ts";

export const GetPermissionHttp = Layer.effect(
  GetPermission,
  makeRAMHttpBinding({
    capability: "GetPermission",
    iamActions: ["ram:GetPermission"],
    operation: ram.getPermission,
  }),
);
