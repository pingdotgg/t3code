/**
 * ProviderUsageLimits — the in-memory store for account-level quota usage,
 * keyed by configured provider instance.
 *
 * Two feeds write here and neither owns the value:
 *   - turn events (`account.rate-limits.updated`), which both the Claude and
 *     Codex adapters already emit and which cost nothing;
 *   - on-demand pulls, which the refresher schedules from ambient client
 *     triggers.
 *
 * `ProviderRegistry` reads from here to decorate its snapshots, which is why
 * this service is deliberately dependency-free — it sits below the registry
 * in the layer graph and must not reach back up.
 *
 * Readings are volatile by design. They are never persisted: a usage number
 * is only interesting while it is roughly current, and the two feeds that
 * write here repopulate it within one turn or one refresh of a restart.
 *
 * @module ProviderUsageLimits
 */
import type { ProviderInstanceId, ProviderUsageLimits } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { applyUsageReading, type UsageReadingMode } from "./usageLimits.ts";

/**
 * How long a pull is suppressed after the previous one for the same
 * instance. Ambient triggers (window focus, thread switch, meter hover) fire
 * far more often than the numbers move, and the free turn-event feed covers
 * the gaps.
 */
export const USAGE_REFRESH_DEBOUNCE_MS = 60_000;

export class ProviderUsageLimitsStore extends Context.Service<
  ProviderUsageLimitsStore,
  {
    /** Latest known reading for one instance, or `undefined` if never read. */
    readonly get: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ProviderUsageLimits | undefined>;

    /**
     * Record a reading. Older readings are dropped rather than applied, so a
     * slow pull that resolves after a turn event cannot rewind the meters.
     *
     * `mode` says how much of the picture the reading covers: `partial`
     * readings (per-bucket turn events, sparse rolling updates) update only
     * the windows they name, while `full` ones replace the set. Getting this
     * wrong blanks meters the reading simply did not mention.
     *
     * Emits on `streamChanges` only when the stored value actually changed.
     */
    readonly set: (
      instanceId: ProviderInstanceId,
      usage: ProviderUsageLimits,
      mode: UsageReadingMode,
      options?: {
        /**
         * Drop the reading unless the instance's generation still matches.
         * Long-running writers (the OAuth pull) snapshot `generation` before
         * starting; a `clear` racing them bumps it, so a pull that resolves
         * after the instance was rebuilt cannot restore the old account's
         * numbers.
         */
        readonly ifGenerationIs?: number;
      },
    ) => Effect.Effect<void>;

    /**
     * The instance's current clear-generation, for writers whose reading
     * takes long enough that a rebuild can happen underneath them.
     */
    readonly generation: (instanceId: ProviderInstanceId) => Effect.Effect<number>;

    /**
     * Forget everything about an instance: its reading and its refresh
     * debounce. For instances that were removed or rebuilt with a changed
     * configuration — a rebuilt instance may point at a different account,
     * and its old numbers must not decorate the new one's snapshots.
     * Emits on `streamChanges` only when a reading was actually dropped.
     */
    readonly clear: (instanceId: ProviderInstanceId) => Effect.Effect<void>;

    /**
     * Whether an upstream pull for this instance is due, and claim the slot
     * if so. Debouncing lives here rather than in each client so three
     * clients hovering a meter at once produce one upstream call.
     */
    readonly claimRefreshSlot: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;

    /** Instance ids whose stored reading just changed. */
    readonly streamChanges: Stream.Stream<ProviderInstanceId>;

    /**
     * Acquire the change subscription eagerly, for consumers that must not
     * miss a publish between "fiber scheduled" and "fiber starts running".
     * `streamChanges` defers `PubSub.subscribe` to stream start, which is a
     * dropped-event race when the consumer is forked. See the same
     * distinction on `ProviderInstanceRegistry`.
     */
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<ProviderInstanceId>,
      never,
      Scope.Scope
    >;
  }
>()("t3/provider/ProviderUsageLimits/ProviderUsageLimitsStore") {}

