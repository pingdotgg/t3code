/**
 * Promise-based convenience wrapper around {@link ./PlatformProxy.ts} for
 * framework consumption (SvelteKit `platform` emulation, OpenNext
 * `initOpenNextCloudflareForDev`, Astro `platformProxy`, …): no Effect
 * knowledge required, one call returns `{ env, cf, ctx, caches, dispose }`.
 *
 * The wrapper builds a local-only runtime layer internally (local bindings,
 * dev registry, loopback — no Cloudflare API access). To use remote bindings
 * or a custom layer stack, use the Effect API (`PlatformProxy.open`) with
 * `RuntimeServices.layerRuntime` instead.
 */
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Docker from "../Docker.ts";
import * as Globals from "../globals/Globals.ts";
import * as Internet from "../globals/Internet.ts";
import * as Storage from "../globals/Storage.ts";
import * as Paths from "../internal/Paths.ts";
import * as Registry from "../registry/Registry.ts";
import * as RegistryProxy from "../registry/RegistryProxy.ts";
import * as Runtime from "../Runtime.ts";
import * as RuntimeServices from "../RuntimeServices.ts";
import type { BindingHooks } from "../RuntimeWorker.ts";
import * as Workerd from "../workerd/Workerd.ts";
import { PlatformServices } from "../../Platform.ts";
import type {
  PlatformProxyInstance,
  PlatformProxyOptions,
} from "./PlatformProxy.ts";
import { open } from "./PlatformProxy.ts";

export interface GetPlatformProxyOptions<
  B extends BindingHooks = BindingHooks,
> extends PlatformProxyOptions<B> {
  /**
   * Where to persist binding data (Durable Object storage). By default
   * nothing is persisted: state lives in a temporary directory removed on
   * `dispose()`. Pass `{ directory }` to keep state across runs.
   * Note: the local KV emulation is in-memory either way.
   * Ignored when {@link services} is provided — the owning runtime governs
   * storage.
   */
  readonly persist?: { readonly directory: string } | false;
  /**
   * A pre-built `RuntimeServices` context to host the proxy in, instead of
   * the internal local-only layer. Embedders that already run a
   * cloudflare-runtime stack (alchemy's dev sidecar hands one to framework
   * source modules as `DevContext.runtimeContext`) pass it here so the proxy
   * shares that stack — including remote-bindings support, which the
   * internal layer deliberately omits (it is credential-free). `dispose()`
   * then tears down only this proxy instance, never the shared services.
   */
  readonly services?: Context.Context<RuntimeServices.RuntimeServices>;
}

export interface PlatformProxy<
  Env = Record<string, unknown>,
> extends PlatformProxyInstance<Env> {
  /** Tear down the workerd instance. Safe to call multiple times. */
  readonly dispose: () => Promise<void>;
}

const makeLayer = (persist: GetPlatformProxyOptions["persist"]) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(RuntimeServices.layerLocalBindings()),
    Layer.provideMerge(RuntimeServices.layerProxy()),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(RuntimeServices.layerLoopback()),
    Layer.provide(
      persist
        ? Storage.layerDisk(persist.directory)
        : Storage.layerTemp({ prefix: "platform-proxy" }),
    ),
    Layer.provide(Internet.InternetLive),
    Layer.provideMerge(RegistryProxy.RegistryProxyLive),
    Layer.provideMerge(Registry.RegistryLive),
    Layer.provideMerge(Paths.PathsLive),
    Layer.provideMerge(Docker.DockerLive),
    Layer.provide(Workerd.WorkerdLive),
    Layer.provideMerge(Layer.mergeAll(PlatformServices, FetchHttpClient.layer)),
  );

/**
 * Start a workerd instance hosting the requested bindings and return
 * Node-side proxies to them — our equivalent of wrangler's
 * `getPlatformProxy()`, reimplemented on `cloudflare-runtime` (no wrangler,
 * no wrangler.json: bindings are declared in memory).
 *
 * ```ts
 * const proxy = await getPlatformProxy<{ KV: KVNamespace }>({
 *   bindings: [KvNamespace.local("KV"), Text.local("API_HOST", "example.com")],
 * });
 * await proxy.env.KV.put("key", "value");
 * // ...
 * await proxy.dispose();
 * ```
 */
export const getPlatformProxy = async <
  Env = Record<string, unknown>,
  B extends BindingHooks = BindingHooks,
>(
  options: GetPlatformProxyOptions<B>,
): Promise<PlatformProxy<Env>> => {
  const scope = Scope.makeUnsafe();
  try {
    // The layer must be BUILT INTO the dispose scope, not provided around
    // `open` — `Effect.provide` closes the layer's build scope as soon as
    // the effect resolves, tearing down the scoped services (temp storage
    // directory, loopback server, registry watcher) out from under the
    // still-running workerd instance. The first binding call then fails
    // with an opaque "Network connection lost".
    //
    // The binding hooks' requirements are dynamic here (`B` is unbounded), so
    // the local-only layer cannot discharge them statically. A hook that
    // needs a service the local layer does not provide (e.g. remote bindings
    // without credentials) fails at startup with a descriptive defect.
    // A caller-provided `services` context short-circuits the internal layer
    // entirely: the proxy is hosted in the embedder's runtime stack, and the
    // dispose scope owns only what `open` itself acquires.
    // The internal layer's context is a superset of `RuntimeServices`
    // (platform services, HttpClient); narrow both arms to the services
    // `open` consumes.
    const context: Context.Context<RuntimeServices.RuntimeServices> =
      options.services ??
      ((await Effect.runPromise(
        Layer.build(makeLayer(options.persist)).pipe(Scope.provide(scope)),
      )) as Context.Context<RuntimeServices.RuntimeServices>);
    const effect = open<B, Env>(options).pipe(
      Effect.provideContext(context),
      Scope.provide(scope),
    ) as Effect.Effect<PlatformProxyInstance<Env>>;
    const instance = await Effect.runPromise(effect);
    let disposed: Promise<void> | undefined;
    return {
      ...instance,
      dispose: () => (disposed ??= closeScope(scope)),
    };
  } catch (error) {
    await closeScope(scope);
    throw error;
  }
};

const closeScope = async (scope: Scope.Closeable): Promise<void> => {
  await Effect.runPromiseExit(
    Scope.closeUnsafe(scope, Exit.void) ?? Effect.void,
  );
};
