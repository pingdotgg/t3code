import type {
  BillingCreditGrant as StripeCreditGrant,
  UpdateBillingCreditGrantError,
  UpdateBillingCreditGrantRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CreditGrant } from "./CreditGrant.ts";

export interface UpdateCreditGrantRequest extends Omit<UpdateBillingCreditGrantRequest, "id"> {}

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
 * @product Billing
 */
export interface UpdateCreditGrant extends Binding.Service<
  UpdateCreditGrant,
  "Stripe.UpdateCreditGrant",
  (
    grant: CreditGrant,
  ) => Effect.Effect<
    (
      request?: UpdateCreditGrantRequest,
    ) => Effect.Effect<StripeCreditGrant, UpdateBillingCreditGrantError, RuntimeContext>
  >
> {}

export const UpdateCreditGrant = Binding.Service<UpdateCreditGrant>("Stripe.UpdateCreditGrant");
