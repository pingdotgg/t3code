import type {
  BindingHooks,
  Module,
  RuntimeWorker,
} from "@alchemy.run/cloudflare-runtime/core";
import * as Runtime from "@alchemy.run/cloudflare-runtime/core/Runtime";
import * as RuntimeServices from "@alchemy.run/cloudflare-runtime/core/RuntimeServices";
import * as DurableObjectNamespace from "@alchemy.run/cloudflare-runtime/core/bindings/DurableObjectNamespace";
import * as Service from "@alchemy.run/cloudflare-runtime/core/bindings/Service";
import * as Assets from "@alchemy.run/cloudflare-runtime/core/bindings/assets/Assets";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as FrameworkCore from "../core/index.ts";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as Bundle from "./Bundle.ts";
import * as DevServer from "./DevServer.ts";
import * as Runner from "./Runner.ts";

/**
 * The subset of the e2e-harness `options.vite` convention this integration
 * reads: the cloudflare worker configuration (compatibility date/flags,
 * worker name/bindings/assets). Structurally compatible with
 * `CloudflareVitePluginOptions` so harness fixtures stay uniform.
 */
export interface NextjsWorkerConfig {
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: Array<string> | undefined;
  readonly worker?:
    | Omit<
        RuntimeWorker<BindingHooks>,
        "compatibilityDate" | "compatibilityFlags" | "modules"
      >
    | undefined;
}

/** Options for the Next.js (OpenNext-based) `Framework` integration. */
export interface NextjsFrameworkOptions {
  /**
   * Cloudflare worker configuration, following the e2e harness convention
   * (`options.vite` carries compatibility date/flags and the worker's
   * name/bindings/assets).
   */
  readonly vite?: NextjsWorkerConfig | undefined;
  /** Next.js/OpenNext-specific knobs. */
  readonly nextjs?:
    | {
        /**
         * Path of the OpenNext config, relative to the project root.
         * @default "open-next.config.ts"
         */
        readonly configPath?: string | undefined;
        /**
         * The command the OpenNext pipeline runs to build the Next.js app.
         * A `buildCommand` set in the project's `open-next.config.ts` takes
         * precedence over this option.
         * @default "npx next build"
         */
        readonly buildCommand?: string | undefined;
        /** Skip the internal `next build` (reuse an existing `.next`). */
        readonly skipNextBuild?: boolean | undefined;
        /** Minify the OpenNext bundling steps and the final bundle pass. */
        readonly minify?: boolean | undefined;
        /**
         * Enable OpenNext debug logging and verbose workerd output in dev
         * (workerd otherwise swallows uncaught worker exceptions).
         */
        readonly debug?: boolean | undefined;
      }
    | undefined;
  /** Dev-server behavior. */
  readonly dev?:
    | {
        /**
         * - `"preview"` (default): build the OpenNext worker and serve it
         *   under `cloudflare-runtime` (workerd) — production parity, no HMR.
         * - `"hmr"`: run the real `next dev` (Turbopack HMR) in Node, with
         *   the worker's bindings proxied from `cloudflare-runtime` and
         *   planted on OpenNext's `getCloudflareContext()` contract
         *   ({@link DevServer.start}). App code runs in Node, not workerd —
         *   CF-specific runtime behavior and ISR/caching semantics still
         *   need `"preview"`.
         * @default "preview"
         */
        readonly mode?: "preview" | "hmr" | undefined;
      }
    | undefined;
  /** Project root. Defaults to the process working directory. */
  readonly root?: string | undefined;
  /**
   * The host's runtime stack (a `Context.Context<RuntimeServices>`, e.g.
   * alchemy's `DevContext.runtimeContext`). When provided, dev servers host
   * the binding proxy in it instead of building the credential-free internal
   * layer — this is what makes `Alchemy.remote()` bindings resolve in dev.
   * Typed `unknown` to keep the option JSON-tolerant at the boundary; it is
   * narrowed internally.
   */
  readonly services?: unknown;
}

