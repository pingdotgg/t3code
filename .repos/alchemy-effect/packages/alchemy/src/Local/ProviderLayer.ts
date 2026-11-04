/** @effect-diagnostics anyUnknownInErrorContext:off */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AlchemyContext } from "../AlchemyContext.ts";
import type { Platform } from "../Platform.ts";
import { Provider, type ProviderService } from "../Provider.ts";
import { defaultProviderMode, type ProviderMode } from "../ProviderMode.ts";
import type { ResourceClassLike, ResourceLike } from "../Resource.ts";

/**
 * Registers a resource provider with both a **live** and a **local**
 * implementation, making provider mode a first-class, per-run *and*
 * per-resource concern:
 *
 * - The `Provider(type)` service placed in context delegates to the
 *   variant for the run's default mode (`AlchemyContext.dev ? "local" :
 *   "live"`). `findProvider` resolves the concrete variant, including its
 *   optional lifecycle methods and metadata.
 * - Both variants are exposed via {@link ProviderService.modes} as lazy,
 *   memoized builders. NEITHER is constructed at registration: a variant
 *   (and the mode-specific dependency layers composed inside its thunk) is
 *   built the first time something demands it — planning a resource of
 *   this type, deleting a state row stamped with its mode, a nuke scan. A
 *   dual provider whose resources never appear in a run costs nothing, and
 *   in dev the sidecar process a local variant spawns only starts once a
 *   resource of its type is actually planned.
 *
 * Laziness mechanics: the layer is a {@link Layer.fromBuildMemo}, so the
 * build itself is memoized by layer identity (one provider instance — and
 * one instance registry for local providers — per memo-map ancestry, i.e.
 * shared across every stack build that forks the same root, exactly like
 * ordinary layers). The build receives its `MemoMap` and `Scope`; variant
 * layers are built with `Layer.buildWithMemoMap` against that same memo
 * map and scope, which means:
 *
 * - dependency layers shared between different providers' local variants
 *   (e.g. Cloudflare's `localRuntimeServices()`) are constructed exactly
 *   once, provided the thunks share the layer *reference*;
 * - lazily-built services live until the memoized entry's scope closes
 *   (when every borrowing scope has closed), like any eagerly-built
 *   provider.
 *
 * @example
 * ```ts
 * export const WorkerProvider = () =>
 *   ProviderLayer.dual(Worker, {
 *     live: () => LiveWorkerProvider(),
 *     local: () =>
 *       LocalWorkerProvider().pipe(Layer.provide(localRuntimeServices())),
 *   });
 * ```
 */
export const dual = <
  R extends ResourceLike,
  LayerLive extends Layer.Layer<any, any, any>,
  LayerLocal extends Layer.Layer<any, any, any>,
>(
  // Only the resource type string is needed — a ResourceClass, a Platform,
  // or a bare `{ Type }` (useful when importing the class would create a
  // module cycle) all satisfy this.
  cls: ResourceClassLike<R> | Platform<R, any, any, any, any> | { Type: R["Type"] },
  input: {
    live: () => LayerLive;
    local: () => LayerLocal;
    /**
     * Data-plane override context for the local mode — the layer of cloud
     * environment services (endpoint, credentials, region) the local
     * lifecycle variant runs under (e.g. AWS's `flociServices()`). Stamped
     * onto the registered service as
     * {@link ProviderService.localDataPlane} so `Binding.Service` clients
     * can route deploy-time data-plane calls (Action bodies, plan-time
     * `execute`) to the emulator when the bound resource resolves local.
     * Pass a module-memoized layer reference.
     */
    dataPlane?: () => Layer.Layer<any, any, never>;
    /**
     * Data-plane override for **live** mode — the inverse of
     * {@link dataPlane}. Stamped as {@link ProviderService.liveDataPlane} so
     * `Alchemy.remote()` binding clients in a `dev` run provide the live
     * chain closest (ambient is the emulator). Pass a module-memoized
     * layer reference. AWS duals also get this from
     * `pinCollectionEnvironment`.
     */
    liveDataPlane?: () => Layer.Layer<any, any, never>;
  },
): Layer.Layer<
  Layer.Success<LayerLive | LayerLocal>,
  Layer.Error<LayerLive | LayerLocal>,
  Layer.Services<LayerLive | LayerLocal> | AlchemyContext
> =>
  Layer.fromBuildMemo((memoMap, scope) =>
    Effect.gen(function* () {
      // The layer-build context contains everything provided to the
      // provider stack (API clients, environments, ...). Captured here so
      // lazily-built variants see the same services as an eager build.
      const context = yield* Effect.context<never>();
      const defaultMode = yield* defaultProviderMode;

      const buildVariant = (mode: ProviderMode) =>
        Layer.buildWithMemoMap(
          (mode === "live" ? input.live() : input.local()).pipe(
            Layer.provide(Layer.succeedContext(context)),
          ) as Layer.Layer<any, any, never>,
          memoMap,
          scope,
        ).pipe(
          Effect.map((built): ProviderService<R> => ({
            ...(built.mapUnsafe.get(cls.Type) as ProviderService<R>),
            mode,
          })),
        );

      // Memoized so each variant is constructed at most once per stack
      // build, no matter how many resources/deletes resolve it.
      const cached = {
        live: yield* Effect.cached(buildVariant("live")),
        local: yield* Effect.cached(buildVariant("local")),
      };

      // Lazy accessors die on construction failure: a provider layer that
      // cannot be built is fatal (Providers.ts pipes `Layer.orDie` around
      // the eager path for the same reason).
      const modes: {
        readonly [M in ProviderMode]: Effect.Effect<ProviderService<R>>;
      } = {
        live: Effect.orDie(cached.live),
        local: Effect.orDie(cached.local),
      };

      // Every engine path resolves a concrete variant through
      // `providerForMode` and reads optional-method presence (`read`,
      // `precreate`, `tail`, `logs`), `version`, `stables` and `nuke`
      // there. The registered service therefore only needs the required
      // lifecycle methods for structural provider checks and direct
      // registration access — each forwarding to the default
      // variant, built on first call.
      const variant = modes[defaultMode];

      return Context.make(Provider(cls.Type) as any, {
        aliases: "Aliases" in cls ? cls.Aliases : undefined,
        diff: (input) =>
          Effect.flatMap(variant, (service) =>
            service.diff === undefined ? Effect.void : service.diff(input),
          ),
        reconcile: (input) => Effect.flatMap(variant, (service) => service.reconcile(input)),
        delete: (input) => Effect.flatMap(variant, (service) => service.delete(input)),
        list: (...args) => Effect.flatMap(variant, (service) => service.list(...args)),
        mode: defaultMode,
        modes,
        localDataPlane: input.dataPlane,
        liveDataPlane: input.liveDataPlane,
      } satisfies ProviderService<R>);
    }),
  ) as any;
