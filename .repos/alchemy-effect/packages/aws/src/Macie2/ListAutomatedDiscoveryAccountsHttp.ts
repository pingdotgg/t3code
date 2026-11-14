import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { ListAutomatedDiscoveryAccounts } from "./ListAutomatedDiscoveryAccounts.ts";

export const ListAutomatedDiscoveryAccountsHttp = Layer.effect(
  ListAutomatedDiscoveryAccounts,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.ListAutomatedDiscoveryAccounts",
    operation: macie2.listAutomatedDiscoveryAccounts,
    actions: ["macie2:ListAutomatedDiscoveryAccounts"],
  }),
);
