import { UpdateTerminalReader as updateTerminalReaderOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";
import { UpdateTerminalReader } from "./UpdateTerminalReader.ts";

/**
 * HTTP implementation of {@link UpdateTerminalReader}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.UpdateTerminalReader
 */
export const UpdateTerminalReaderHttp = Layer.effect(
  UpdateTerminalReader,
  makeHttpStripeIdBinding({
    tag: "Stripe.UpdateTerminalReader",
    operation: updateTerminalReaderOp,
    idField: "reader",
    permissions: ["terminal_write"],
  }),
);
