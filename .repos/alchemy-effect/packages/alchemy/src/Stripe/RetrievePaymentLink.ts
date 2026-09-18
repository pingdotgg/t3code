import type {
  GetPaymentLinkError,
  GetPaymentLinkRequest,
  PaymentLink as StripePaymentLink,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { PaymentLink } from "./PaymentLink.ts";

export interface RetrievePaymentLinkRequest extends Omit<
  GetPaymentLinkRequest,
  "payment_link"
> {}

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
