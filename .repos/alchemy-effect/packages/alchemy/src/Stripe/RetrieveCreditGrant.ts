import type {
  BillingCreditGrant as StripeCreditGrant,
  GetBillingCreditGrantError,
  GetBillingCreditGrantRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { CreditGrant } from "./CreditGrant.ts";

export interface RetrieveCreditGrantRequest extends Omit<
  GetBillingCreditGrantRequest,
  "id"
> {}

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
 */
export interface RetrieveCreditGrant extends Binding.Service<
  RetrieveCreditGrant,
  "Stripe.RetrieveCreditGrant",
  (
    grant: CreditGrant,
  ) => Effect.Effect<
    (
      request?: RetrieveCreditGrantRequest,
    ) => Effect.Effect<
      StripeCreditGrant,
      GetBillingCreditGrantError,
      RuntimeContext
    >
  >
> {}

export const RetrieveCreditGrant = Binding.Service<RetrieveCreditGrant>(
  "Stripe.RetrieveCreditGrant",
);
