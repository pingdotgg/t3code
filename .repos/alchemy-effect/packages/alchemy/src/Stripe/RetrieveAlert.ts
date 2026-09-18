import type {
  BillingAlert as StripeBillingAlert,
  GetBillingAlertError,
  GetBillingAlertRequest,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Alert } from "./Alert.ts";

export interface RetrieveAlertRequest extends Omit<
  GetBillingAlertRequest,
  "id"
> {}

/**
 * Retrieve a bound Stripe Billing Alert over HTTP.
 *
 * ### Reading an Alert
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveAlert(highUsage);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveAlert extends Binding.Service<
  RetrieveAlert,
  "Stripe.RetrieveAlert",
  (
    alert: Alert,
  ) => Effect.Effect<
    (
      request?: RetrieveAlertRequest,
    ) => Effect.Effect<StripeBillingAlert, GetBillingAlertError, RuntimeContext>
  >
> {}

export const RetrieveAlert = Binding.Service<RetrieveAlert>(
  "Stripe.RetrieveAlert",
);
