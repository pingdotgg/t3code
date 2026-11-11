import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { GetGroupMembershipId } from "./GetGroupMembershipId.ts";

export const GetGroupMembershipIdHttp = Layer.effect(
  GetGroupMembershipId,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.GetGroupMembershipId",
    operation: identitystore.getGroupMembershipId,
    actions: ["identitystore:GetGroupMembershipId"],
  }),
);
