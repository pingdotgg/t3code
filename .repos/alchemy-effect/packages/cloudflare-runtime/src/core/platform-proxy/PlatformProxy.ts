import { loadInternalWorker } from "../internal/internal-worker.ts";
/**
 * Node-side platform proxy: our reimplementation of wrangler's
 * `getPlatformProxy()` semantics on top of `cloudflare-runtime`.
 *
 * {@link open} starts a workerd instance hosting the requested bindings behind
 * the internal proxy worker and returns Node-side proxies:
 *
 * - `env` — every binding callable from Node. Plain values (`Text`, `Json`,
 *   `Data`) are materialised eagerly; everything else is a lazy stub that
 *   forwards method chains to the worker (`env.KV.get("key")`,
 *   `env.DO.get(env.DO.idFromName("a")).increment()`,
 *   `env.DB.prepare("...").all()`). `fetch()` calls on stubs (service
 *   bindings, Durable Object stubs) stream through a raw HTTP passthrough.
 * - `cf` — a frozen mock of `request.cf` (same shape miniflare falls back to).
 * - `ctx` — an `ExecutionContext` mock whose methods are no-ops (matching
 *   wrangler's `getPlatformProxy().ctx` contract, including the
 *   "Illegal invocation" guard).
 * - `caches` — a functional Cache API proxy backed by an in-memory store in
 *   the proxy worker (unlike wrangler, whose `caches` is a no-op,
 *   `put`/`match`/`delete` actually round-trip).
 *
 * The proxies themselves are built by the runtime-free client in
 * {@link ./connect.ts}; the instance exposes its `connectInfo`
 * (`{ url, token }` — two plain strings) so additional clients (worker
 * threads, child processes) can reconstruct the same proxies against the
 * same live binding state with `connect(connectInfo)`.
 *
 * Known limitations (documented deviations from wrangler's magic proxy):
 *
 * - Synchronous materialisation of intermediate values is not supported:
 *   `env.DO.idFromName("a").toString()` cannot resolve synchronously (await
 *   the id first: `(await env.DO.idFromName("a")).toString()`); awaiting an
 *   intermediate stub (e.g. a Durable Object stub) throws a descriptive
 *   error.
 * - Method results must be JSON-compatible values, bytes, dates, streams, or
 *   `DurableObjectId`s. Bindings whose clients return rich class instances
 *   (e.g. `R2Object`) are not yet supported over the proxy.
 * - `newUniqueId()` works (it round-trips as a materialised id), but
 *   `connect()` on sockets is not supported.
 * - Arguments may reference stubs of the same binding (e.g.
 *   `env.DB.batch([env.DB.prepare("...")])`); cross-binding stub arguments
 *   are rejected.
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
const ProxyWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/platform-proxy/PlatformProxy.worker",
    ),
};
import * as Text from "../bindings/Text.ts";
import type { BindingHook } from "../PluginContext.ts";
import * as Runtime from "../Runtime.ts";
import {
  ConfigError,
  type RuntimeError,
  SystemError,
} from "../RuntimeError.shared.ts";
import type {
  BindingHooks,
  DurableObjectNamespace,
  Module,
} from "../RuntimeWorker.ts";
import type { ConnectedPlatformProxy, ConnectInfo } from "./connect.ts";
import { connect } from "./connect.ts";
import { BINDING_PLATFORM_PROXY_TOKEN } from "./PlatformProxyProtocol.shared.ts";

export { ExecutionContext } from "./connect.ts";
export type {
  CacheQueryOptions,
  CacheRequestLike,
  CacheResponseLike,
  CfProperties,
  PlatformProxyCache,
  PlatformProxyCacheStorage,
} from "./connect.ts";

const DEFAULT_COMPATIBILITY_DATE = "2026-03-10";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlatformProxyOptions<B extends BindingHooks = BindingHooks> {
  /**
   * Name of the workerd service hosting the proxy (also seeds the default
   * Durable Object unique keys, so keep it stable if you persist DO state).
   * @default "platform-proxy"
   */
  readonly name?: string;
  /** @default "2026-03-10" */
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: Array<string>;
  /**
   * Bindings to expose on `env` — the same hook shapes `Runtime.start`
   * accepts (`Text.local`, `Json.local`, `KvNamespace.local`,
   * `DurableObjectNamespace.local`, `Service.local`, remote bindings, …).
   */
  readonly bindings: B;
  /**
   * Extra modules hosted alongside the proxy worker. Required when binding
   * Durable Objects: the first module must export every configured
   * `durableObjectNamespaces` class.
   */
  readonly modules?: ReadonlyArray<Module>;
  /** Durable Object namespaces implemented by `modules`. */
  readonly durableObjectNamespaces?: ReadonlyArray<DurableObjectNamespace>;
}

