import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeAddressListHttpBinding } from "./BindingHttp.ts";
import { GetMemberOfAddressList } from "./GetMemberOfAddressList.ts";

export const GetMemberOfAddressListHttp = Layer.effect(
  GetMemberOfAddressList,
  makeAddressListHttpBinding({
    tag: "AWS.MailManager.GetMemberOfAddressList",
    operation: mm.getMemberOfAddressList,
    actions: ["ses:GetMemberOfAddressList"],
  }),
);
