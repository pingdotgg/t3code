import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { ListMemberAccounts } from "./ListMemberAccounts.ts";

export const ListMemberAccountsHttp = Layer.effect(
  ListMemberAccounts,
  makeFmsHttpBinding({
    capability: "ListMemberAccounts",
    iamActions: ["fms:ListMemberAccounts"],
    operation: fms.listMemberAccounts,
  }),
);
