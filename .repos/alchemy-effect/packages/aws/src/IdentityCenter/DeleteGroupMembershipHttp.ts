import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { DeleteGroupMembership } from "./DeleteGroupMembership.ts";

export const DeleteGroupMembershipHttp = Layer.effect(
  DeleteGroupMembership,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.DeleteGroupMembership",
    operation: identitystore.deleteGroupMembership,
    actions: ["identitystore:DeleteGroupMembership"],
  }),
);