export const make: Effect.Effect<ProviderUsageLimitsStore["Service"], never, Scope.Scope> =
  Effect.gen(function* () {
    // Readings, clear-generations, and refresh-debounce stamps live in one
    // Ref so every compound operation is a single atomic `Ref.modify`: a
    // guarded `set` checks the generation and writes in one step, and
    // `clear` drops the reading, bumps the generation, and frees the
    // debounce slot without a concurrent `claimRefreshSlot` interleaving
    // and re-burning the slot the clear just freed.
    const usageRef = yield* Ref.make<{
      readonly usage: ReadonlyMap<ProviderInstanceId, ProviderUsageLimits>;
      readonly generations: ReadonlyMap<ProviderInstanceId, number>;
      readonly lastRefreshAt: ReadonlyMap<ProviderInstanceId, number>;
    }>({ usage: new Map(), generations: new Map(), lastRefreshAt: new Map() });
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderInstanceId>(),
      PubSub.shutdown,
    );

    const set = (
      instanceId: ProviderInstanceId,
      usage: ProviderUsageLimits,
      mode: UsageReadingMode,
      options?: { readonly ifGenerationIs?: number },
    ) =>
      Effect.gen(function* () {
        const didWindowsChange = yield* Ref.modify(usageRef, (previous) => {
          if (
            options?.ifGenerationIs !== undefined &&
            (previous.generations.get(instanceId) ?? 0) !== options.ifGenerationIs
          ) {
            // The instance was cleared (rebuilt or removed) after this
            // reading started; its numbers may belong to the previous
            // configuration's account.
            return [false, previous] as const;
          }
          const existing = previous.usage.get(instanceId);
          const merged = applyUsageReading(existing, usage, mode);
          if (existing !== undefined && Equal.equals(existing, merged)) {
            return [false, previous] as const;
          }
          const nextUsage = new Map(previous.usage);
          nextUsage.set(instanceId, merged);
          // Announce only when the numbers moved, not when the stamp did.
          // `updatedAt` is generated server-side on every reading, so a
          // provider re-reporting identical usage would otherwise wake the
          // registry and push the entire provider array — every model,
          // capability, and skill — to every connected client, once per
          // turn, for no visible change.
          return [
            existing === undefined || !Equal.equals(existing.windows, merged.windows),
            { ...previous, usage: nextUsage },
          ] as const;
        });
        if (didWindowsChange) {
          yield* PubSub.publish(changes, instanceId);
        }
      });

    const claimRefreshSlot = (instanceId: ProviderInstanceId) =>
      Effect.clockWith((clock) =>
        clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Ref.modify(usageRef, (previous) => {
              const lastRefreshAt = previous.lastRefreshAt.get(instanceId);
              const elapsed = lastRefreshAt === undefined ? undefined : now - lastRefreshAt;
              // A negative elapsed means the wall clock moved backwards — an
              // NTP correction, a laptop waking in another timezone. Treating
              // that as "still inside the window" would wedge the meters until
              // the clock caught back up, which can be hours.
              if (elapsed !== undefined && elapsed >= 0 && elapsed < USAGE_REFRESH_DEBOUNCE_MS) {
                return [false, previous] as const;
              }
              const next = new Map(previous.lastRefreshAt);
              next.set(instanceId, now);
              return [true, { ...previous, lastRefreshAt: next }] as const;
            }),
          ),
        ),
      );

    const clear = (instanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        const hadReading = yield* Ref.modify(usageRef, (previous) => {
          // Bump the generation even when there is no reading to drop: a
          // pull started under the previous configuration may still be in
          // flight, and its guarded `set` must land on a stale generation.
          const nextGenerations = new Map(previous.generations);
          nextGenerations.set(instanceId, (previous.generations.get(instanceId) ?? 0) + 1);
          const nextLastRefreshAt = new Map(previous.lastRefreshAt);
          nextLastRefreshAt.delete(instanceId);
          if (!previous.usage.has(instanceId)) {
            return [
              false,
              { ...previous, generations: nextGenerations, lastRefreshAt: nextLastRefreshAt },
            ] as const;
          }
          const nextUsage = new Map(previous.usage);
          nextUsage.delete(instanceId);
          return [
            true,
            {
              usage: nextUsage,
              generations: nextGenerations,
              lastRefreshAt: nextLastRefreshAt,
            },
          ] as const;
        });
        if (hadReading) {
          yield* PubSub.publish(changes, instanceId);
        }
      });

    return {
      get: (instanceId) =>
        Ref.get(usageRef).pipe(Effect.map((state) => state.usage.get(instanceId))),
      set,
      clear,
      generation: (instanceId) =>
        Ref.get(usageRef).pipe(Effect.map((state) => state.generations.get(instanceId) ?? 0)),
      claimRefreshSlot,
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      subscribeChanges: PubSub.subscribe(changes),
    } satisfies ProviderUsageLimitsStore["Service"];
  });

export const layer = Layer.effect(ProviderUsageLimitsStore, make);
