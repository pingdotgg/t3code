import type {
  GetTerminalReaderError,
  GetTerminalReaderRequest,
  GetTerminalReaderResponse,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { TerminalReader } from "./TerminalReader.ts";

export interface RetrieveTerminalReaderRequest extends Omit<
  GetTerminalReaderRequest,
  "reader"
> {}

/**
 * Retrieve a bound Stripe Terminal Reader over HTTP.
 *
 * ### Reading a Reader
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveTerminalReader(reader);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 */
export interface RetrieveTerminalReader extends Binding.Service<
  RetrieveTerminalReader,
  "Stripe.RetrieveTerminalReader",
  (
    reader: TerminalReader,
  ) => Effect.Effect<
    (
      request?: RetrieveTerminalReaderRequest,
    ) => Effect.Effect<
      GetTerminalReaderResponse,
      GetTerminalReaderError,
      RuntimeContext
    >
  >
> {}

export const RetrieveTerminalReader = Binding.Service<RetrieveTerminalReader>(
  "Stripe.RetrieveTerminalReader",
);
