import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { DisableDelegatedAdminAccount } from "./DisableDelegatedAdminAccount.ts";

export const DisableDelegatedAdminAccountHttp = Layer.effect(
  DisableDelegatedAdminAccount,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.DisableDelegatedAdminAccount",
    operation: inspector2.disableDelegatedAdminAccount,
    actions: ["inspector2:DisableDelegatedAdminAccount"],
  }),
);
