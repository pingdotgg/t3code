import type {
  UpdateTerminalReaderError,
  UpdateTerminalReaderRequest as DistilledUpdateTerminalReaderRequest,
  UpdateTerminalReaderResponse,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { TerminalReader } from "./TerminalReader.ts";

export interface UpdateTerminalReaderRequest extends Omit<
  DistilledUpdateTerminalReaderRequest,
  "reader"
> {}

/**
 * Update a bound Stripe Terminal Reader over HTTP.
 *
 * ### Updating a Reader
 * **Example:** Bind and relabel
 * ```typescript
 * const update = yield* Stripe.UpdateTerminalReader(reader);
 * const live = yield* update({ label: "Front counter (updated)" });
 * ```
 *
 * @binding
 * @product Terminal
 */
export interface UpdateTerminalReader extends Binding.Service<
  UpdateTerminalReader,
  "Stripe.UpdateTerminalReader",
  (
    reader: TerminalReader,
  ) => Effect.Effect<
    (
      request?: UpdateTerminalReaderRequest,
    ) => Effect.Effect<UpdateTerminalReaderResponse, UpdateTerminalReaderError, RuntimeContext>
  >
> {}

export const UpdateTerminalReader = Binding.Service<UpdateTerminalReader>(
  "Stripe.UpdateTerminalReader",
);
