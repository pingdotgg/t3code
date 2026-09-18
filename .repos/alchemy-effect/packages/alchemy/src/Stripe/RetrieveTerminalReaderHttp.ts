import { GetTerminalReader } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveTerminalReader } from "./RetrieveTerminalReader.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveTerminalReader}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.RetrieveTerminalReader
 */
export const RetrieveTerminalReaderHttp = Layer.effect(
  RetrieveTerminalReader,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveTerminalReader",
    operation: GetTerminalReader,
    idField: "reader",
    permissions: ["terminal_read"],
  }),
);
