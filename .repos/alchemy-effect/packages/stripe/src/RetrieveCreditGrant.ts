import type {
  BillingCreditGrant as StripeCreditGrant,
  GetBillingCreditGrantError,
  GetBillingCreditGrantRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CreditGrant } from "./CreditGrant.ts";

export interface RetrieveCreditGrantRequest extends Omit<GetBillingCreditGrantRequest, "id"> {}

/**
 * Retrieve a bound Stripe Credit Grant over HTTP.
 *
 * ### Reading a Credit Grant
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveCreditGrant(grant);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Billing
 */
export interface RetrieveCreditGrant extends Binding.Service<
  RetrieveCreditGrant,
  "Stripe.RetrieveCreditGrant",
  (
    grant: CreditGrant,
  ) => Effect.Effect<
    (
      request?: RetrieveCreditGrantRequest,
    ) => Effect.Effect<StripeCreditGrant, GetBillingCreditGrantError, RuntimeContext>
  >
> {}

export const RetrieveCreditGrant = Binding.Service<RetrieveCreditGrant>(
  "Stripe.RetrieveCreditGrant",
);
