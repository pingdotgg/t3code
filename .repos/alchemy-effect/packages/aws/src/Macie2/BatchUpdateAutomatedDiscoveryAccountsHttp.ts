import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { BatchUpdateAutomatedDiscoveryAccounts } from "./BatchUpdateAutomatedDiscoveryAccounts.ts";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";

export const BatchUpdateAutomatedDiscoveryAccountsHttp = Layer.effect(
  BatchUpdateAutomatedDiscoveryAccounts,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.BatchUpdateAutomatedDiscoveryAccounts",
    operation: macie2.batchUpdateAutomatedDiscoveryAccounts,
    actions: ["macie2:BatchUpdateAutomatedDiscoveryAccounts"],
  }),
);
