import * as Effect from "effect/Effect";
import type { Output } from "./Output.ts";
import { type BaseRuntimeContext, RuntimeContext } from "./RuntimeContext.ts";

/**
 * Runtime context bridge that lets an {@link Action} read Resource Outputs.
 *
 * Actions are peculiar: their init Effect runs at plan/stack-eval time (before
 * any resource exists) while their body runs at apply time (after upstreams are
 * materialized). To make `yield* db.databaseId` work inside an Action we split
 * the {@link RuntimeContext} into two cooperating halves that share nothing but
 * a sanitized key:
 *
 *  - {@link makeCaptureContext} is provided while the init Effect runs. Its
 *    `set(key, output)` records the referenced {@link Output} (so the engine can
 *    add a dependency edge and later resolve it) and its `get(key)` hands back a
 *    *deferred* accessor — an Effect that re-reads whatever `RuntimeContext` is
 *    ambient when it actually runs.
 *  - {@link makeResolveContext} is provided around the Action body at apply
 *    time. Its `get(key)` returns the already-resolved value for that key.
 *
 * Because the accessor produced at init re-reads `RuntimeContext`, yielding it
 * inside the body resolves against the apply-time context — no shared mutable
 * state, no infinite recursion (the resolve context's `get` is terminal).
 */

const base = (id: string): Omit<BaseRuntimeContext, "get" | "set"> => ({
  Type: "Action",
  id,
  env: {},
});

/**
 * Capture context — provided while an Action's init Effect runs. Records every
 * Output referenced via `yield* output` into `captures`, keyed by the Output's
 * sanitized key, and returns deferred accessors.
 */
export const makeCaptureContext = (
  captures: Record<string, Output>,
): BaseRuntimeContext => ({
  ...base("capture"),
  set: (key, output) =>
    Effect.sync(() => {
      captures[key] = output as unknown as Output;
      return key;
    }),
  // Deferred: re-read the ambient RuntimeContext at run time. At apply this is
  // the resolve context below; its `get` returns the materialized value. The
  // `RuntimeContext` requirement is erased at the Action boundary (`Run` is
  // typed `Effect<Out, any, any>`) and satisfied by the resolve context, so
  // the accessor presents as `Effect<T | undefined>`.
  get: (<T>(key: string) =>
    Effect.flatMap(RuntimeContext, (ctx) =>
      ctx.get<T>(key),
    )) as BaseRuntimeContext["get"],
});

/**
 * Resolve context — provided around an Action body at apply time. `resolved`
 * maps each captured key to its value (already evaluated against the tracker).
 */
export const makeResolveContext = (
  resolved: Record<string, unknown>,
): BaseRuntimeContext => ({
  ...base("resolve"),
  set: (key) => Effect.succeed(key),
  get: <T>(key: string) => Effect.succeed(resolved[key] as T | undefined),
});
