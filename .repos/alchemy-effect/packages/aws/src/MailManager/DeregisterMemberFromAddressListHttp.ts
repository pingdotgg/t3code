import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeAddressListHttpBinding } from "./BindingHttp.ts";
import { DeregisterMemberFromAddressList } from "./DeregisterMemberFromAddressList.ts";

export const DeregisterMemberFromAddressListHttp = Layer.effect(
  DeregisterMemberFromAddressList,
  makeAddressListHttpBinding({
    tag: "AWS.MailManager.DeregisterMemberFromAddressList",
    operation: mm.deregisterMemberFromAddressList,
    actions: ["ses:DeregisterMemberFromAddressList"],
  }),
);
