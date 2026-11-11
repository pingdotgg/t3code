import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { ListGroups } from "./ListGroups.ts";

export const ListGroupsHttp = Layer.effect(
  ListGroups,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.ListGroups",
    operation: identitystore.listGroups,
    actions: ["identitystore:ListGroups"],
  }),
);