/**
 * Extract the edge-runtime function paths from `.next/server/
 * middleware-manifest.json`. `middleware` entries are supported (OpenNext
 * runs the middleware in the worker); `functions` entries are routes/pages
 * compiled for the edge runtime, which `@opennextjs/cloudflare` does not
 * support.
 */
export const listEdgeFunctions = (manifest: unknown): Array<string> => {
  if (typeof manifest !== "object" || manifest === null) return [];
  const functions = (manifest as { functions?: Record<string, unknown> })
    .functions;
  return functions === undefined ? [] : Object.keys(functions);
};

/** The default compatibility date when the options provide none. */
export const DEFAULT_COMPATIBILITY_DATE = "2026-05-12";

/** The server-module name of the worker entry (`serverModules[0]`). */
export const WORKER_ENTRY_MODULE = `worker/${Bundle.WORKER_ENTRY_NAME}`;

/** The OpenNext revalidation-queue Durable Object class. */
export const DO_QUEUE_CLASS = "DOQueueHandler";
/** The binding name OpenNext expects for the revalidation-queue DO. */
export const DO_QUEUE_BINDING = "NEXT_CACHE_DO_QUEUE";
/** The self service binding OpenNext uses for ISR revalidation fetches. */
export const SELF_REFERENCE_BINDING = "WORKER_SELF_REFERENCE";

/** Build the {@link Runner.RunnerConfig} for a project (exported for testing). */
export const makeRunnerConfig = (
  root: string,
  options?: NextjsFrameworkOptions,
): Runner.RunnerConfig => ({
  appDir: root,
  configPath: options?.nextjs?.configPath ?? "open-next.config.ts",
  compatibilityDate:
    options?.vite?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
  skipNextBuild: options?.nextjs?.skipNextBuild ?? false,
  minify: options?.nextjs?.minify ?? false,
  debug: options?.nextjs?.debug ?? false,
  buildCommand: options?.nextjs?.buildCommand,
});

/**
 * Map a `BuildOutput`'s server modules to cloudflare-runtime worker modules
 * (exported for testing). Sourcemaps are dropped; binary content is passed
 * through as bytes, text content as strings.
 */
export const toRuntimeModules = (
  serverModules: ReadonlyArray<FrameworkCore.OutputFile>,
): Array<Module> =>
  serverModules.flatMap((file): Module | Array<Module> => {
    const asText = () =>
      typeof file.content === "string"
        ? file.content
        : Buffer.from(file.content).toString("utf8");
    const asBytes = () =>
      typeof file.content === "string"
        ? new TextEncoder().encode(file.content)
        : file.content;
    switch (NodePath.extname(file.name)) {
      case ".js":
      case ".mjs":
        return { name: file.name, type: "ESModule", content: asText() };
      case ".cjs":
        return { name: file.name, type: "CommonJsModule", content: asText() };
      case ".json":
        return { name: file.name, type: "Json", content: asText() };
      case ".wasm":
        return { name: file.name, type: "Wasm", content: asBytes() };
      case ".bin":
        return { name: file.name, type: "Data", content: asBytes() };
      case ".map":
        return [];
      default:
        return { name: file.name, type: "Text", content: asText() };
    }
  });

/**
 * Whether the entry module exports the OpenNext revalidation-queue Durable
 * Object class (exported for testing). OpenNext's `worker.js` re-exports the
 * DO classes it ships; when present, dev declares the same-script
 * SQLite-backed namespace + binding so `doQueue`-configured apps work and
 * `memoryQueue` apps keep parity with the deployed worker shape.
 */
export const hasDoQueueClass = (
  entry: FrameworkCore.OutputFile | undefined,
): boolean => {
  if (entry === undefined) return false;
  const content =
    typeof entry.content === "string"
      ? entry.content
      : Buffer.from(entry.content).toString("utf8");
  return content.includes(DO_QUEUE_CLASS);
};

