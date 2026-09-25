import type {
  GetPaymentMethodConfigurationError,
  GetPaymentMethodConfigurationRequest,
  PaymentMethodConfiguration as StripePaymentMethodConfiguration,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { PaymentMethodConfiguration } from "./PaymentMethodConfiguration.ts";

export interface RetrievePaymentMethodConfigurationRequest extends Omit<
  GetPaymentMethodConfigurationRequest,
  "configuration"
> {}

/**
 * Retrieve a bound Stripe Payment Method Configuration over HTTP.
 *
 * ### Reading a Payment Method Configuration
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrievePaymentMethodConfiguration(checkout);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrievePaymentMethodConfiguration extends Binding.Service<
  RetrievePaymentMethodConfiguration,
  "Stripe.RetrievePaymentMethodConfiguration",
  (
    configuration: PaymentMethodConfiguration,
  ) => Effect.Effect<
    (
      request?: RetrievePaymentMethodConfigurationRequest,
    ) => Effect.Effect<
      StripePaymentMethodConfiguration,
      GetPaymentMethodConfigurationError,
      RuntimeContext
    >
  >
> {}

export const RetrievePaymentMethodConfiguration =
  Binding.Service<RetrievePaymentMethodConfiguration>(
    "Stripe.RetrievePaymentMethodConfiguration",
  );
