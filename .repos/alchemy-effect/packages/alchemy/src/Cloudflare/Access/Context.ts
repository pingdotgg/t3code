import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { WorkerExecutionContextAccess } from "../Workers/WorkerAccess.ts";
import { WorkerExecutionContext } from "../Workers/Worker.ts";

/**
 * One-yield accessor for the current request's Cloudflare Access context
 * (`ctx.access`) — sugar over `WorkerExecutionContext`:
 *
 * ```typescript
 * fetch: Effect.gen(function* () {
 *   const access = yield* Cloudflare.Access.Context;
 *   if (access === undefined) {
 *     return HttpServerResponse.text("Access required", { status: 403 });
 *   }
 *   const identity = yield* access.getIdentity();
 *   return yield* HttpServerResponse.json({
 *     aud: access.aud,
 *     email: identity?.email,
 *   });
 * }),
 * ```
 *
 * `undefined` when the request did not pass through Cloudflare Access (see
 * `Cloudflare.Access.Application` with `worker` / `all_workers`
 * destinations for turning enforcement on). Colored with
 * {@link RuntimeContext}: it can be closed over during init but only *run*
 * inside a request handler. Under `alchemy dev` the Worker's `dev.access`
 * config simulates the authenticated state.
 */
export const Context: Effect.Effect<
  WorkerExecutionContextAccess | undefined,
  never,
  RuntimeContext | WorkerExecutionContext
> = WorkerExecutionContext.pipe(Effect.flatMap((ctx) => ctx.access));
