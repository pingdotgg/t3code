import type {
  GetTaxRegistrationError,
  GetTaxRegistrationRequest,
  TaxRegistration as StripeTaxRegistration,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { TaxRegistration } from "./TaxRegistration.ts";

export interface RetrieveTaxRegistrationRequest extends Omit<GetTaxRegistrationRequest, "id"> {}

/**
 * Retrieve a bound Stripe Tax Registration over HTTP.
 *
 * ### Reading a Tax Registration
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveTaxRegistration(registration);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Tax
 */
export interface RetrieveTaxRegistration extends Binding.Service<
  RetrieveTaxRegistration,
  "Stripe.RetrieveTaxRegistration",
  (
    taxRegistration: TaxRegistration,
  ) => Effect.Effect<
    (
      request?: RetrieveTaxRegistrationRequest,
    ) => Effect.Effect<StripeTaxRegistration, GetTaxRegistrationError, RuntimeContext>
  >
> {}

export const RetrieveTaxRegistration = Binding.Service<RetrieveTaxRegistration>(
  "Stripe.RetrieveTaxRegistration",
);
