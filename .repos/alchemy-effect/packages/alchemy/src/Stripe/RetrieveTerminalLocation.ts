import type {
  GetTerminalLocationError,
  GetTerminalLocationRequest,
  GetTerminalLocationResponse,
} from "@distilled.cloud/stripe/stripe";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
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
 */
export interface RetrieveTerminalLocation extends Binding.Service<
  RetrieveTerminalLocation,
  "Stripe.RetrieveTerminalLocation",
  (
    location: TerminalLocation,
  ) => Effect.Effect<
    (
      request?: RetrieveTerminalLocationRequest,
    ) => Effect.Effect<
      GetTerminalLocationResponse,
      GetTerminalLocationError,
      RuntimeContext
    >
  >
> {}

export const RetrieveTerminalLocation =
  Binding.Service<RetrieveTerminalLocation>("Stripe.RetrieveTerminalLocation");
