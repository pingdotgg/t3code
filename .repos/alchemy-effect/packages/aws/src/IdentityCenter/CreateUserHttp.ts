import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { CreateUser } from "./CreateUser.ts";

export const CreateUserHttp = Layer.effect(
  CreateUser,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.CreateUser",
    operation: identitystore.createUser,
    actions: ["identitystore:CreateUser"],
  }),
);
