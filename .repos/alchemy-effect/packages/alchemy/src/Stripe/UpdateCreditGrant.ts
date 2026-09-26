import type {
  BillingCreditGrant as StripeCreditGrant,
  UpdateBillingCreditGrantError,
  UpdateBillingCreditGrantRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { CreditGrant } from "./CreditGrant.ts";

export interface UpdateCreditGrantRequest extends Omit<
  UpdateBillingCreditGrantRequest,
  "id"
> {}

/**
 * Update a bound Stripe Credit Grant over HTTP. Mutable fields are
 * `expires_at` and `metadata`.
 *
 * ### Updating a Credit Grant
 * **Example:** Bind and update
 * ```typescript
 * const update = yield* Stripe.UpdateCreditGrant(grant);
 * const live = yield* update({ expires_at: 4102444800 });
 * ```
 *
 * @binding
 */
export interface UpdateCreditGrant extends Binding.Service<
  UpdateCreditGrant,
  "Stripe.UpdateCreditGrant",
  (
    grant: CreditGrant,
  ) => Effect.Effect<
    (
      request?: UpdateCreditGrantRequest,
    ) => Effect.Effect<
      StripeCreditGrant,
      UpdateBillingCreditGrantError,
      RuntimeContext
    >
  >
> {}

export const UpdateCreditGrant = Binding.Service<UpdateCreditGrant>(
  "Stripe.UpdateCreditGrant",
);
