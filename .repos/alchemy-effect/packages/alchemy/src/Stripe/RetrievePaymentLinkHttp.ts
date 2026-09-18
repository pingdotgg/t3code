import { GetPaymentLink } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrievePaymentLink } from "./RetrievePaymentLink.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrievePaymentLink}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrievePaymentLink
 */
export const RetrievePaymentLinkHttp = Layer.effect(
  RetrievePaymentLink,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrievePaymentLink",
    operation: GetPaymentLink,
    idField: "payment_link",
    permissions: ["payment_links_read"],
  }),
);
