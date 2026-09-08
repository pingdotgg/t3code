import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AlchemyContext } from "./AlchemyContext.ts";

/**
 * The mode a resource's provider operates in.
 *
 * - `"live"`  — the provider converges real cloud state.
 * - `"local"` — the provider emulates the resource on the developer's
 *   machine (`alchemy dev`), typically as a long-running process managed
 *   by the dev sidecar.
 *
 * The mode a resource was last reconciled with is persisted on its state
 * row (`providerMode`). Switching a resource between modes is planned as a
 * **replacement**: the new instance is created with the new mode's provider
 * and the old instance is deleted with the provider of the mode that
 * created it.
 */
export type ProviderMode = "live" | "local";

/**
 * ProviderModePolicy opts resources OUT of local emulation: when `true`,
 * resources registered while it is in context resolve the **live**
 * provider even during `alchemy dev`.
 *
 * Apply it with the {@link remote} combinator. During `alchemy deploy`
 * everything is live anyway, so the policy only has an effect in dev.
 *
 * Tri-state `Context.Reference`: `undefined` (the default — no explicit
 * decoration, inherit/run default), `true` (`remote()`), `false`
 * (`remote(false)` — explicitly follow the run default again). The unset vs
 * explicit distinction is load-bearing for conflict detection at
 * registration (see `Resource.ts`).
 */
export const ProviderModePolicy = Context.Reference<boolean | undefined>(
  "ProviderModePolicy",
  { defaultValue: () => undefined },
);

/**
 * The same resource (identified by FQN) was registered (`yield*`ed) from two
 * places whose ambient {@link ProviderModePolicy} disagree — e.g. once inside
 * `remote()` and once without it. Context-based decoration cannot decide which
 * one wins, so the engine fails loudly instead of silently picking one.
 *
 * Fix: register the resource once and close over the returned value, or make
 * both registration sites agree.
 */
export class ConflictingProviderModeError extends Data.TaggedError(
  "ConflictingProviderModeError",
)<{
  message: string;
  fqn: string;
  /** The mode captured at the first registration site (undefined = default). */
  existingMode: ProviderMode | undefined;
  /** The explicit mode at the conflicting registration site. */
  conflictingMode: ProviderMode | undefined;
}> {}

/**
 * Prefix marking a locally-emulated resource's physical identity. Local
 * providers fabricate ids/names with this prefix (`dev:<uuid>` queue and
 * namespace ids, `dev:`-prefixed bucket names, ...) so a resource's
 * persisted attributes reveal which runtime hosts it even without the
 * `providerMode` stamp.
 */
export const LOCAL_ID_PREFIX = "dev:";

/**
 * Does a persisted attributes value carry a local identity marker — any
 * string value (at any depth) with the {@link LOCAL_ID_PREFIX}? Persisted
 * attrs are plain JSON (state commits strip unresolved values), so a
 * structural scan is safe.
 */
export const hasLocalIdentity = (value: unknown): boolean => {
  if (typeof value === "string") return value.startsWith(LOCAL_ID_PREFIX);
  if (Array.isArray(value)) return value.some(hasLocalIdentity);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasLocalIdentity);
  }
  return false;
};

/**
 * The mode a persisted state row was actually reconciled with: its stamped
 * `providerMode`, or — for legacy rows written before stamping existed —
 * `"local"` when the persisted attributes carry a {@link LOCAL_ID_PREFIX}
 * identity marker, `"live"` otherwise.
 *
 * An unstamped row without a marker predates provider modes or was written
 * by a mode-agnostic provider — in both cases the write acted on the REAL
 * cloud, so the row's physical resource is `"live"`. Assuming the current
 * run's mode instead silently adopts a deployed cloud resource as a local
 * instance during `alchemy dev`: the row noops (or restarts locally over
 * the live attrs), gets re-stamped `"local"`, and the live resource becomes
 * untracked — it is never deleted by a later destroy or replacement, and
 * its deployed URL keeps serving.
 *
 * An unstamped row WITH a marker (e.g. a queue with a `dev:<uuid>` id
 * written by `alchemy dev` on a pre-stamping version) is the mirror case:
 * assuming `"live"` hands the `dev:` identity to the live provider, which
 * sends it to the real cloud API (Cloudflare rejects it as a malformed
 * parameter, permanently wedging the destroy). The marker proves the row
 * was reconciled locally, so it is handled as `"local"`.
 *
 * For mode-agnostic providers the returned mode is harmless either way:
 * `providerForMode` ignores the mode when the provider has a single
 * implementation.
 */
export const stampedMode = (row: {
  readonly providerMode?: ProviderMode | undefined;
  readonly attr?: unknown;
}): ProviderMode =>
  row.providerMode ?? (hasLocalIdentity(row.attr) ? "local" : "live");

/**
 * Run the wrapped resources **remotely (against the real cloud) even during
 * `alchemy dev`** — the opt-out from local emulation. During `alchemy deploy`
 * this is a no-op (everything is remote).
 *
 * Captured at registration time like `adopt()` / `retain()`, so it can be
 * applied to a single resource or a whole scope:
 *
 * ```ts
 * // This queue talks to real Cloudflare even in dev
 * const queue = yield* Queue("Jobs", {}).pipe(Alchemy.remote());
 *
 * // Everything in this scope runs live in dev
 * yield* Effect.gen(function* () {
 *   const queue = yield* Queue("Jobs", {});
 *   const consumer = yield* Consumer("JobsConsumer", { queue });
 * }).pipe(Alchemy.remote());
 * ```
 *
 * `remote(false)` (or an `Effect<boolean>` resolving to false) removes the
 * pin — the resource follows the run default again.
 *
 * Providers with a single implementation are mode-agnostic and already run
 * live in dev; `remote()` on them is a no-op.
 */
export const remote: {
  // Identity-typed so branded effect interfaces (e.g. a Worker-only
  // binding's `BindingEffect`) survive the pipe with their brand intact.
  (
    enabled?: boolean,
  ): <Eff extends Effect.Effect<any, any, any>>(effect: Eff) => Eff;
  <R1 = never>(
    enabled: Effect.Effect<boolean, never, R1>,
  ): <A, E, R2 = never>(
    effect: Effect.Effect<A, E, R2>,
  ) => Effect.Effect<A, E, R1 | R2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any> = true) =>
  (eff: Effect.Effect<any, any, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(ProviderModePolicy, enabled)
        : Effect.provideServiceEffect(ProviderModePolicy, enabled),
    )) as any;

/**
 * Resolve the run-level default provider mode:
 *
 * 1. An ambient {@link ProviderModePolicy} of `true` (e.g. `remote()` wrapped
 *    around a whole program) forces `"live"`.
 * 2. Otherwise `AlchemyContext.dev` decides: `dev: true` → `"local"`.
 * 3. Without an AlchemyContext (bare engine tests), default to `"live"`.
 */
export const defaultProviderMode: Effect.Effect<ProviderMode> = Effect.gen(
  function* () {
    if (yield* ProviderModePolicy) return "live" as const;
    const ctx = yield* Effect.serviceOption(AlchemyContext);
    return Option.match(ctx, {
      onNone: () => "live" as const,
      onSome: (c) => (c.dev ? ("local" as const) : ("live" as const)),
    });
  },
);
