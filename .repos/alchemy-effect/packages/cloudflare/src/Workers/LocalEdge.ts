import {
  Runtime,
  type RuntimeError,
  type RuntimeServices,
} from "@alchemy.run/cloudflare-runtime/core";
import { Service } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { DEFAULT_COMPATIBILITY_DATE } from "@alchemy.run/cloudflare-runtime/core/internal/constants";
import * as WorkerProxy from "@alchemy.run/cloudflare-runtime/core/proxy/WorkerProxy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { routeMatcherSource, routePatternHost, routePatternMatchesHost } from "./RoutePattern.ts";

/**
 * A zone route as the local edge sees it: a Cloudflare route pattern and
 * the script it runs, or `undefined` for an opt-out route (Workers
 * disabled for matching requests).
 */
export interface LocalEdgeRoute {
  readonly pattern: string;
  readonly script: string | undefined;
}

/** A custom-domain Worker, served on its own stable dev proxy. */
export interface LocalEdgeDomain {
  readonly script: string;
  readonly proxy: WorkerProxy.WorkerProxyInstance;
  /** The Worker's current workerd address. */
  readonly upstream: URL;
}

/**
 * Local emulation of Cloudflare's zone routing — the control-plane rules
 * that send `api.example.com/users/*` to one Worker and
 * `api.example.com/orders/*` to another with no gateway Worker in the
 * request path.
 *
 * Every route registered by a local `Worker` (`routes` prop) or
 * `Workers.Route` resource is matched by one router workerd, which forwards
 * the request over a service binding to the matched script — the target
 * sees the original `request.url`, like on Cloudflare. Hostnames map to
 * local listeners by port:
 *
 * - Each literal hostname named by a route pattern gets its own listener
 *   on a free port, logged as `[edge] <host> → <url>`.
 * - A Worker whose custom `domain` is a routed hostname serves it on its
 *   own dev URL too: its proxy points at the router, with the Worker as the
 *   fallback for unmatched paths (routes take precedence over custom
 *   domains on Cloudflare). Without matching routes the proxy points
 *   straight at the Worker, with no extra hop.
 */
export class LocalEdge extends Context.Service<
  LocalEdge,
  {
    /** Replace the routes owned by `owner` (a Worker or Route identity). */
    readonly setRoutes: (
      owner: string,
      routes: ReadonlyArray<LocalEdgeRoute>,
    ) => Effect.Effect<void, RuntimeError>;
    readonly removeRoutes: (owner: string) => Effect.Effect<void, RuntimeError>;
    /**
     * Expose a custom-domain Worker. Replaces the Worker's own
     * `proxy.set(upstream)`: the edge points the proxy at the Worker or at
     * the router.
     */
    readonly serveDomain: (
      host: string,
      domain: LocalEdgeDomain,
    ) => Effect.Effect<void, RuntimeError>;
    readonly removeDomain: (host: string, script: string) => Effect.Effect<void, RuntimeError>;
    /** The edge listener serving a routed hostname, if any. */
    readonly url: (host: string) => Effect.Effect<URL | undefined>;
  }
>()("alchemy/cloudflare/LocalEdge") {}

interface RouterConfig {
  /** Listener port → the hostname it serves. */
  readonly ports: Record<string, string>;
  readonly routes: ReadonlyArray<{ pattern: string; binding: string | null }>;
  /** Hostname → the binding of its custom-domain Worker. */
  readonly domains: Record<string, string>;
}

/**
 * How long a routed request waits for its target Worker to register with
 * the dev registry — the same budget a Worker's own dev proxy parks
 * requests for while it starts.
 */
const TARGET_WAIT_MS = 120_000;

const routerScript = (config: RouterConfig) => `
const CONFIG = ${JSON.stringify(config)};
const HOSTS = Object.values(CONFIG.ports);
${routeMatcherSource()}
// The registry proxy answers 503 with this message while the target
// script has not registered yet (it is still starting). Wait for it, like
// a request to the Worker's own dev URL does.
const NOT_REGISTERED = /^Worker ".*" not found. Make sure the worker is running locally.$/;
async function forward(target, request) {
  const deadline = Date.now() + ${TARGET_WAIT_MS};
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    const response = await target.fetch(request.clone());
    if (
      response.status !== 503 ||
      Date.now() > deadline ||
      !NOT_REGISTERED.test(await response.clone().text())
    ) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = CONFIG.ports[url.port] ?? (HOSTS.length === 1 ? HOSTS[0] : url.hostname);
    const route = matchRoute(CONFIG.routes, host, url.pathname);
    const binding = route?.binding ?? CONFIG.domains[host];
    if (binding) return forward(env[binding], request);
    const message = route
      ? "Workers are disabled for " + host + url.pathname + " by route '" + route.pattern + "', and alchemy dev has no origin to fall back to."
      : "No Worker route matches " + host + url.pathname + ". Routes: " + CONFIG.routes.map((r) => r.pattern).join(", ");
    return new Response(message, { status: 404, headers: { "content-type": "text/plain" } });
  },
};
`;

