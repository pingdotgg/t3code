import type {
  Account as StripeAccount,
  CreateAccountError,
  CreateAccountRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * Create a Stripe Connect Account over HTTP. Account-scoped — binds the
 * API key onto the host, not a specific connected account.
 *
 * ### Creating an Account at runtime
 * **Example:** Bind and create
 * ```typescript
 * const create = yield* Stripe.CreateAccount();
 * const account = yield* create({
 *   type: "express",
 *   country: "US",
 *   email: "merchant@example.com",
 * });
 * ```
 *
 * @binding
 */
export interface CreateAccount extends Binding.Service<
  CreateAccount,
  "Stripe.CreateAccount",
  () => Effect.Effect<
    (
      request: CreateAccountRequest,
    ) => Effect.Effect<StripeAccount, CreateAccountError, RuntimeContext>
  >
> {}

export const CreateAccount = Binding.Service<CreateAccount>(
  "Stripe.CreateAccount",
);
