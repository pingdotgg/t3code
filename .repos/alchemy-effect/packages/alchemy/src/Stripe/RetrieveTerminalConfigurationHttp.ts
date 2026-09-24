import { GetTerminalConfiguration } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveTerminalConfiguration } from "./RetrieveTerminalConfiguration.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveTerminalConfiguration}. Provide it
 * on the Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveTerminalConfiguration
 */
export const RetrieveTerminalConfigurationHttp = Layer.effect(
  RetrieveTerminalConfiguration,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveTerminalConfiguration",
    operation: GetTerminalConfiguration,
    idField: "configuration",
    permissions: ["terminal_read"],
  }),
);
