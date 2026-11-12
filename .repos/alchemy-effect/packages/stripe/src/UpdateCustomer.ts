import type {
  Customer as StripeCustomer,
  UpdateCustomerError,
  UpdateCustomerRequest as DistilledUpdateCustomerRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Customer } from "./Customer.ts";

export interface UpdateCustomerRequest extends Omit<DistilledUpdateCustomerRequest, "customer"> {}

/**
 * Update a bound Stripe Customer over HTTP.
 *
 * ### Updating a Customer
 * **Example:** Bind and update
 * ```typescript
 * const update = yield* Stripe.UpdateCustomer(alice);
 * const live = yield* update({ name: "Alice Example" });
 * ```
 *
 * @binding
 * @product Customer
 */
export interface UpdateCustomer extends Binding.Service<
  UpdateCustomer,
  "Stripe.UpdateCustomer",
  (
    customer: Customer,
  ) => Effect.Effect<
    (
      request?: UpdateCustomerRequest,
    ) => Effect.Effect<StripeCustomer, UpdateCustomerError, RuntimeContext>
  >
> {}

export const UpdateCustomer = Binding.Service<UpdateCustomer>("Stripe.UpdateCustomer");
