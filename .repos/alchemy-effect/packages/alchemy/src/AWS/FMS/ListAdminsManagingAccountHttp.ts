import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { ListAdminsManagingAccount } from "./ListAdminsManagingAccount.ts";

export const ListAdminsManagingAccountHttp = Layer.effect(
  ListAdminsManagingAccount,
  makeFmsHttpBinding({
    capability: "ListAdminsManagingAccount",
    iamActions: ["fms:ListAdminsManagingAccount"],
    operation: fms.listAdminsManagingAccount,
    pinToAdminRegion: true,
  }),
);
