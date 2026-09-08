// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Next.js dev v2 — real `next dev` (Turbopack HMR) with Cloudflare bindings,
 * wrangler-free.
 *
 * {@link start} runs the documented custom-server API programmatically
 * (`next({ dev: true, dir, hostname, port })` + `prepare()` +
 * `getRequestHandler()` attached to an http.Server we own), so the caller
 * controls the port/URL and shutdown is a clean `app.close()` — no CLI fork,
 * no signal handlers, no `process.exit` choreography.
 *
 * Before the dev server starts, a `cloudflare-runtime` platform proxy
 * ({@link PlatformProxy.open}) is opened with the worker's binding hooks and
 * the resulting `{ env, cf, ctx }` is planted on
 * `globalThis[Symbol.for("__cloudflare-context__")]` — the exact contract
 * `@opennextjs/cloudflare`'s `getCloudflareContext()` reads (see upstream
 * `src/api/cloudflare-context.ts`). `vm.runInContext` is additionally patched
 * so Next's edge-runtime sandbox (middleware, edge routes) sees the same
 * context, mirroring OpenNext's `monkeyPatchVmModuleEdgeContext`. App code
 * therefore works without calling `initOpenNextCloudflareForDev()` and
 * without wrangler.
 *
 * Fidelity notes (documented in the package README): app code runs in Node
 * (or Next's edge-runtime VM), not workerd — bindings round-trip through the
 * proxy, but CF-specific runtime behavior (workerd APIs and limits, ISR/cache
 * semantics of the built worker) still needs the preview mode.
 */
import type {
  BindingHooks,
  WorkerdLogging,
} from "@alchemy.run/cloudflare-runtime/core";
import * as PlatformProxy from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxy";
import type * as Runtime from "@alchemy.run/cloudflare-runtime/core/Runtime";
import * as FrameworkCore from "../core/index.ts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import { createRequire } from "node:module";
import type * as NodeNet from "node:net";
import type * as NodeVm from "node:vm";

/** The symbol OpenNext uses to store/read the Cloudflare context. Must stay
 * in sync with `@opennextjs/cloudflare`'s `cloudflareContextSymbol`. */
export const CLOUDFLARE_CONTEXT_SYMBOL: unique symbol = Symbol.for(
  "__cloudflare-context__",
);

/** The shape `getCloudflareContext()` expects (upstream `CloudflareContext`). */
export interface CloudflareContextShape {
  readonly env: Record<string, unknown>;
  readonly cf: Record<string, unknown> | undefined;
  readonly ctx: unknown;
}

export interface DevServerOptions {
  /** The Next.js project root (the directory containing `next.config.*`). */
  readonly root: string;
  /** @default "localhost" */
  readonly hostname?: string | undefined;
  /** Port to listen on. Defaults to an ephemeral port. */
  readonly port?: number | undefined;
  /**
   * Bindings to expose through `getCloudflareContext().env` — the same hook
   * shapes `Runtime.start` accepts (`Text.local`, `KvNamespace.local`, …).
   */
  readonly bindings?: BindingHooks | undefined;
  /** Compatibility date for the binding-proxy worker. */
  readonly compatibilityDate?: string | undefined;
  /** Compatibility flags for the binding-proxy worker. */
  readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  /** Name of the binding-proxy workerd service. @default "nextjs-dev-platform-proxy" */
  readonly proxyName?: string | undefined;
  readonly logging?: WorkerdLogging | undefined;
}

export interface DevServerInstance {
  /** The local URL the dev server is listening on. */
  readonly url: URL;
}

const fail = (message: string) => (cause: unknown) =>
  new FrameworkCore.FrameworkError({ framework: "nextjs", message, cause });

// ---------------------------------------------------------------------------
// Cloudflare-context planting (OpenNext contract)
// ---------------------------------------------------------------------------

type GlobalWithContext = typeof globalThis & {
  [CLOUDFLARE_CONTEXT_SYMBOL]?: CloudflareContextShape | undefined;
};

/**
 * The context currently planted by an open dev server. The `vm.runInContext`
 * patch consults this mutable reference so the (process-global, one-time)
 * patch always reflects the latest scope: cleared on release, re-set by the
 * next `start`.
 */
let currentContext: CloudflareContextShape | undefined;
let vmPatched = false;

/**
 * Mirror of OpenNext's `monkeyPatchVmModuleEdgeContext`: Next dev evaluates
 * edge functions (middleware, edge routes) with `vm.runInContext`, whose
 * sandbox does not inherit `globalThis` symbols — inject the context into
 * every contextified object so `getCloudflareContext()` works there too.
 * Patched once per process; a cleared {@link currentContext} makes it a
 * pass-through.
 */
const patchVmRunInContext = (): void => {
  if (vmPatched) return;
  vmPatched = true;
  // The ESM namespace of "node:vm" is frozen; patch the (shared, mutable)
  // CJS exports object — the one Next's sandbox `require`s.
  const vm = createRequire(import.meta.url)("vm") as typeof NodeVm;
  const original = vm.runInContext.bind(vm);
  const patched: typeof vm.runInContext = (
    code,
    contextifiedObject,
    options,
  ) => {
    if (currentContext !== undefined) {
      const runtimeContext = contextifiedObject as GlobalWithContext;
      runtimeContext[CLOUDFLARE_CONTEXT_SYMBOL] ??= currentContext;
    }
    return original(code, contextifiedObject, options);
  };
  vm.runInContext = patched;
};

/**
 * Plant `{ env, cf, ctx }` on the global symbol (and arm the vm patch) for
 * the lifetime of the surrounding scope; the previous value is restored on
 * release.
 */
const plantCloudflareContext = (
  context: CloudflareContextShape,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const global = globalThis as GlobalWithContext;
      const previous = global[CLOUDFLARE_CONTEXT_SYMBOL];
      global[CLOUDFLARE_CONTEXT_SYMBOL] = context;
      currentContext = context;
      patchVmRunInContext();
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        (globalThis as GlobalWithContext)[CLOUDFLARE_CONTEXT_SYMBOL] = previous;
        currentContext = previous;
      }),
  ).pipe(Effect.asVoid);

