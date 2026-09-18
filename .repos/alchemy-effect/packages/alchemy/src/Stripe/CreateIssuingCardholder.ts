import type {
  IssuingCardholder as StripeIssuingCardholder,
  CreateIssuingCardholderError,
  CreateIssuingCardholderRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * Create a Stripe Issuing Cardholder over HTTP. Account-scoped — binds
 * the API key onto the host, not a specific cardholder resource.
 *
 * ### Creating a Cardholder at runtime
 * **Example:** Bind and create
 * ```typescript
 * const create = yield* Stripe.CreateIssuingCardholder();
 * const cardholder = yield* create({
 *   name: "Alice Example",
 *   billing: {
 *     address: {
 *       line1: "123 Main Street",
 *       city: "San Francisco",
 *       state: "CA",
 *       postal_code: "94111",
 *       country: "US",
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface CreateIssuingCardholder extends Binding.Service<
  CreateIssuingCardholder,
  "Stripe.CreateIssuingCardholder",
  () => Effect.Effect<
    (
      request: CreateIssuingCardholderRequest,
    ) => Effect.Effect<
      StripeIssuingCardholder,
      CreateIssuingCardholderError,
      RuntimeContext
    >
  >
> {}

export const CreateIssuingCardholder = Binding.Service<CreateIssuingCardholder>(
  "Stripe.CreateIssuingCardholder",
);
