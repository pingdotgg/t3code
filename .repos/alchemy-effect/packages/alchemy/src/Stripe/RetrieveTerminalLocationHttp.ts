import { GetTerminalLocation } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveTerminalLocation } from "./RetrieveTerminalLocation.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveTerminalLocation}. Provide it on
 * the Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveTerminalLocation
 */
export const RetrieveTerminalLocationHttp = Layer.effect(
  RetrieveTerminalLocation,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveTerminalLocation",
    operation: GetTerminalLocation,
    idField: "location",
    permissions: ["terminal_read"],
  }),
);
