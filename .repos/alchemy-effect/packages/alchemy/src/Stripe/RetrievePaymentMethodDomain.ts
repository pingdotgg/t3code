import type {
  GetPaymentMethodDomainError,
  GetPaymentMethodDomainRequest,
  PaymentMethodDomain as StripePaymentMethodDomain,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { PaymentMethodDomain } from "./PaymentMethodDomain.ts";

export interface RetrievePaymentMethodDomainRequest extends Omit<
  GetPaymentMethodDomainRequest,
  "payment_method_domain"
> {}

/**
 * Retrieve a bound Stripe Payment Method Domain over HTTP.
 *
 * ### Reading a Payment Method Domain
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrievePaymentMethodDomain(domain);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrievePaymentMethodDomain extends Binding.Service<
  RetrievePaymentMethodDomain,
  "Stripe.RetrievePaymentMethodDomain",
  (
    domain: PaymentMethodDomain,
  ) => Effect.Effect<
    (
      request?: RetrievePaymentMethodDomainRequest,
    ) => Effect.Effect<
      StripePaymentMethodDomain,
      GetPaymentMethodDomainError,
      RuntimeContext
    >
  >
> {}

export const RetrievePaymentMethodDomain =
  Binding.Service<RetrievePaymentMethodDomain>(
    "Stripe.RetrievePaymentMethodDomain",
  );
