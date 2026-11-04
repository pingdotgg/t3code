import * as account from "@distilled.cloud/aws/account";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { GetAccountInformation } from "./GetAccountInformation.ts";

export const GetAccountInformationHttp = Layer.effect(
  GetAccountInformation,
  makeAccountHttpBinding({
    capability: "GetAccountInformation",
    iamActions: ["account:GetAccountInformation"],
    operation: account.getAccountInformation,
  }),
);
