import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Layer from "effect/Layer";
import { makeIdentityStoreHttpBinding } from "./BindingHttp.ts";
import { GetUserId } from "./GetUserId.ts";

export const GetUserIdHttp = Layer.effect(
  GetUserId,
  makeIdentityStoreHttpBinding({
    tag: "AWS.IdentityCenter.GetUserId",
    operation: identitystore.getUserId,
    actions: ["identitystore:GetUserId"],
  }),
);
