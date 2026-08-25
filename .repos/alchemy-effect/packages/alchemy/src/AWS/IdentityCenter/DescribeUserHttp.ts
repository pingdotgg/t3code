import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { DescribeUser } from "./DescribeUser.ts";

export const DescribeUserHttp = Layer.effect(
  DescribeUser,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.DescribeUser",
    operation: identitystore.describeUser,
    actions: ["identitystore:DescribeUser"],
  }),
);
