import type {
  BillingMeter as StripeBillingMeter,
  GetBillingMeterError,
  GetBillingMeterRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BillingMeter } from "./BillingMeter.ts";

export interface RetrieveBillingMeterRequest extends Omit<GetBillingMeterRequest, "id"> {}

/**
 * Retrieve a bound Stripe Billing Meter over HTTP.
 *
 * ### Reading a Billing Meter
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveBillingMeter(usage);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Billing
 */
export interface RetrieveBillingMeter extends Binding.Service<
  RetrieveBillingMeter,
  "Stripe.RetrieveBillingMeter",
  (
    meter: BillingMeter,
  ) => Effect.Effect<
    (
      request?: RetrieveBillingMeterRequest,
    ) => Effect.Effect<StripeBillingMeter, GetBillingMeterError, RuntimeContext>
  >
> {}

export const RetrieveBillingMeter = Binding.Service<RetrieveBillingMeter>(
  "Stripe.RetrieveBillingMeter",
);
