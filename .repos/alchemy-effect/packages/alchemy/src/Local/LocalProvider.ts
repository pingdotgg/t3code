/** @effect-diagnostics anyUnknownInErrorContext:off */

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { ScopedPlanStatusSession } from "../Cli/Cli.ts";
import { isResolved, stripEffects, type Diff } from "../Diff.ts";
import type { Platform } from "../Platform.ts";
import type { ProviderService } from "../Provider.ts";
import type {
  ResourceBinding,
  ResourceClassLike,
  ResourceLike,
} from "../Resource.ts";
import { sha256 } from "../Util/sha256.ts";
import * as RpcProvider from "./RpcProvider.ts";

/**
 * # LocalProvider — the standard shape of a long-running local provider
 *
 * A local provider's "physical resource" is a running process (a spawned
 * dev server, a workerd instance) that lives in the dev sidecar and is
 * invisible to the state store: a state row can say `created` while the
 * process is dead (the previous dev session ended), and a redundant
 * reconcile can arrive while the process is healthy. Every local provider
 * therefore needs the same machinery:
 *
 * - an **instance registry** answering "is something running for this
 *   resource right now?",
 * - a **config comparison** answering "was it started with the config I'm
 *   being asked for?",
 * - restart/teardown choreography that keeps the process alive across
 *   deploys (scopes forked from the provider root scope) and kills it on
 *   change or delete.
 *
 * {@link make} generates `diff` / `reconcile` / `delete` / `list` from that
 * machinery; the provider author writes {@link LocalProviderSpec.start}
 * (how to boot one instance) and optionally
 * {@link LocalProviderSpec.resolveConfig} (what the restart-relevant config
 * is) and {@link LocalProviderSpec.stop} (cleanup that outlives instance
 * scopes).
 *
 * The produced layer wraps {@link RpcProvider.effect}, so during
 * `alchemy dev` the provider (and its registry of running processes) lives
 * in the sidecar process and survives user-code hot reloads.
 */

/** Inputs common to every generated lifecycle call. */
export interface LocalProviderInput<R extends ResourceLike> {
  id: string;
  fqn: string;
  instanceId: string;
  news: R["Props"];
  bindings: ResourceBinding<R["Binding"]>[];
}

export interface StartContext<
  R extends ResourceLike,
  Config,
> extends LocalProviderInput<R> {
  /**
   * The value produced by {@link LocalProviderSpec.resolveConfig} for this
   * reconcile — the same value whose canonical hash decided that a
   * (re)start was needed, so "what changed?" and "what starts?" can never
   * drift.
   */
  config: Config;
  session: ScopedPlanStatusSession;
  /**
   * Removes this instance from the running registry (a no-op if it has
   * already been replaced), so the next `diff` reports `update` and the
   * next reconcile boots a fresh instance. Fork this after the process's
   * exit — e.g. `child.exitCode.pipe(Effect.exit, Effect.flatMap(() =>
   * invalidate), Effect.forkScoped)` — for processes that can die on their
   * own.
   */
  invalidate: Effect.Effect<void>;
}

export interface StopContext {
  id: string;
  /**
   * Fully-qualified name (namespace path + logical id) — the key the
   * generated instance registry uses. Cross-restart state a provider keeps
   * outside instance scopes MUST be keyed by this, not `id`: two resources
   * in different namespaces can share a logical id (two `AWS.Website.*`
   * sites each declaring a `Command.Dev("Dev")`, ...).
   */
  fqn: string;
  instanceId: string;
}

export interface StablesContext<
  R extends ResourceLike,
  Config,
> extends LocalProviderInput<R> {
  config: Config;
  output: R["Attributes"] | undefined;
}

/** The default restart-relevant config when `resolveConfig` is omitted. */
export interface DefaultLocalConfig<R extends ResourceLike> {
  news: R["Props"];
  bindings: ResourceBinding<R["Binding"]>[];
}

export interface LocalProviderSpec<
  R extends ResourceLike,
  Config = DefaultLocalConfig<R>,
  StartR = never,
