import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossAccountHttpBinding } from "./BindingHttp.ts";
import { GetAccountSettings } from "./GetAccountSettings.ts";

export const GetAccountSettingsHttp = Layer.effect(
  GetAccountSettings,
  makeAossAccountHttpBinding({
    tag: "AWS.OpenSearchServerless.GetAccountSettings",
    operation: aoss.getAccountSettings,
    actions: ["aoss:GetAccountSettings"],
  }),
);
