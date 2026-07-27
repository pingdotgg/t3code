import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { GetDelegatedAdminAccount } from "./GetDelegatedAdminAccount.ts";

export const GetDelegatedAdminAccountHttp = Layer.effect(
  GetDelegatedAdminAccount,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.GetDelegatedAdminAccount",
    operation: inspector2.getDelegatedAdminAccount,
    actions: ["inspector2:GetDelegatedAdminAccount"],
  }),
);
