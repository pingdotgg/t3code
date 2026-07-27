import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Layer from "effect/Layer";
import { makeAossAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateAccountSettings } from "./UpdateAccountSettings.ts";

export const UpdateAccountSettingsHttp = Layer.effect(
  UpdateAccountSettings,
  makeAossAccountHttpBinding({
    tag: "AWS.OpenSearchServerless.UpdateAccountSettings",
    operation: aoss.updateAccountSettings,
    actions: ["aoss:UpdateAccountSettings"],
  }),
);
