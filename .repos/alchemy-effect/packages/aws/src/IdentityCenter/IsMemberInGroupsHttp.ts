import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { IsMemberInGroups } from "./IsMemberInGroups.ts";

export const IsMemberInGroupsHttp = Layer.effect(
  IsMemberInGroups,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.IsMemberInGroups",
    operation: identitystore.isMemberInGroups,
    actions: ["identitystore:IsMemberInGroups"],
  }),
);
