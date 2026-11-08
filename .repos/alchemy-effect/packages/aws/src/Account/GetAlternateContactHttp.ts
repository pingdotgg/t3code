import * as account from "@distilled.cloud/aws/account";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { GetAlternateContact } from "./GetAlternateContact.ts";

export const GetAlternateContactHttp = Layer.effect(
  GetAlternateContact,
  makeAccountHttpBinding({
    capability: "GetAlternateContact",
    iamActions: ["account:GetAlternateContact"],
    operation: account.getAlternateContact,
  }),
);
