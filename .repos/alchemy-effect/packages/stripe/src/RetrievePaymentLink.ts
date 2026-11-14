import type {
  GetPaymentLinkError,
  GetPaymentLinkRequest,
  PaymentLink as StripePaymentLink,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { PaymentLink } from "./PaymentLink.ts";

export interface RetrievePaymentLinkRequest extends Omit<GetPaymentLinkRequest, "payment_link"> {}

/**
 * Retrieve a bound Stripe Payment Link over HTTP.
 *
 * ### Reading a Payment Link
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrievePaymentLink(checkout);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Checkout
 */
export interface RetrievePaymentLink extends Binding.Service<
  RetrievePaymentLink,
  "Stripe.RetrievePaymentLink",
  (
    paymentLink: PaymentLink,
  ) => Effect.Effect<
    (
      request?: RetrievePaymentLinkRequest,
    ) => Effect.Effect<StripePaymentLink, GetPaymentLinkError, RuntimeContext>
  >
> {}

export const RetrievePaymentLink = Binding.Service<RetrievePaymentLink>(
  "Stripe.RetrievePaymentLink",
);
