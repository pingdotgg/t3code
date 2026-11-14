import * as account from "@distilled.cloud/aws/account";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { GetContactInformation } from "./GetContactInformation.ts";

export const GetContactInformationHttp = Layer.effect(
  GetContactInformation,
  makeAccountHttpBinding({
    capability: "GetContactInformation",
    iamActions: ["account:GetContactInformation"],
    operation: account.getContactInformation,
  }),
);