// ---------------------------------------------------------------------------
// Loading `next` from the project root
// ---------------------------------------------------------------------------

type RequestHandler = (
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
) => Promise<void>;

/** The subset of `NextCustomServer` (the public custom-server API) we drive. */
interface NextDevApp {
  prepare(): Promise<void>;
  getRequestHandler(): RequestHandler;
  close(): Promise<void>;
}

type CreateNextServer = (options: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => NextDevApp;

/**
 * Resolve the *project's* `next` (public entry, `dist/server/next.js`) — the
 * fixture/app's installed copy is the one driven, never a hoisted sibling.
 * The entry is CJS; unwrap the ESM-interop `default` nesting to the
 * `createServer` function.
 */
const loadNext = (
  root: string,
): Effect.Effect<CreateNextServer, FrameworkCore.FrameworkError> =>
  FrameworkCore.loadProjectModule<Record<string, unknown>>(root, "next").pipe(
    Effect.mapError((error) =>
      fail(`Failed to load "next" from ${root}`)(error.cause),
    ),
    Effect.flatMap((module_) => {
      let candidate: unknown = module_;
      for (let i = 0; i < 3 && typeof candidate !== "function"; i++) {
        candidate = (candidate as Record<string, unknown> | undefined)?.default;
      }
      return typeof candidate === "function"
        ? Effect.succeed(candidate as CreateNextServer)
        : Effect.fail(
            fail(
              `The "next" package resolved from ${root} has no callable default export`,
            )(undefined),
          );
    }),
  );

// ---------------------------------------------------------------------------
// The http server (caller-owned port/URL)
// ---------------------------------------------------------------------------

interface HttpServerHandle {
  readonly server: NodeHttp.Server;
  readonly port: number;
  readonly setHandler: (handler: RequestHandler) => void;
}

/**
 * Listen before Next starts: the actual port must be known when the app is
 * created (`port` seeds Turbopack's HMR/asset URLs), so the server binds
 * first (503 until the handler is wired) and the ephemeral port feeds
 * `next({ port })`. The HMR websocket upgrade is auto-wired by
 * `getRequestHandler()` through `req.socket.server` on the first request.
 */
const acquireHttpServer = (
  hostname: string,
  port: number | undefined,
): Effect.Effect<HttpServerHandle, FrameworkCore.FrameworkError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<
      HttpServerHandle & { readonly sockets: Set<NodeNet.Socket> },
      FrameworkCore.FrameworkError
    >((resume) => {
      let handler:
        | ((
            req: NodeHttp.IncomingMessage,
            res: NodeHttp.ServerResponse,
          ) => Promise<void>)
        | undefined;
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeHttp.createServer((req, res) => {
        if (handler !== undefined) {
          void handler(req, res);
        } else {
          res.statusCode = 503;
          res.end("Next.js dev server is starting");
        }
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.once("error", (cause) =>
        resume(
          Effect.fail(
            fail(`Failed to listen on ${hostname}:${port ?? 0}`)(cause),
          ),
        ),
      );
      server.listen(port ?? 0, hostname, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(
            Effect.fail(fail("The dev server has no TCP address")(address)),
          );
          return;
        }
        resume(
          Effect.succeed({
            server,
            sockets,
            port: address.port,
            setHandler: (h) => {
              handler = h;
            },
          }),
        );
      });
    }),
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        // Destroy live (keep-alive / HMR websocket) sockets so close() never
        // hangs on an idle connection.
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      }),
  );

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/**
 * Start `next dev` with Cloudflare bindings. Scoped: closing the Scope stops
 * the Next.js app (Turbopack), the http server, and the binding proxy, and
 * restores the global Cloudflare context.
 *
 * Requires `Runtime.Runtime` (from `RuntimeServices.layerRuntime`) for the
 * binding-proxy workerd instance.
 */
