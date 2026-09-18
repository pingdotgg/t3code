import { CreateAccountLink as createAccountLinkOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateAccountLink } from "./CreateAccountLink.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateAccountLink}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateAccountLink
 */
export const CreateAccountLinkHttp = Layer.effect(
  CreateAccountLink,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateAccountLink",
    operation: createAccountLinkOp,
    permissions: ["accounts_write"],
  }),
);
