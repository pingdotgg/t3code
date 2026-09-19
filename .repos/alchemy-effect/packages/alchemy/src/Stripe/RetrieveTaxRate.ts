import type {
  GetTaxRateError,
  GetTaxRateRequest,
  TaxRate as StripeTaxRate,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { TaxRate } from "./TaxRate.ts";

export interface RetrieveTaxRateRequest extends Omit<
  GetTaxRateRequest,
  "tax_rate"
> {}

/**
 * Retrieve a bound Stripe Tax Rate over HTTP.
 *
 * ### Reading a Tax Rate
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveTaxRate(vat);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveTaxRate extends Binding.Service<
  RetrieveTaxRate,
  "Stripe.RetrieveTaxRate",
  (
    taxRate: TaxRate,
  ) => Effect.Effect<
    (
      request?: RetrieveTaxRateRequest,
    ) => Effect.Effect<StripeTaxRate, GetTaxRateError, RuntimeContext>
  >
> {}

export const RetrieveTaxRate = Binding.Service<RetrieveTaxRate>(
  "Stripe.RetrieveTaxRate",
);
