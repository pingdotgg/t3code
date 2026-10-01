import type {
  CreateTerminalReaderError,
  CreateTerminalReaderRequest,
  TerminalReader as StripeTerminalReader,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * Create a Stripe Terminal Reader over HTTP. Account-scoped — binds the
 * API key onto the host, not a specific reader resource.
 *
 * ### Creating a Reader at runtime
 * **Example:** Bind and register a simulated reader
 * ```typescript
 * const create = yield* Stripe.CreateTerminalReader();
 * const reader = yield* create({
 *   registration_code: "simulated-wpe",
 *   label: "Front counter",
 *   location: locationId,
 * });
 * ```
 *
 * @binding
 */
export interface CreateTerminalReader extends Binding.Service<
  CreateTerminalReader,
  "Stripe.CreateTerminalReader",
  () => Effect.Effect<
    (
      request: CreateTerminalReaderRequest,
    ) => Effect.Effect<
      StripeTerminalReader,
      CreateTerminalReaderError,
      RuntimeContext
    >
  >
> {}

export const CreateTerminalReader = Binding.Service<CreateTerminalReader>(
  "Stripe.CreateTerminalReader",
);
