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
 * - The `Provider(type)` service placed in context is the variant for the
 *   run's default mode (`AlchemyContext.dev ? "local" : "live"`), so
 *   existing lookups keep working unchanged.
 * - Both variants are additionally exposed via
 *   {@link ProviderService.modes} as lazy, memoized builders. The
 *   non-default variant (and its mode-specific dependency layers, composed
 *   inside the thunk) is only constructed when something actually demands
 *   it — e.g. deleting a `providerMode: "local"` state row during a live
 *   deploy.
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
  cls:
    | ResourceClassLike<R>
    | Platform<R, any, any, any, any>
    | { Type: R["Type"] },
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

      // The default-mode variant builds eagerly — matching today's cost
      // profile (`select` built exactly this variant) and guaranteeing the
      // registered service has real method presence (`provider.read`,
      // `provider.precreate`, ...) for Plan's capability checks.
      const defaultService = yield* cached[defaultMode];

      return Context.make(Provider(cls.Type) as any, {
        ...defaultService,
        mode: defaultMode,
        modes,
        localDataPlane: input.dataPlane,
        liveDataPlane: input.liveDataPlane,
      } satisfies ProviderService<R>);
    }),
  ) as any;
