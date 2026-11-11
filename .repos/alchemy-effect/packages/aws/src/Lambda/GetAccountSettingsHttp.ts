import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Layer from "effect/Layer";
import { makeLambdaAccountHttpBinding } from "./BindingHttp.ts";
import { GetAccountSettings } from "./GetAccountSettings.ts";

export const GetAccountSettingsHttp = Layer.effect(
  GetAccountSettings,
  makeLambdaAccountHttpBinding({
    tag: "AWS.Lambda.GetAccountSettings",
    operation: Lambda.getAccountSettings,
    actions: ["lambda:GetAccountSettings"],
  }),
);
