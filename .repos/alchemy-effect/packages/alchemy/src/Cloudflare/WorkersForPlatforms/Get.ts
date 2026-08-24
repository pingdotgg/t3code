/// <reference types="@cloudflare/workers-types" />

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { DispatchNamespace as DispatchNamespaceResource } from "./DispatchNamespace.ts";

/**
 * Bind a {@link DispatchNamespace} to a Worker and obtain the Effect-native
 * dynamic-dispatch client (`get`).
 *
 * `Get` is a single identifier that is simultaneously the binding's Context
 * tag, its type, and the callable —
 * `yield* Cloudflare.WorkersForPlatforms.Get(namespace)`.
 *
 * Provide {@link GetBinding} on the Worker's runtime layer to resolve the
 * underlying `dispatch_namespace` binding at request time.
 *
 * @binding
 * @product Workers for Platforms
 * @category Workers & Compute
 *
 * @section Dispatching to user Workers
 * @example Dispatch a request to a customer Worker
 * Bind the namespace during the Worker's init phase, then look up and forward
 * to a user Worker from a request handler.
 * ```typescript
 * const dispatch = yield* Cloudflare.WorkersForPlatforms.Get(namespace);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *     const userWorker = yield* dispatch.get("customer-a");
 *     return yield* Effect.promise(() => userWorker.fetch(request));
 *   }),
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/dynamic-dispatch/
 */
export interface Get extends Binding.Service<
  Get,
  "Cloudflare.WorkersForPlatforms.Get",
  (
    namespace: DispatchNamespaceResource,
  ) => Effect.Effect<DispatchNamespaceClient>
> {}

export const Get = Binding.Service<Get>("Cloudflare.WorkersForPlatforms.Get");

/** Error raised by dynamic-dispatch runtime operations. */
export class DispatchNamespaceError extends Data.TaggedError(
  "DispatchNamespaceError",
)<{
  /** Human-readable runtime error message. */
  message: string;
  /** Original error thrown by the Cloudflare runtime binding. */
  cause: unknown;
}> {}

/**
 * Effect-native client for a Workers for Platforms dispatch-namespace Worker
 * binding.
 *
 * Wraps the runtime `DispatchNamespace` binding so the lookup returns an
 * Effect tagged with {@link DispatchNamespaceError}. Use
 * `Cloudflare.WorkersForPlatforms.Get(namespace)` inside a Worker's init
 * phase.
 */
export interface DispatchNamespaceClient {
  /** Effect resolving to the raw dispatch-namespace runtime binding. */
  raw: Effect.Effect<DispatchNamespace, never, RuntimeContext>;
  /**
   * Look up a user Worker in the dispatch namespace by script name and obtain
   * a `Fetcher` to send it requests.
   *
   * @param name Name of the user Worker script.
   * @param args Arguments passed to the user Worker script.
   * @param options Options for the dynamic-dispatch invocation.
   */
  get(
    name: string,
    args?: { [key: string]: any },
    options?: DynamicDispatchOptions,
  ): Effect.Effect<Fetcher, DispatchNamespaceError, RuntimeContext>;
}