> {
  /**
   * Derive the restart-relevant desired config from resolved inputs.
   *
   * MUST return plain, canonically-serializable data (no closures, no
   * Effects — `Redacted` values are unwrapped by the hasher) and must be
   * cheap and side-effect-free: it runs inside `diff` on every plan. The
   * helper canonically hashes the result for the noop-vs-restart decision,
   * records it on the registry entry, and passes it to {@link start} so a
   * restart consumes exactly what was compared.
   *
   * Lifecycle-scoped services (`Stack`, `Stage`, `InstanceId`, `Artifacts`)
   * are available ambiently (e.g. for `createPhysicalName`); resolve
   * anything else in the spec effect and close over it.
   *
   * @default `{ news: stripEffects(news), bindings }`
   */
  resolveConfig?: (
    ctx: LocalProviderInput<R>,
  ) => Effect.Effect<Config, any, any>;
  /**
   * Boot one instance: acquire the long-running process in the ambient
   * `Scope` and return the resource's Attributes once it is *ready* (URL
   * extracted, first serve succeeded, ...). The scope outlives the
   * reconcile that started it — it is forked from the provider root scope
   * and closed only when the instance is restarted (config change) or
   * deleted. The returned Effect MAY complete after readiness; liveness is
   * "registry entry with an open scope", not "unfinished fiber".
   *
   * Extra requirements beyond `Scope` (`StartR`) become requirements of
   * the provider layer — they must be present at layer build so the
   * lifecycle wrapper can hand them to `start` at runtime.
   */
  start: (
    ctx: StartContext<R, Config>,
  ) => Effect.Effect<R["Attributes"], any, Scope.Scope | StartR>;
  /**
   * Extra cleanup on delete, after the instance scope has closed — for
   * state that intentionally spans restarts and therefore cannot live in
   * the instance scope (proxy servers kept for URL stability, restart
   * hooks, ...). NOT called on restarts: a restarting instance keeps that
   * shared state. Must be idempotent; also called when nothing is running
   * (e.g. cleaning up a local row during a live deploy).
   */
  stop?: (ctx: StopContext) => Effect.Effect<void, any>;
  /**
   * Attributes that remain stable across the update the generated `diff`
   * is about to report (see `Diff.stables`). Called only when the diff is
   * an `update`.
   */
  stables?: (
    ctx: StablesContext<R, Config>,
  ) => Effect.Effect<
    Extract<keyof R["Attributes"], string>[] | undefined,
    any,
    any
  >;
  precreate?: AnyReqProviderService<R>["precreate"];
  tail?: AnyReqProviderService<R>["tail"];
  logs?: AnyReqProviderService<R>["logs"];
  /**
   * Override the generated `list` (which joins every registered instance's
   * fiber to its Attributes).
   */
  list?: AnyReqProviderService<R>["list"];
}

/**
 * {@link ProviderService} with every requirement channel widened to `any` —
 * passthrough spec hooks may use lifecycle-scoped services (`Stack`,
 * `InstanceId`, ...) that the RpcProvider wrapper provides per call.
 */
type AnyReqProviderService<R extends ResourceLike> = ProviderService<
  R,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>;

interface Instance<Attributes> {
  /** Identity guard so a replaced generation's delete cannot kill its successor. */
  instanceId: string;
  /** The resolved config the running instance was started with (for diagnostics). */
  config: unknown;
  configHash: string;
  fiber: Fiber.Fiber<Attributes, any>;
  scope: Scope.Closeable;
  /** Unique per start; guards invalidate/cleanup against racing restarts. */
  token: object;
}

/**
 * Canonical, collision-free hash of a plain-data value: SHA-256 over a
 * canonical JSON serialization (sorted keys, unwrapped `Redacted`,
 * `Uint8Array` and `bigint` encodings, cycle-safe).
 *
 * We deliberately do NOT use `Hash.structure`: Effect's structural hash
 * folds sibling fields together with XOR, so the same value change
 * appearing in two sibling subtrees cancels out and the hash is unchanged
 * — exactly the shape of a Worker config that mirrors `env` values into
 * derived `bindings`. An exact canonical serialization avoids the lossy
 * fingerprint; SHA-256 keeps the retained signature a fixed 64-char digest.
 */
export const canonicalHash = (value: unknown): Effect.Effect<string> => {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (typeof input === "bigint") return `bigint:${input.toString()}`;
    if (input === null || typeof input !== "object") return input;
    if (Redacted.isRedacted(input)) {
      return { __redacted: normalize(Redacted.value(input)) };
    }
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    if (input instanceof Uint8Array) return { __bytes: Array.from(input) };
    if (Array.isArray(input)) return input.map(normalize);
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [
          key,
          normalize((input as Record<string, unknown>)[key]),
        ]),
    );
  };
  return sha256(JSON.stringify(normalize(value)));
};

