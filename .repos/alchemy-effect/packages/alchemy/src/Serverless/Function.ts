import * as Effect from "effect/Effect";
import type { HttpEffect } from "../Http.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";

export interface FunctionContext extends BaseRuntimeContext {
  /**
   * Register an HTTP handler. The optional `shape` payload is the user's
   * full default-export shape — Cloudflare Workers use it to expose
   * non-handler methods (e.g. `greet`) as RPC methods on the deployed
   * `WorkerEntrypoint`. Other platforms (Lambda, etc.) ignore it.
   */
  serve<Req = never>(
    handler: HttpEffect<Req>,
    options?: { shape?: Record<string, unknown> },
  ): Effect.Effect<void, never, Req>;
  listen<A, Req = never>(
    handler: FunctionListener<A, Req>,
  ): Effect.Effect<void, never, Req>;
  listen<A, Req = never, InitReq = never>(
    effect: Effect.Effect<FunctionListener<A, Req>, never, InitReq>,
  ): Effect.Effect<void, never, Req | InitReq>;
  exports: Effect.Effect<Record<string, any>, never, never>;
}

export type FunctionListener<A = any, Req = never> = (
  event: any,
) => Effect.Effect<A, never, Req> | void;
