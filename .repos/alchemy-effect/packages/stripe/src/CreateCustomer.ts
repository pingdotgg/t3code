import type {
  Customer as StripeCustomer,
  CreateCustomerError,
  CreateCustomerRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Create a Stripe Customer over HTTP. Account-scoped — binds the API key
 * onto the host, not a specific customer resource.
 *
 * ### Creating a Customer at runtime
 * **Example:** Bind and create
 * ```typescript
 * const create = yield* Stripe.CreateCustomer();
 * const customer = yield* create({
 *   email: "alice@example.com",
 *   name: "Alice",
 * });
 * ```
 *
 * @binding
 * @product Customer
 */
export interface CreateCustomer extends Binding.Service<
  CreateCustomer,
  "Stripe.CreateCustomer",
  () => Effect.Effect<
    (
      request: CreateCustomerRequest,
    ) => Effect.Effect<StripeCustomer, CreateCustomerError, RuntimeContext>
  >
> {}

export const CreateCustomer = Binding.Service<CreateCustomer>("Stripe.CreateCustomer");
