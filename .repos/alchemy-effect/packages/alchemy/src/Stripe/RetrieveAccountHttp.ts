import { GetAccountByAccount } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveAccount } from "./RetrieveAccount.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveAccount}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveAccount
 */
export const RetrieveAccountHttp = Layer.effect(
  RetrieveAccount,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveAccount",
    operation: GetAccountByAccount,
    idField: "account",
    permissions: ["accounts_read"],
  }),
);
