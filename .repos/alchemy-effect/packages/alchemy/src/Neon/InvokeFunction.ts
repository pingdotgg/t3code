import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import { type RuntimeContext } from "../RuntimeContext.ts";
import type { Function } from "./Function.ts";

export interface InvokeFunctionClient {
  /** Public base URL; access control remains the application's responsibility. */
  url: Effect.Effect<string, never, RuntimeContext>;
  /** Stream an HTTP response. Supply caller authorization explicitly; no account API key is attached. */
  fetch(
    path?: string,
    init?: RequestInit,
  ): Effect.Effect<Response, InvokeFunctionError, RuntimeContext>;
}

import * as Data from "effect/Data";
export class InvokeFunctionError extends Data.TaggedError(
  "InvokeFunctionError",
)<{ message: string }> {}

/**
 * Bind a public Function URL to any Alchemy runtime host.
 *
 * ### Invoke a Function
 * **Example:** Forward explicit caller credentials
 * ```typescript
 * const invoke = yield* Neon.InvokeFunction(api);
 * const response = yield* invoke.fetch("/private", { headers: { authorization: bearer } });
 * ```
 *
 * @binding
 * @product Function
 */
export interface InvokeFunction extends Binding.Service<
  InvokeFunction,
  "Neon.InvokeFunction",
  (fn: Function) => Effect.Effect<InvokeFunctionClient>
> {}
export const InvokeFunction = Binding.Service<InvokeFunction>(
  "Neon.InvokeFunction",
);
