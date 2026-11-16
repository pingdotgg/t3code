import type {
  GetTerminalLocationError,
  GetTerminalLocationRequest,
  GetTerminalLocationResponse,
} from "@distilled.cloud/stripe/stripe";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { TerminalLocation } from "./TerminalLocation.ts";

export interface RetrieveTerminalLocationRequest extends Omit<
  GetTerminalLocationRequest,
  "location"
> {}

/**
 * Retrieve a bound Stripe Terminal Location over HTTP.
 *
 * ### Reading a Terminal Location
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveTerminalLocation(store);
 * const live = yield* retrieve();
 * ```
 *
 * @binding
 * @product Terminal
 */
export interface RetrieveTerminalLocation extends Binding.Service<
  RetrieveTerminalLocation,
  "Stripe.RetrieveTerminalLocation",
  (
    location: TerminalLocation,
  ) => Effect.Effect<
    (
      request?: RetrieveTerminalLocationRequest,
    ) => Effect.Effect<GetTerminalLocationResponse, GetTerminalLocationError, RuntimeContext>
  >
> {}

export const RetrieveTerminalLocation = Binding.Service<RetrieveTerminalLocation>(
  "Stripe.RetrieveTerminalLocation",
);
