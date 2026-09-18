import type {
  Customer as StripeCustomer,
  UpdateCustomerError,
  UpdateCustomerRequest as DistilledUpdateCustomerRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Customer } from "./Customer.ts";

export interface UpdateCustomerRequest extends Omit<
  DistilledUpdateCustomerRequest,
  "customer"
> {}

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

export const UpdateCustomer = Binding.Service<UpdateCustomer>(
  "Stripe.UpdateCustomer",
);