/** The services the runtime layer for dev is built from. */
const makeRuntimeLayer = () =>
  RuntimeServices.layerRuntime({
    api: {
      // Local-only serving: the account id is only consulted when remote
      // bindings are used, which a preview-parity dev server does not
      // require. Fall back to a placeholder so credentials stay optional.
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "distilled-nextjs-local",
    },
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.merge(Credentials.fromEnv(), FetchHttpClient.layer)),
  );

/**
 * Front a target server with a TCP proxy on a fixed local port.
 * `Runtime.start` always binds an ephemeral port, so honoring
 * `FrameworkDevOptions.port` requires the forwarder.
 */
const proxyToPort = (
  port: number,
  target: URL,
): Effect.Effect<URL, FrameworkCore.FrameworkError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server, FrameworkCore.FrameworkError>((resume) => {
      const server = NodeNet.createServer((socket) => {
        const upstream = NodeNet.connect(Number(target.port), target.hostname);
        socket.pipe(upstream);
        upstream.pipe(socket);
        const teardown = () => {
          socket.destroy();
          upstream.destroy();
        };
        socket.on("error", teardown);
        upstream.on("error", teardown);
        socket.on("close", teardown);
        upstream.on("close", teardown);
      });
      server.once("error", (cause) =>
        resume(
          Effect.fail(
            new FrameworkCore.FrameworkError({
              framework: "nextjs",
              message: `Failed to listen on port ${port}`,
              cause,
            }),
          ),
        ),
      );
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map(() => new URL(`http://127.0.0.1:${port}`)));

/**
 * The Next.js implementation of framework-core's `Framework` service,
 * built on the `@opennextjs/cloudflare` build pipeline — wrangler-free:
 *
 * - `build` runs the pipeline in a disposable child process (`runner.mjs`
 *   vendors the two thin config wrappers so no wrangler code is ever
 *   imported), then performs the final bundle pass wrangler would normally
 *   do at deploy time ({@link Bundle.bundleWorker}), populates the
 *   static-assets incremental cache, and returns the `BuildOutput` in-memory.
 * - `dev` (default mode `"preview"`) serves the built worker under
 *   `@alchemy.run/cloudflare-runtime/core` (workerd) with the OpenNext worker
 *   shape: `ASSETS` + run-worker-first, a `WORKER_SELF_REFERENCE` self
 *   service binding, and the same-script SQLite-backed revalidation-queue
 *   Durable Object. No HMR — file watching/rebuild is a later phase.
 * - `dev` with `options.dev.mode: "hmr"` runs the real `next dev` (Turbopack
 *   HMR) in Node with the worker's bindings proxied from
 *   `cloudflare-runtime` ({@link DevServer.start}) — see the mode's fidelity
 *   notes on {@link NextjsFrameworkOptions}.
 */
export const make = (
  options?: NextjsFrameworkOptions,
): Layer.Layer<
  FrameworkCore.Framework,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    FrameworkCore.Framework,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const fail = (message: string) => (cause: unknown) =>
        new FrameworkCore.FrameworkError({
          framework: "nextjs",
          message,
          cause,
        });

      const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(FileSystem.FileSystem)(fs),
            Layer.succeed(Path.Path)(path),
          ),
        ),
      );

      const resolveRoot = (override: string | undefined) =>
        Effect.sync(() =>
          path.resolve(override ?? options?.root ?? process.cwd()),
        );

      const paths = (root: string) => ({
        openNextDirectory: path.resolve(root, ".open-next"),
        clientDirectory: path.resolve(root, ".open-next", "assets"),
        cacheDirectory: path.resolve(root, ".open-next", "cache"),
        distDirectory: path.resolve(root, "dist"),
        workerDirectory: path.resolve(root, "dist", "worker"),
      });

      const build = Effect.fn(function* (
        buildOptions?: FrameworkCore.FrameworkBuildOptions,
      ) {
        const root = yield* resolveRoot(buildOptions?.root);
        const p = paths(root);

        // 1. The OpenNext build pipeline (spawns `next build` internally).
        yield* Runner.runOpenNextBuild(makeRunnerConfig(root, options)).pipe(
          Effect.mapError((error) => fail(error.message)(error.cause)),
          Effect.provide(spawnerLayer),
        );

        // 1.5. Edge-runtime routes/pages are not supported by
        // @opennextjs/cloudflare (it shims `next/dist/compiled/edge-runtime`
        // to an empty module, so they 500 at runtime). Fail the build with
        // the exact route list instead of shipping a mystery 500 — the same
        // code runs fine on Workers under the node runtime.
        const manifestPath = path.join(
          root,
          ".next",
          "server",
          "middleware-manifest.json",
        );
        const manifestRaw = yield* fs
          .readFileString(manifestPath)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (manifestRaw !== undefined) {
          const edgeRoutes = yield* Effect.try({
            try: () => listEdgeFunctions(JSON.parse(manifestRaw)),
            catch: fail(`Failed to parse ${manifestPath}`),
          });
          if (edgeRoutes.length > 0) {
            return yield* Effect.fail(
              fail(
                `Edge-runtime routes/pages are not supported by @opennextjs/cloudflare: ${edgeRoutes.join(", ")}. ` +
                  `Remove \`export const runtime = "edge"\` from these modules — the node runtime runs on Workers.`,
              )(undefined),
            );
          }
        }

        // 2. The final bundle pass (what wrangler does implicitly on deploy).
        yield* fs
          .remove(p.workerDirectory, { recursive: true })
          .pipe(Effect.ignore);
        yield* Bundle.bundleWorker({
          openNextDirectory: p.openNextDirectory,
          outDirectory: p.workerDirectory,
          minify: options?.nextjs?.minify ?? false,
        }).pipe(Effect.mapError((error) => fail(error.message)(error.cause)));

        // 3. populateCache, static-assets flavor: prerendered ISR/fetch cache
        //    entries are served read-only through the ASSETS binding.
        const hasCache = yield* fs
          .exists(p.cacheDirectory)
          .pipe(Effect.orElseSucceed(() => false));
        if (hasCache) {
          yield* fs
            .copy(
              p.cacheDirectory,
              path.join(p.clientDirectory, "cdn-cgi", "_next_cache"),
              {
                overwrite: true,
              },
            )
            .pipe(
              Effect.mapError(
                fail("Failed to populate the static-assets incremental cache"),
              ),
            );
        }

        // 4. Collect the BuildOutput contract from disk (entry first).
        const files = yield* FrameworkCore.readServerModulesFromDisk({
          directory: p.workerDirectory,
          prefix: "worker",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.mapError((error) => fail(error.message)(error.cause)),
        );
        const output: FrameworkCore.BuildOutput = {
          distDirectory: p.distDirectory,
          clientDirectory: p.clientDirectory,
          serverModules: FrameworkCore.sortServerModules(
            files,
            WORKER_ENTRY_MODULE,
          ),
          externalWorkspaces: new Set(),
        };
        return output;
      });

      // The runtime context the dev servers host their binding proxy in:
      // the caller-provided host stack (includes remote-bindings support,
      // so `Alchemy.remote()` bindings resolve) when present, the internal
      // credential-free layer otherwise.
      const resolveRuntimeContext = Effect.fn(function* () {
        if (options?.services !== undefined) {
          return options.services as Context.Context<RuntimeServices.RuntimeServices>;
        }
        const scope = yield* Effect.scope;
        return yield* Layer.buildWithScope(makeRuntimeLayer(), scope).pipe(
          Effect.mapError(
            fail("Failed to start the cloudflare-runtime services"),
          ),
        );
      });

      const dev = Effect.fn(function* (
        devOptions?: FrameworkCore.FrameworkDevOptions,
      ) {
        const root = yield* resolveRoot(devOptions?.root);

        // Dev v2 ("hmr"): real `next dev` (Turbopack HMR) in Node, bindings
        // proxied from cloudflare-runtime onto OpenNext's
        // getCloudflareContext() contract. No OpenNext build involved.
        if (options?.dev?.mode === "hmr") {
          const worker = options?.vite?.worker;
          const context = yield* resolveRuntimeContext();
          const server = yield* DevServer.start({
            root,
            port: devOptions?.port,
            bindings: worker?.bindings ?? [],
            compatibilityDate:
              options?.vite?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
            compatibilityFlags: [
              ...new Set([
                "nodejs_compat",
                ...(options?.vite?.compatibilityFlags ?? []),
              ]),
            ],
            ...(worker?.name !== undefined
              ? { proxyName: `${worker.name}-dev-proxy` }
              : {}),
            logging: options?.nextjs?.debug
              ? { verbose: true }
              : worker?.logging,
          }).pipe(Effect.provideContext(context));
          return { url: server.url.href };
        }

        // Preview parity: always build on dev start (OpenNext memoizes where
        // it can). Watch + rebuild is a later phase.
        const output = yield* build({ root });
        if (
          output.serverModules === undefined ||
          output.serverModules.length === 0
        ) {
          return yield* Effect.fail(
            fail("The build produced no server modules")(undefined),
          );
        }
        const modules = toRuntimeModules(output.serverModules);
        const worker = options?.vite?.worker;

        const declaresDoQueue = (worker?.durableObjectNamespaces ?? []).some(
          (namespace) => namespace.className === DO_QUEUE_CLASS,
        );
        const withDoQueue =
          !declaresDoQueue && hasDoQueueClass(output.serverModules[0]);

        const context = yield* resolveRuntimeContext();

        const url = yield* Runtime.Runtime.use((runtime) =>
          runtime.start({
            name: worker?.name ?? "distilled-nextjs-dev",
            compatibilityDate:
              options?.vite?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
            compatibilityFlags: [
              ...new Set([
                "nodejs_compat",
                ...(options?.vite?.compatibilityFlags ?? []),
              ]),
            ],
            modules,
            bindings: [
              Assets.local("ASSETS"),
              Service.self(SELF_REFERENCE_BINDING),
              ...(withDoQueue
                ? [
                    DurableObjectNamespace.local({
                      binding: DO_QUEUE_BINDING,
                      className: DO_QUEUE_CLASS,
                    }),
                  ]
                : []),
              ...(worker?.bindings ?? []),
            ],
            assets: {
              ...worker?.assets,
              directory: output.clientDirectory,
              runWorkerFirst: worker?.assets?.runWorkerFirst ?? true,
            },
            durableObjectNamespaces: [
              ...(withDoQueue
                ? [{ className: DO_QUEUE_CLASS, sql: true }]
                : []),
              ...(worker?.durableObjectNamespaces ?? []),
            ],
            ...(worker?.hyperdrives !== undefined
              ? { hyperdrives: worker.hyperdrives }
              : {}),
            ...(worker?.queueConsumers !== undefined
              ? { queueConsumers: worker.queueConsumers }
              : {}),
            ...(worker?.unsafe !== undefined ? { unsafe: worker.unsafe } : {}),
            logging: options?.nextjs?.debug
              ? { verbose: true }
              : worker?.logging,
          }),
        ).pipe(
          Effect.provideContext(context),
          Effect.mapError(
            fail("Failed to start the dev worker in cloudflare-runtime"),
          ),
        );

        if (
          devOptions?.port !== undefined &&
          String(devOptions.port) !== url.port
        ) {
          const proxied = yield* proxyToPort(devOptions.port, url);
          return { url: proxied.href };
        }
        return { url: url.href };
      });

      return FrameworkCore.Framework.of({
        build: (buildOptions) => build(buildOptions),
        dev: (devOptions) => dev(devOptions),
      });
    }),
  );
