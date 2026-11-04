import type {
  Account as StripeAccount,
  CreateAccountError,
  CreateAccountRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

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
 * @product Account
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

export const CreateAccount = Binding.Service<CreateAccount>("Stripe.CreateAccount");
