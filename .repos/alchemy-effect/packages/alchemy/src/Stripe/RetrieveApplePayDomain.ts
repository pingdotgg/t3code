import type {
  ApplePayDomain as StripeApplePayDomain,
  GetApplePayDomainError,
  GetApplePayDomainRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ApplePayDomain } from "./ApplePayDomain.ts";

export interface RetrieveApplePayDomainRequest extends Omit<
  GetApplePayDomainRequest,
  "domain"
> {}

/**
 * Retrieve a bound Stripe Apple Pay Domain over HTTP.
 *
 * ### Reading an Apple Pay Domain
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveApplePayDomain(pay);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveApplePayDomain extends Binding.Service<
  RetrieveApplePayDomain,
  "Stripe.RetrieveApplePayDomain",
  (
    applePayDomain: ApplePayDomain,
  ) => Effect.Effect<
    (
      request?: RetrieveApplePayDomainRequest,
    ) => Effect.Effect<
      StripeApplePayDomain,
      GetApplePayDomainError,
      RuntimeContext
    >
  >
> {}

export const RetrieveApplePayDomain = Binding.Service<RetrieveApplePayDomain>(
  "Stripe.RetrieveApplePayDomain",
);
