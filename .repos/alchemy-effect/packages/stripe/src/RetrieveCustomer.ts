import type {
  GetCustomerError,
  GetCustomerRequest,
  GetCustomerResponse,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Customer } from "./Customer.ts";

export interface RetrieveCustomerRequest extends Omit<GetCustomerRequest, "customer"> {}

/**
 * Retrieve a bound Stripe Customer over HTTP.
 *
 * ### Reading a Customer
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveCustomer(alice);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Customer
 */
export interface RetrieveCustomer extends Binding.Service<
  RetrieveCustomer,
  "Stripe.RetrieveCustomer",
  (
    customer: Customer,
  ) => Effect.Effect<
    (
      request?: RetrieveCustomerRequest,
    ) => Effect.Effect<GetCustomerResponse, GetCustomerError, RuntimeContext>
  >
> {}

export const RetrieveCustomer = Binding.Service<RetrieveCustomer>("Stripe.RetrieveCustomer");
