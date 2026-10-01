import { UpdateAccount as updateAccountOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";
import { UpdateAccount } from "./UpdateAccount.ts";

/**
 * HTTP implementation of {@link UpdateAccount}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.UpdateAccount
 */
export const UpdateAccountHttp = Layer.effect(
  UpdateAccount,
  makeHttpStripeIdBinding({
    tag: "Stripe.UpdateAccount",
    operation: updateAccountOp,
    idField: "account",
    permissions: ["accounts_write"],
  }),
);
