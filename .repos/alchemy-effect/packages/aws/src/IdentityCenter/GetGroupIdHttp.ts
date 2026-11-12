import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { GetGroupId } from "./GetGroupId.ts";

export const GetGroupIdHttp = Layer.effect(
  GetGroupId,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.GetGroupId",
    operation: identitystore.getGroupId,
    actions: ["identitystore:GetGroupId"],
  }),
);
