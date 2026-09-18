import { CreateAccount as createAccountOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateAccount } from "./CreateAccount.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateAccount}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateAccount
 */
export const CreateAccountHttp = Layer.effect(
  CreateAccount,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateAccount",
    operation: createAccountOp,
    permissions: ["accounts_write"],
  }),
);