export interface PlatformProxyInstance<
  Env = Record<string, unknown>,
> extends ConnectedPlatformProxy<Env> {
  /** Base URL of the proxy worker (mainly for debugging). */
  readonly url: URL;
  /**
   * Everything a client needs to (re)connect to this instance —
   * `connect(connectInfo)` (see {@link ./connect.ts}) rebuilds
   * `{ env, cf, ctx, caches }` from any thread or process that can reach
   * `url`, sharing this instance's live binding state.
   */
  readonly connectInfo: ConnectInfo;
}

// ---------------------------------------------------------------------------
// Worker assembly
// ---------------------------------------------------------------------------

const makeModules = Effect.fnUntraced(function* (
  options: PlatformProxyOptions,
) {
  const proxyWorker = yield* Effect.promise(ProxyWorker.worker);
  const userModules = options.modules ?? [];
  const classNames = (options.durableObjectNamespaces ?? []).map(
    (namespace) => namespace.className,
  );
  const userEntry = userModules[0]?.name;
  if (classNames.length > 0 && userEntry === undefined) {
    return yield* new ConfigError({
      subtag: "PlatformProxyMissingModules",
      message: "Durable Object namespaces were configured without any modules.",
      hint: "Pass `modules` whose first module exports every configured Durable Object class.",
      detail: { classNames },
    });
  }
  const entry = [
    `export { default } from "./${proxyWorker.main}";`,
    ...(classNames.length > 0 && userEntry !== undefined
      ? [`export { ${classNames.join(", ")} } from "./${userEntry}";`]
      : []),
  ].join("\n");
  const modules: Array<Module> = [
    { name: "__platform_proxy_entry__.mjs", type: "ESModule", content: entry },
    ...Object.entries(proxyWorker.modules).map(([name, content]): Module => ({
      name,
      type: "ESModule",
      content,
    })),
    ...userModules,
  ];
  return modules;
});

const connectToInstance = <Env>(info: ConnectInfo) =>
  Effect.tryPromise({
    try: () => connect<Env>(info),
    catch: (cause) =>
      new SystemError({
        subtag: "PlatformProxyEnvDescriptor",
        message:
          "Failed to read the environment descriptor from the platform-proxy worker.",
        cause,
      }),
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 10 }));

type BindingRequirements<B extends BindingHooks> =
  B extends Array<never>
    ? never
    : B extends ReadonlyArray<BindingHook<infer R>>
      ? R
      : never;

/**
 * Start a workerd instance hosting `options.bindings` and return Node-side
 * proxies (`env`, `cf`, `ctx`, `caches`). The instance is torn down when the
 * surrounding `Scope` closes; use {@link ./getPlatformProxy.ts} for the
 * Promise-based convenience wrapper with an explicit `dispose()`.
 */
export const open = Effect.fn("PlatformProxy.open")(function* <
  B extends BindingHooks,
  Env = Record<string, unknown>,
>(options: PlatformProxyOptions<B>) {
  const runtime = yield* Runtime.Runtime;
  const token = crypto.randomUUID();
  const modules = yield* makeModules(options as PlatformProxyOptions);
  const url = yield* runtime.start({
    name: options.name ?? "platform-proxy",
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: options.compatibilityFlags ?? [],
    bindings: [
      Text.local(BINDING_PLATFORM_PROXY_TOKEN, token),
      ...options.bindings,
    ] as unknown as B,
    modules,
    durableObjectNamespaces: options.durableObjectNamespaces,
  });
  const connectInfo: ConnectInfo = { url: url.href, token };
  const connected = yield* connectToInstance<Env>(connectInfo);
  const instance: PlatformProxyInstance<Env> = {
    ...connected,
    url,
    connectInfo,
  };
  return instance;
}) as <B extends BindingHooks, Env = Record<string, unknown>>(
  options: PlatformProxyOptions<B>,
) => Effect.Effect<
  PlatformProxyInstance<Env>,
  RuntimeError,
  Runtime.Runtime | Scope.Scope | BindingRequirements<B>
>;
