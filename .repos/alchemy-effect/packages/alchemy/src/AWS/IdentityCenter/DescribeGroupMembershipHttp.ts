import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { DescribeGroupMembership } from "./DescribeGroupMembership.ts";

export const DescribeGroupMembershipHttp = Layer.effect(
  DescribeGroupMembership,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.DescribeGroupMembership",
    operation: identitystore.describeGroupMembership,
    actions: ["identitystore:DescribeGroupMembership"],
  }),
);