/**
 * Build a local provider layer from a {@link LocalProviderSpec}.
 *
 * Generated lifecycle:
 *
 * - **diff** — `undefined` while inputs are unresolved; otherwise resolve
 *   the config and compare its canonical hash against the running
 *   instance: running + equal → `noop`, anything else → `update`. This is
 *   what encodes "the process may or may not be running" — state alone can
 *   never answer it.
 * - **reconcile** — same hash + running instance → join its fiber for the
 *   Attributes (redundant reconciles are free). Otherwise tear the old
 *   instance down and fork {@link LocalProviderSpec.start} in a fresh
 *   scope forked from the provider root scope, so the process outlives the
 *   deploy and dies with the sidecar.
 * - **delete** — tear down only if the registered instance belongs to the
 *   deleted `instanceId` (create-first replacement safety), then run
 *   {@link LocalProviderSpec.stop}. Idempotent.
 * - **list** — join every registered instance's fiber to its Attributes.
 *
 * All reconcile/delete work for one logical resource is serialized behind
 * a per-id semaphore so restarts never interleave.
 *
 * @param cls - the resource class (or Platform) this provider serves.
 * @param serverEntryUrl - sidecar entry module (see {@link RpcProvider.effect}).
 * @param spec - Effect constructing the {@link LocalProviderSpec}; resolve
 *   the services your callbacks need here and close over them.
 */
export const make = <
  R extends ResourceLike,
  Config = DefaultLocalConfig<R>,
  StartR = never,
  Req = never,
