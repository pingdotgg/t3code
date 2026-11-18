import * as Effect from "effect/Effect";
import type { LinkStoreError } from "./Links.ts";

/** Storage failures are defects: the platform turns them into a 500. */
export const dieOnStore = <A, E, R>(
  effect: Effect.Effect<A, E | LinkStoreError, R>,
): Effect.Effect<A, Exclude<E, LinkStoreError>, R> =>
  Effect.catchTag(
    effect as Effect.Effect<A, LinkStoreError, R>,
    "LinkStoreError",
    Effect.die,
  ) as never;
