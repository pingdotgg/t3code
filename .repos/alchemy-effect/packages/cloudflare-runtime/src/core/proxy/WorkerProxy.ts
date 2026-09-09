import { loadInternalWorker } from "../internal/internal-worker.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as NodeNet from "node:net";
const ProxyWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/proxy/WorkerProxy.worker",
    ),
};
import * as Internet from "../globals/Internet.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Port from "../internal/Port.ts";
import type { RuntimeError } from "../RuntimeError.shared.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import * as Workerd from "../workerd/Workerd.ts";

export class WorkerProxy extends Context.Service<
  WorkerProxy,
  {
    readonly serve: (
      options?: ServeOptions,
    ) => Effect.Effect<WorkerProxyInstance, RuntimeError, Scope.Scope>;
  }
>()("cloudflare-runtime/proxy/WorkerProxy") {}

export interface ServeOptions {
  /**
   * The port to serve the proxy on. If not provided, a random port will be chosen.
   * @default 0
   */
  readonly port?: number;
  /**
   * Whether to throw an error if the port is not available.
   * @default false
   */
  readonly strictPort?: boolean;
  /**
   * The host to serve the proxy on.
   * @default "localhost"
   */
  readonly host?: string;
}

/** Maximum number of port-collision retries for a single `serve` call (each attempt spawns a workerd process). */
const MAX_SERVE_ATTEMPTS = 8;

export interface WorkerProxyInstance {
  readonly url: URL;
  readonly set: (upstream: URL) => Effect.Effect<void, SystemError>;
  readonly unset: () => Effect.Effect<void, SystemError>;
}

