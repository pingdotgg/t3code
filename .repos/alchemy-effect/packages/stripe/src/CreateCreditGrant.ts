import type {
  BillingCreditGrant as StripeCreditGrant,
  CreateBillingCreditGrantError,
  CreateBillingCreditGrantRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Create a Stripe Credit Grant over HTTP. Account-scoped — binds the API
 * key onto the host, not a specific grant resource.
 *
 * ### Creating a Credit Grant at runtime
 * **Example:** Bind and create
 * ```typescript
 * const create = yield* Stripe.CreateCreditGrant();
 * const grant = yield* create({
 *   customer: "cus_123",
 *   amount: { type: "monetary", monetary: { currency: "usd", value: 1000 } },
 *   applicability_config: { scope: { price_type: "metered" } },
 *   category: "promotional",
 *   name: "Welcome credits",
 * });
 * ```
 *
 * @binding
 * @product Billing
 */
export interface CreateCreditGrant extends Binding.Service<
  CreateCreditGrant,
  "Stripe.CreateCreditGrant",
  () => Effect.Effect<
    (
      request: CreateBillingCreditGrantRequest,
    ) => Effect.Effect<StripeCreditGrant, CreateBillingCreditGrantError, RuntimeContext>
  >
> {}

export const CreateCreditGrant = Binding.Service<CreateCreditGrant>("Stripe.CreateCreditGrant");
