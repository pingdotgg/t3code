import { CreateTerminalReader as createTerminalReaderOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateTerminalReader } from "./CreateTerminalReader.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateTerminalReader}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @provides Stripe.CreateTerminalReader
 */
export const CreateTerminalReaderHttp = Layer.effect(
  CreateTerminalReader,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateTerminalReader",
    operation: createTerminalReaderOp,
    permissions: ["terminal_write"],
  }),
);
