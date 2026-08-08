import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeAddressListHttpBinding } from "./BindingHttp.ts";
import { ListMembersOfAddressList } from "./ListMembersOfAddressList.ts";

export const ListMembersOfAddressListHttp = Layer.effect(
  ListMembersOfAddressList,
  makeAddressListHttpBinding({
    tag: "AWS.MailManager.ListMembersOfAddressList",
    operation: mm.listMembersOfAddressList,
    actions: ["ses:ListMembersOfAddressList"],
  }),
);
