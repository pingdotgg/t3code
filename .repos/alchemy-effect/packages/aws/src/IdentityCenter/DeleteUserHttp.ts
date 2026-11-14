import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { DeleteUser } from "./DeleteUser.ts";

export const DeleteUserHttp = Layer.effect(
  DeleteUser,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.DeleteUser",
    operation: identitystore.deleteUser,
    actions: ["identitystore:DeleteUser"],
  }),
);
