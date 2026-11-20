import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import type { Callbacks } from "./a.ts";
import type BEntrypoint from "./b.ts";

/**
 * Two plain async Workers that bind each other (#2672): A binds B's default
 * entrypoint, and B binds A's named `Callbacks` entrypoint. B is declared
 * first, so it defers its reference to A with `Effect.suspend`.
 */
export const B = Cloudflare.Worker("AsyncCycleB", {
  main: pathe.resolve(import.meta.dirname, "b.ts"),
  env: {
    A_CALLBACKS: Effect.map(
      Effect.suspend((): Effect.Effect<Cloudflare.Worker, never, Cloudflare.Providers> => A),
      (a) => Cloudflare.WorkerEntrypoint<Callbacks>(a, "Callbacks"),
    ),
  },
});

export const A = Cloudflare.Worker("AsyncCycleA", {
  main: pathe.resolve(import.meta.dirname, "a.ts"),
  env: {
    B: Effect.map(B, (b) => Cloudflare.WorkerEntrypoint<BEntrypoint>(b)),
  },
});

export interface AEnv extends Cloudflare.InferEnv<typeof A> {}
export interface BEnv extends Cloudflare.InferEnv<typeof B> {}
