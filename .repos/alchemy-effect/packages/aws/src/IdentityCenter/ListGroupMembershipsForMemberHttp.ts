import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { ListGroupMembershipsForMember } from "./ListGroupMembershipsForMember.ts";

export const ListGroupMembershipsForMemberHttp = Layer.effect(
  ListGroupMembershipsForMember,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.ListGroupMembershipsForMember",
    operation: identitystore.listGroupMembershipsForMember,
    actions: ["identitystore:ListGroupMembershipsForMember"],
  }),
);