export const WorkerProxyLive = Layer.effect(
  WorkerProxy,
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const internet = yield* Internet.Internet;
    const ports = yield* Port.make({ cache: true });

    // `localhost` resolves to BOTH 127.0.0.1 and ::1, and browsers prefer
    // IPv6. A proxy bound only on 127.0.0.1 leaves `[::1]:port` free for any
    // other process (e.g. a framework dev server hunting from its default
    // port) to claim — after which `http://localhost:port` silently serves
    // that other process instead of (or interleaved with) the proxy. When
    // serving on the loopback default, bind an additional `[::1]` socket so
    // the proxy owns its port on both address families. Machines without an
    // IPv6 loopback are detected once and skip the extra socket.
    const ipv6Loopback = yield* Effect.callback<boolean>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", () => resume(Effect.succeed(false)));
      server.listen({ port: 0, host: "::1", exclusive: true }, () =>
        server.close(() => resume(Effect.succeed(true))),
      );
      return Effect.sync(() => server.close());
    });

    const normalizeOptions = Effect.fnUntraced(function* (
      options: ServeOptions,
    ) {
      const host = options.host ?? "127.0.0.1";
      const strictPort = options.strictPort ?? false;
      return {
        port:
          options.port && options.strictPort
            ? yield* ports.check(options.port)
            : options.port
              ? // A configured (non-strict) port: a dev-session restart races
                // the previous session's teardown, and an instant fallback
                // would silently shift every configured port in the stack up
                // by one in nondeterministic order — serving the wrong app on
                // the ports the user knows. Wait out the teardown before
                // falling back to the hunt (the caller warns on drift).
                yield* ports
                  .waitFor(options.port)
                  .pipe(Effect.catch(() => ports.find(options.port!)))
              : yield* ports.find(0),
        host,
        strictPort,
        // Dual-bind only for the loopback default — an explicit host is
        // served verbatim.
        ipv6: options.host === undefined && ipv6Loopback,
        token: crypto.randomUUID(),
      };
    });
    type ResolvedOptions = Effect.Success<ReturnType<typeof normalizeOptions>>;

    const modules = yield* Effect.map(
      Effect.promise(ProxyWorker.worker),
      formatInternalWorkerModules,
    );

    const serve = ({ host, port, token, ipv6 }: ResolvedOptions) =>
      workerd
        .serve({
          sockets: [
            {
              name: "http",
              address: `${host}:${port}`,
              service: { name: "proxy:worker" },
            },
            // The IPv6 half of `localhost` (see `ipv6Loopback` above). The
            // port was probed across both families by `ports.find`/`check`,
            // so this bind only fails on a genuine race — handled by
            // `serveWithRetry` like any other collision.
            ...(ipv6
              ? [
                  {
                    name: "http-ipv6",
                    address: `[::1]:${port}`,
                    service: { name: "proxy:worker" },
                  },
                ]
              : []),
          ],
          services: [
            {
              name: "proxy:worker",
              worker: {
                compatibilityDate: "2026-03-10",
                modules,
                bindings: [
                  {
                    name: "PROXY",
                    durableObjectNamespace: { className: "WorkerProxy" },
                  },
                  { name: "PROXY_TOKEN", text: token },
                ],
                durableObjectNamespaces: [
                  {
                    className: "WorkerProxy",
                    ephemeralLocal: WorkerdConfig.kVoid,
                    preventEviction: true,
                  },
                ],
              },
            },
            internet,
          ],
        })
        .pipe(
          Effect.map(
            (ports) =>
              new URL(
                `http://${host === "127.0.0.1" ? "localhost" : host}:${ports.http}`,
              ),
          ),
        );

    // The `findAvailablePort` function is lower overhead than `serve`, but it's best-effort.
    // If there is a race condition, we may not be able to bind to the port, so we retry.
    // The retry MUST be bounded: every attempt spawns a fresh workerd process, and on
    // Windows `isAddressInUseError` matches any `std::terminate` start crash — an
    // environmental failure (e.g. socket-buffer exhaustion on CI) would otherwise turn
    // this into an unbounded workerd-spawn storm that amplifies the exhaustion.
    const serveWithRetry = (
      options: Parameters<typeof serve>[0],
      attempt = 1,
    ): ReturnType<typeof serve> =>
      serve(options).pipe(
        Effect.catchIf(
          (error) =>
            Workerd.isAddressInUseError(error) &&
            !options.strictPort &&
            options.port <= Port.MAX_PORT &&
            attempt < MAX_SERVE_ATTEMPTS,
          () =>
            Effect.flatMap(ports.find(options.port + 1), (port) =>
              serveWithRetry({ ...options, port }, attempt + 1),
            ),
        ),
      );

    return WorkerProxy.of({
      serve: Effect.fn("WorkerProxy.serve")(function* (options = {}) {
        const resolved = yield* normalizeOptions(options);
        const url = yield* serveWithRetry(resolved);
        if (
          options.port !== undefined &&
          options.port !== 0 &&
          Number(url.port) !== options.port
        ) {
          yield* Effect.logWarning(
            `Port ${options.port} is in use by another process; serving on ${url.port} instead. Stop the other process, pick a different port, or set \`strictPort: true\` to fail instead.`,
          );
        }
        return {
          url,
          set: Effect.fn("WorkerProxyInstance.set")(function* (upstream) {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/cdn-cgi/proxy/controller", url), {
                method: "PUT",
                headers: {
                  "Content-Type": "text/plain",
                  Authorization: `Bearer ${resolved.token}`,
                },
                body: upstream.toString(),
              }),
            );
            if (!response.ok) {
              return yield* new SystemError({
                subtag: "WorkerProxy.set",
                message: "Failed to set upstream",
                cause: response,
              });
            }
          }),
          unset: Effect.fn("WorkerProxyInstance.unset")(function* () {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/cdn-cgi/proxy/controller", url), {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${resolved.token}`,
                },
              }),
            );
            if (!response.ok) {
              return yield* new SystemError({
                subtag: "WorkerProxy.unset",
                message: "Failed to unset upstream",
                cause: response,
              });
            }
          }),
        };
      }),
    });
  }),
);