export const start = Effect.fn("Nextjs.DevServer.start")(function* (
  options: DevServerOptions,
) {
  const hostname = options.hostname ?? "localhost";
  // Resolve symlinks in the project root (macOS /tmp, /var/folders):
  // Turbopack's watcher reports events under the real path, so a symlinked
  // root never receives HMR invalidations.
  const root = yield* Effect.sync(() => {
    try {
      return NodeFs.realpathSync.native(options.root);
    } catch {
      return options.root;
    }
  });

  // 1. Open the platform proxy hosting the worker's bindings.
  const proxy = yield* PlatformProxy.open({
    name: options.proxyName ?? "nextjs-dev-platform-proxy",
    ...(options.compatibilityDate !== undefined
      ? { compatibilityDate: options.compatibilityDate }
      : {}),
    ...(options.compatibilityFlags !== undefined
      ? { compatibilityFlags: [...options.compatibilityFlags] }
      : {}),
    bindings: options.bindings ?? [],
    ...(options.logging !== undefined ? { logging: options.logging } : {}),
  }).pipe(
    Effect.mapError(fail("Failed to start the binding proxy for next dev")),
  );

  // 2. Plant the OpenNext cloudflare-context contract before any app code
  //    (next.config, instrumentation, routes) can call getCloudflareContext.
  yield* plantCloudflareContext({
    env: proxy.env,
    cf: proxy.cf,
    ctx: proxy.ctx,
  });

  // 3. Bind our http server first so the real port can seed `next({ port })`.
  const http = yield* acquireHttpServer(hostname, options.port);

  // 4. The public programmatic dev API: next({ dev: true }) + prepare().
  const createNext = yield* loadNext(root);
  const app = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const app = createNext({
          dev: true,
          dir: root,
          hostname,
          port: http.port,
        });
        await app.prepare();
        return app;
      },
      catch: fail("Failed to start the Next.js dev server"),
    }),
    (app) => Effect.promise(() => app.close().catch(() => undefined)),
  );
  http.setHandler(app.getRequestHandler());

  const urlHost =
    hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
  return {
    url: new URL(`http://${urlHost}:${http.port}`),
  } satisfies DevServerInstance;
}) as (
  options: DevServerOptions,
) => Effect.Effect<
  DevServerInstance,
  FrameworkCore.FrameworkError,
  Runtime.Runtime | Scope.Scope
>;