export const LocalEdgeLive = Layer.effect(
  LocalEdge,
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const workerProxy = yield* WorkerProxy.WorkerProxy;
    const context = yield* Effect.context<RuntimeServices>();
    const rootScope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    // Unique per edge: the router registers in the machine-wide dev registry.
    const routerName = `alchemy-edge-${crypto.randomUUID().slice(0, 8)}`;

    const routes = new Map<string, ReadonlyArray<LocalEdgeRoute>>();
    const domains = new Map<string, LocalEdgeDomain>();
    const listeners = new Map<
      string,
      { instance: WorkerProxy.WorkerProxyInstance; scope: Scope.Closeable }
    >();
    let router: { url: URL; scope: Scope.Closeable; key: string } | undefined;
    // Where each domain proxy currently points, so a rebuild only touches
    // proxies whose target moved.
    const domainTargets = new Map<string, string>();

    const syncListeners = Effect.fnUntraced(function* (hosts: ReadonlySet<string>) {
      for (const [host, listener] of listeners) {
        if (!hosts.has(host)) {
          listeners.delete(host);
          yield* Scope.close(listener.scope, Exit.void);
        }
      }
      for (const host of hosts) {
        if (listeners.has(host)) continue;
        const scope = yield* Scope.fork(rootScope);
        const instance = yield* workerProxy.serve().pipe(Scope.provide(scope));
        listeners.set(host, { instance, scope });
        yield* Effect.log(`[edge] ${host} → ${instance.url.origin}`);
      }
    });

    const startRouter = Effect.fnUntraced(function* (scripts: string[], config: RouterConfig) {
      const scope = yield* Scope.fork(rootScope);
      const url = yield* runtime
        .start({
          name: routerName,
          compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
          compatibilityFlags: [],
          bindings: scripts.map((scriptName, index) =>
            Service.local({ binding: `WORKER_${index}`, scriptName }),
          ),
          modules: [{ name: "router.js", type: "ESModule", content: routerScript(config) }],
        })
        .pipe(
          Scope.provide(scope),
          Effect.provideContext(context),
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? Scope.close(scope, exit) : Effect.void,
          ),
        );
      return { url, scope };
    });

    const rebuild = Effect.gen(function* () {
      const patterns = [...routes.values()].flat();
      yield* syncListeners(
        new Set(patterns.flatMap((route) => routePatternHost(route.pattern) ?? [])),
      );
      // Domains with at least one matching route sit behind the router.
      const routedDomains = [...domains].filter(([host]) =>
        patterns.some((route) => routePatternMatchesHost(route.pattern, host)),
      );

      const previous = router;
      if (patterns.length === 0) {
        router = undefined;
      } else {
        const scripts = [
          ...new Set([
            ...patterns.flatMap((route) => route.script ?? []),
            ...routedDomains.map(([, domain]) => domain.script),
          ]),
        ].sort();
        const binding = (script: string) => `WORKER_${scripts.indexOf(script)}`;
        const config: RouterConfig = {
          ports: Object.fromEntries([
            ...[...listeners].map(([host, l]) => [l.instance.url.port, host]),
            ...routedDomains.map(([host, d]) => [d.proxy.url.port, host]),
          ]),
          routes: patterns.map((route) => ({
            pattern: route.pattern,
            binding: route.script ? binding(route.script) : null,
          })),
          domains: Object.fromEntries(routedDomains.map(([host, d]) => [host, binding(d.script)])),
        };
        const key = JSON.stringify(config);
        if (previous?.key !== key) {
          router = { ...(yield* startRouter(scripts, config)), key };
        }
      }

      // Make-before-break: point everything at the new router before the
      // previous one closes.
      if (router) {
        const url = router.url;
        yield* Effect.forEach(listeners.values(), (l) => l.instance.set(url), { discard: true });
      }
      for (const [host, domain] of domains) {
        const routed = router && routedDomains.some(([routedHost]) => routedHost === host);
        const target = routed ? router!.url : domain.upstream;
        if (domainTargets.get(host) !== target.href) {
          domainTargets.set(host, target.href);
          yield* domain.proxy.set(target);
        }
      }
      if (previous && previous !== router) {
        yield* Scope.close(previous.scope, Exit.void);
      }
    });

    const update = (mutate: () => void) =>
      Effect.sync(mutate).pipe(Effect.andThen(rebuild), lock.withPermits(1));

    return LocalEdge.of({
      setRoutes: (owner, next) =>
        Effect.suspend(() =>
          JSON.stringify(routes.get(owner) ?? []) === JSON.stringify(next)
            ? Effect.void
            : update(() => (next.length ? routes.set(owner, next) : routes.delete(owner))),
        ),
      removeRoutes: (owner) =>
        Effect.suspend(() =>
          routes.has(owner) ? update(() => routes.delete(owner)) : Effect.void,
        ),
      serveDomain: (host, domain) =>
        update(() => {
          const key = host.toLowerCase();
          domains.set(key, domain);
          // The Worker just (re)served: always re-point its proxy.
          domainTargets.delete(key);
        }),
      removeDomain: (host, script) =>
        Effect.suspend(() => {
          const key = host.toLowerCase();
          return domains.get(key)?.script === script
            ? update(() => {
                domains.delete(key);
                domainTargets.delete(key);
              })
            : Effect.void;
        }),
      url: (host) => Effect.sync(() => listeners.get(host.toLowerCase())?.instance.url),
    });
  }),
);