>(
  cls: ResourceClassLike<R> | Platform<R, any, any, any, any>,
  serverEntryUrl: string,
  spec: Effect.Effect<LocalProviderSpec<R, Config, StartR>, never, Req>,
) =>
  RpcProvider.effect(
    cls,
    serverEntryUrl,
    Effect.gen(function* () {
      const {
        resolveConfig = defaultResolveConfig<R, Config>,
        start,
        stop,
        stables,
        precreate,
        tail,
        logs,
        list,
      } = yield* spec;

      // The provider layer scope: in the sidecar this closes at session
      // shutdown, interrupting every registered instance and running its
      // finalizers (killing the processes).
      const rootScope = yield* Effect.scope;

      // Keyed by FQN (namespace path + logical id): a restart replaces the
      // entry, a replacement's new generation overwrites it (and the old
      // generation's delete is gated on `instanceId` so it cannot kill the
      // successor). NOT the logical id — that collides across namespaces
      // (two sites each declaring a `Command.Dev("Dev")` would evict each
      // other's running process).
      const instances = new Map<string, Instance<R["Attributes"]>>();

      // Serializes reconcile/delete per resource so a restart can never
      // interleave with another restart or a delete and leak a scope.
      const locks = new Map<string, Semaphore.Semaphore>();
      const lock = (id: string) => {
        let semaphore = locks.get(id);
        if (!semaphore) {
          semaphore = Semaphore.makeUnsafe(1);
          locks.set(id, semaphore);
        }
        return semaphore;
      };
      const withLock = <A, E, RR>(
        key: string,
        effect: Effect.Effect<A, E, RR>,
      ) => Semaphore.withPermits(lock(key), 1)(effect);

      const resolveDesired = Effect.fn(function* (
        input: LocalProviderInput<R>,
      ) {
        const config = yield* resolveConfig(input);
        const configHash = yield* canonicalHash(config);
        return { config, configHash };
      });

      const teardown = Effect.fn(function* (
        instance: Instance<R["Attributes"]>,
      ) {
        yield* Fiber.interrupt(instance.fiber);
        yield* Scope.close(instance.scope, Exit.void);
      });

      const startInstance = Effect.fn(function* (
        input: LocalProviderInput<R>,
        session: ScopedPlanStatusSession,
        config: Config,
        configHash: string,
      ) {
        const token = {};
        const invalidate = Effect.sync(() => {
          if (instances.get(input.fqn)?.token === token) {
            instances.delete(input.fqn);
          }
        });
        const scope = yield* Scope.fork(rootScope);
        const fiber = yield* start({
          ...input,
          config,
          session,
          invalidate,
        }).pipe(Effect.forkDetach, Scope.provide(scope));
        instances.set(input.fqn, {
          instanceId: input.instanceId,
          config,
          configHash,
          fiber,
          scope,
          token,
        });
        return yield* Fiber.join(fiber).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure"
              ? // A failed start must not linger as "running" — the next
                // plan should report `update` and try again.
                invalidate
              : Effect.void,
          ),
        );
      });

      const provider = {
        list:
          list ??
          (() =>
            Effect.forEach(
              Array.from(instances.values()),
              (instance) => Fiber.join(instance.fiber),
              { concurrency: "unbounded" },
            )),
        diff: Effect.fn(function* ({
          id,
          fqn,
          instanceId,
          news: rawNews,
          newBindings,
          output,
        }: {
          id: string;
          fqn: string;
          instanceId: string;
          news: any;
          newBindings: any;
          output: R["Attributes"] | undefined;
        }) {
          // Effect-valued leaves (tagged Worker classes in `env`, ...) never
          // resolve at plan time; their identity is carried by the resolved
          // binding data. Strip them so the config-based diff still runs.
          const news = stripEffects(rawNews);
          if (!isResolved(news) || !isResolved(newBindings)) return undefined;
          const input: LocalProviderInput<R> = {
            id,
            fqn,
            instanceId,
            news: news as R["Props"],
            bindings: newBindings as ResourceBinding<R["Binding"]>[],
          };
          const { config, configHash } = yield* resolveDesired(input);
          const existing = instances.get(fqn);
          if (existing && existing.configHash === configHash) {
            return { action: "noop" } satisfies Diff;
          }
          return {
            action: "update",
            stables: stables
              ? yield* stables({ ...input, config, output })
              : undefined,
          } satisfies Diff;
        }),
        reconcile: Effect.fn(function* ({
          id,
          fqn,
          instanceId,
          news,
          bindings,
          session,
        }: {
          id: string;
          fqn: string;
          instanceId: string;
          news: R["Props"];
          bindings: ResourceBinding<R["Binding"]>[];
          session: ScopedPlanStatusSession;
        }) {
          return yield* withLock(
            fqn,
            Effect.gen(function* () {
              const input: LocalProviderInput<R> = {
                id,
                fqn,
                instanceId,
                news: stripEffects(news) as R["Props"],
                bindings,
              };
              const { config, configHash } = yield* resolveDesired(input);
              const existing = instances.get(fqn);
              if (existing) {
                if (existing.configHash === configHash) {
                  yield* Effect.log(
                    `[${id}] No changes, using existing instance`,
                  );
                  // Adopt the newest instanceId so a later replacement's
                  // old-generation delete cannot tear this instance down.
                  existing.instanceId = instanceId;
                  return yield* Fiber.join(existing.fiber);
                }
                yield* Effect.log(
                  `[${id}] Changes detected, restarting instance`,
                );
                yield* teardown(existing);
                instances.delete(fqn);
              }
              return yield* startInstance(input, session, config, configHash);
            }),
          );
        }),
        delete: Effect.fn(function* ({
          id,
          fqn,
          instanceId,
        }: {
          id: string;
          fqn: string;
          instanceId: string;
        }) {
          yield* withLock(
            fqn,
            Effect.gen(function* () {
              const existing = instances.get(fqn);
              if (existing && existing.instanceId !== instanceId) {
                // A replacement's new generation is registered under this
                // logical id — the old generation's delete must not touch
                // it (nor the cross-restart state `stop` would clean up).
                return;
              }
              if (existing) {
                yield* teardown(existing);
                instances.delete(fqn);
              }
              // Runs even when nothing is registered: cross-restart state
              // (proxies, restart hooks) and out-of-session cleanup (e.g.
              // deleting a local row during a live deploy) still need it.
              if (stop) {
                yield* stop({ id, fqn, instanceId });
              }
            }),
          );
        }),
        ...(precreate ? { precreate } : {}),
        ...(tail ? { tail } : {}),
        ...(logs ? { logs } : {}),
      };

      return provider as any;
      // `StartR` (start's requirements beyond Scope) is surfaced as a layer
      // requirement: the RpcProvider wrapper captures the layer-build
      // context and provides it to every lifecycle call, so services the
      // layer demanded at build are available to `start` at runtime.
    }) as Effect.Effect<
      ProviderService<R>,
      never,
      Req | Exclude<StartR, Scope.Scope>
    >,
  );

const defaultResolveConfig = <R extends ResourceLike, Config>(
  input: LocalProviderInput<R>,
): Effect.Effect<Config, any> =>
  Effect.succeed({
    news: stripEffects(input.news),
    bindings: input.bindings,
  } as Config);
