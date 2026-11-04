import type {
  GetPaymentMethodConfigurationError,
  GetPaymentMethodConfigurationRequest,
  PaymentMethodConfiguration as StripePaymentMethodConfiguration,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
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
 * @product Payment Methods
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
  Binding.Service<RetrievePaymentMethodConfiguration>("Stripe.RetrievePaymentMethodConfiguration");
