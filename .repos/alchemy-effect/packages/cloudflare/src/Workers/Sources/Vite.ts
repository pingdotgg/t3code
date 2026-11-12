import { createRequire } from "node:module";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { viteSupportsPortZero } from "@alchemy.run/cloudflare-runtime/core/internal/Port";
import cloudflare, { type CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import { viteBuildOutputPlugin, type ViteBuildOutput } from "alchemy/Bundle/Vite";
import { hashDirectory, type MemoOptions } from "alchemy/Command/Memo";
import { findAvailablePort, initialCwd } from "alchemy/Util/Node";
import { makeResourceLogger } from "alchemy/Util/ResourceOutput";
import { sha256Object } from "alchemy/Util/sha256";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type * as vite from "vite";
import type { FoldkitBuildMetadata } from "../../Website/FoldkitBuild.ts";
import { readAssets } from "../Assets.ts";
import type { SourceDevHandle, SourceProvider } from "../Source.ts";
import { runViteBuildChild } from "../ViteChild.ts";
import { resolveViteMain } from "../ViteMain.ts";
import { isSelfUrl, type ViteOptions } from "../Worker.ts";
import { isContainerDecl } from "../WorkerAsyncBindings.ts";
import { isWorkerLoader } from "../WorkerLoader.ts";

/**
 * This module statically imports `@alchemy.run/cloudflare-runtime/vite`
 * (~0.5s to load), which is only needed for vite-based workers. Importers
 * MUST load it lazily (`Effect.promise(() => import("./Sources/Vite.ts"))`
 * from the dispatch in `Source.ts`, or the legacy vite arms in the
 * Worker providers) so the module cost is only paid when a vite worker
 * is actually built, hashed, or served.
 */

/**
 * Route Vite's logger into log records through the services of the Effect
 * that built it, instead of its default stdout logger: the process that
 * renders logs shows them (raw or stripped), JSON output carries them, and
 * alchemy-test's per-test log capture sees them.
 */
const makeViteLogger = (context: Context.Context<never>): vite.Logger => {
  const loggedErrors = new WeakSet<object>();
  let hasWarned = false;
  const log = (effect: Effect.Effect<void>) => Effect.runSyncWith(context)(effect);
  return {
    info: (msg) => log(Effect.logInfo(msg)),
    warn: (msg) => {
      hasWarned = true;
      log(Effect.logWarning(msg));
    },
    warnOnce: (msg) => {
      hasWarned = true;
      log(Effect.logWarning(msg));
    },
    error: (msg, options) => {
      if (options?.error != null) loggedErrors.add(options.error);
      log(Effect.logError(msg));
    },
    clearScreen: () => {},
    hasErrorLogged: (error) => loggedErrors.has(error),
    get hasWarned() {
      return hasWarned;
    },
  };
};

/**
 * Signals to the app's own Vite config that Alchemy is injecting its
 * resource-aware Cloudflare plugin into this build/dev run.
 *
 * Apps that also build standalone (plain `vite build` in CI, no Alchemy)
 * need the Cloudflare plugin in their `vite.config.ts`. Without a guard,
 * an Alchemy-orchestrated run instantiates that config-file instance
 * *alongside* the injected one: two same-named plugin stacks whose
 * cross-plugin API lookups resolve by name, and — in dev — two workerd
 * runtimes, only one of which carries the Worker's bindings. Guarding on
 * this variable lets the config-file instance stand down:
 *
 * ```ts
 * // vite.config.ts
 * process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
 *   ? null
 *   : cloudflare({ ... })
 * ```
 *
 * The variable is set process-locally by `viteDev`/`viteBuild`, so it is
 * correct regardless of which process hosts Vite (`alchemy dev` runs the
 * dev server in the spawned local-provider host, not in the process that
 * evaluates the user's alchemy.run.ts — an env variable set there never
 * reaches the config).
 *
 * Contract: the value is `"1"` while the process is Alchemy-orchestrated;
 * absence means not injected. It is deliberately never unset — Vite
 * re-evaluates the app config on dev-server restarts long after
 * `viteDev` returned, and concurrent `viteBuild`s in one process would
 * race a save/restore. A process that ran an Alchemy build never also
 * runs a standalone (non-Alchemy) Vite build, so the flag staying set is
 * correct for the process lifetime.
 */
const ALCHEMY_CLOUDFLARE_VITE_INJECTED = "ALCHEMY_CLOUDFLARE_VITE_INJECTED";

export const viteDev = (
  rootDir: string = initialCwd,
  env: Record<string, unknown>,
  pluginOptions: CloudflareVitePluginOptions,
  serverOptions: vite.ServerOptions,
) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      process.env[ALCHEMY_CLOUDFLARE_VITE_INJECTED] = "1";
    });
    const vite = yield* Effect.promise(() => loadVite(rootDir));
    // `port: 0` is a true OS-assigned random port on Vite >= 8.2.1
    // (vitejs/vite#23158); older Vite treats it as "no port given" and
    // hunts upward from the 5173 default — colliding with (or
    // IPv6-shadowing) user-facing dev ports. Substitute a probed
    // ephemeral port there; `strictPort: false` handles the small
    // probe→bind race by moving to the next ephemeral port.
    const server =
      serverOptions.port === 0 && !viteSupportsPortZero(vite.version)
        ? {
            ...serverOptions,
            port: yield* findAvailablePort(
              typeof serverOptions.host === "string" ? serverOptions.host : undefined,
            ).pipe(Effect.orDie),
          }
        : serverOptions;
    return yield* Effect.acquireRelease(
      Effect.flatMap(Effect.context<never>(), (context) =>
        Effect.promise(async () => {
          const devServer = await vite.createServer({
            root: rootDir,
            define: getDefine(env),
            plugins: [cloudflare(pluginOptions)],
            server,
            customLogger: makeViteLogger(context),
          });
          await devServer.listen();
          return devServer;
        }),
      ),
      (devServer) =>
        Effect.promise(async () => {
          await devServer.close();
        }),
    );
  });

type ViteBuildOptions = CloudflareVitePluginOptions & Pick<ViteOptions, "framework">;

type ViteWorkerBuildOutput = ViteBuildOutput & {
  foldkit: FoldkitBuildMetadata | undefined;
};

/**
 * Run a production Vite build in a child process rooted at the project
 * directory and adapt the result to the in-process {@link ViteBuildOutput}
 * shape.
 *
 * The child boundary is what makes concurrent builds safe: vite resolves a
 * relative root against live `process.cwd()`, plugins read cwd freely, and
 * build-time spawns chdir the hosting process transiently (cross-spawn's
 * PATH resolution) — so an in-process build both breaks under and causes
 * cwd races when the engine runs builds concurrently.
 */
export const viteBuild = (
  rootDir: string = initialCwd,
  env: Record<string, unknown>,
  pluginOptions: ViteBuildOptions,
  fqn: string,
) =>
  Effect.gen(function* () {
    const logResourceOutput = makeResourceLogger(fqn);
    const result = yield* runViteBuildChild(
      {
        // Anchor to the initial cwd so the resolution itself can't race a
        // transient chdir; the child's own cwd is this resolved root.
        rootDir: nodePath.resolve(initialCwd, rootDir),
        // Only `VITE_`-prefixed entries participate in the build (see
        // `getDefine`); the rest may hold non-serializable values.
        env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("VITE_"))),
        main: pluginOptions.main,
        framework: pluginOptions.framework,
        compatibilityDate: pluginOptions.compatibilityDate,
        compatibilityFlags: pluginOptions.compatibilityFlags,
        viteEnvironments: pluginOptions.viteEnvironments,
      },
      logResourceOutput,
    );
    return {
      clientDirectory: result.clientDirectory,
      foldkit: result.foldkit,
      base: result.base,
      serverBundle: Effect.succeed(result.serverBundle),
      externalWorkspaces: Effect.succeed(new Set(result.externalWorkspaces)),
    } satisfies ViteWorkerBuildOutput;
  });

/**
 * The in-process build implementation. ONLY safe inside the dedicated
 * build child (`ViteBuildChildRunner.ts`), whose cwd is the project root
 * and which hosts no concurrent work — never call it from the engine
 * process (see {@link viteBuild}).
 */
export const viteBuildInProcess = (
  rootDir: string,
  env: Record<string, unknown>,
  pluginOptions: ViteBuildOptions,
) =>
  Effect.gen(function* () {
    const outputPlugin = yield* viteBuildOutputPlugin({
      entryEnvironment: pluginOptions.viteEnvironments?.entry ?? "ssr",
    });
    const context = yield* Effect.context<never>();
    const foldkit = yield* Effect.promise(async () => {
      process.env[ALCHEMY_CLOUDFLARE_VITE_INJECTED] = "1";
      const vite = await loadVite(rootDir);
      const builder = await vite.createBuilder(
        {
          root: rootDir,
          define: getDefine(env),
          plugins: [cloudflare(pluginOptions), outputPlugin.plugin],
          customLogger: makeViteLogger(context),
          // Disables the NATIVE rolldown progress reporter ("transforming…",
          // "rendering chunks…", "computing gzip size…"): it prints from
          // Rust straight to fd 1 and cannot be intercepted from JS — vite
          // only enables it when logLevel >= info. Info-level build
          // summaries are suppressed with it; warnings and errors still
          // reach the customLogger above.
          logLevel: "warn",
        },
        // This is the `useLegacyBuilder` option. The Vite CLI implementation uses `null` here.
        // Originally we used `undefined` here, but this caused the static site build to fail.
        // https://github.com/vitejs/vite/blob/a07a4bd052ac75f916391c999c408ad5f2867e61/packages/vite/src/node/cli.ts#L367
        null,
      );
      const readFoldkitMetadata =
        pluginOptions.framework === "foldkit"
          ? (await import("../../Website/FoldkitBuild.ts")).foldkitBuildMetadataReader(
              builder.config.plugins,
              pluginOptions.main,
            )
          : undefined;
      await builder.buildApp();
      return readFoldkitMetadata?.();
    });
    return { ...(yield* outputPlugin.output), foldkit };
  });

// Emulate `vite build` env semantics for `props.env`: only
// keys with Vite's default `VITE_` prefix are inlined into
// the bundle as `import.meta.env.*`. `Redacted` values are
// unwrapped — by prefixing with `VITE_` the user is opting
// them into the public bundle.
const getDefine = (env: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, raw]) => {
      if (!key.startsWith("VITE_")) return [];
      const value = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
      return [[`import.meta.env.${key}`, JSON.stringify(value)] as const];
    }),
  );

type ViteModule = typeof import("vite");

/**
 * Dynamically load Vite from the project root. Falls back to the bundled
 * copy if the project doesn't have its own Vite installation.
 */
async function loadVite(projectRoot: string = initialCwd): Promise<ViteModule> {
  try {
    const require = createRequire(nodePath.join(projectRoot, "package.json"));
    const vitePath = require.resolve("vite");
    // On Windows, absolute paths must be file:// URLs for ESM import().
    const viteUrl = pathToFileURL(vitePath);
    return await import(/* @vite-ignore */ viteUrl.href);
  } catch {
    // Fallback: try to import vite from the global node_modules (works for non-linked installs)
    // The fallback is a bare specifier and works as-is.
    return await import("vite");
  }
}

/**
 * Resolve `props.env` to the literal values vite's `import.meta.env`
 * defines are computed from: strings pass through, `Redacted<string>`s
 * are unwrapped, env-bound Effects are evaluated, and `WorkerLoader`s
 * (bindings that happen to be Effects) are skipped.
 */
const resolveViteEnv = (env: Record<string, unknown>, selfUrl: string | undefined) =>
  Effect.gen(function* () {
    return Object.fromEntries(
      (yield* Effect.forEach(
        Object.entries(env),
        Effect.fn(function* ([key, value]) {
          return [
            key,
            typeof value === "string"
              ? value
              : Redacted.isRedacted(value) && typeof Redacted.value(value) === "string"
                ? Redacted.value(value)
                : // `Worker.URL` (bare tag or called) — resolved to this
                  // Worker's own URL. The bare tag is Effect-shaped, so
                  // check before `Effect.isEffect`.
                  isSelfUrl(value)
                  ? selfUrl
                  : // A `WorkerLoader` is a real Effect that also carries
                    // the `~alchemy/Kind` marker — it is a binding, not a
                    // runnable env value. Check it before `Effect.isEffect`
                    // so we don't execute it as an inlined env entry.
                    isWorkerLoader(value)
                    ? undefined
                    : // A `Cloudflare.Container` declaration is likewise
                      // Effect-shaped but is a binding (DO namespace +
                      // ContainerApplication) — yielding it would resolve
                      // the started-instance tag, which only exists inside
                      // a Durable Object (#997).
                      isContainerDecl(value)
                      ? undefined
                      : Effect.isEffect(value)
                        ? yield* value as any as Effect.Effect<any>
                        : undefined,
          ];
        }),
      )).filter(([, value]) => value !== undefined),
    );
  });

/**
 * Hash the vite project's input tree (root + workspaces + lockfiles) —
 * the rebuild-free change signal for the `input` hash slot.
 */
export const hashViteInput = Effect.fn(function* <E, R>(
  rootDir: string = initialCwd,
  options: ViteOptions["memo"],
  additionalWorkspaces: Effect.Effect<Iterable<string>, E, R>,
) {
  const path = yield* Path.Path;
  // Resolved once: every workspace cwd is relative to the Vite root, so
  // the root must be an absolute base. Resolving it per call and passing
  // `rootDir` as its own cwd would apply a relative root twice
  // (`path.resolve("app", "app")` → `<cwd>/app/app`), hashing a
  // directory that doesn't exist — a constant hash that never registers
  // an edit, so the deploy no-ops forever. See issue #1016. Anchored to
  // the initial cwd so a transient chdir can't skew the resolution.
  const resolvedRoot = path.resolve(initialCwd, rootDir);
  // Relative paths participate in memo hashes and surface in outputs;
  // keep them POSIX so Windows and CI agree.
  const relativeToRoot = (cwd: string) =>
    path.relative(resolvedRoot, path.resolve(resolvedRoot, cwd)).replaceAll("\\", "/");
  const hashWorkspaceDirectory = (cwd: string, memo?: MemoOptions) =>
    hashDirectory({ cwd: path.resolve(resolvedRoot, cwd), memo }).pipe(
      Effect.map((hash) => `${relativeToRoot(cwd)}:${hash}`),
    );
  // `"."` — the root itself, never re-applied on top of itself.
  const hashRoot = hashWorkspaceDirectory(".", options);
  if (Array.isArray(options?.workspaces)) {
    return yield* Effect.all(
      [
        hashRoot,
        ...options.workspaces.map(({ cwd, ...options }) => hashWorkspaceDirectory(cwd, options)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.flatMap(([root, ...workspaces]) => sha256Object([root, ...workspaces.sort()])),
      Effect.map((hash) => ({ hash, workspaces: undefined })),
    );
  }
  const [root, workspaces] = yield* Effect.all([hashRoot, additionalWorkspaces], {
    concurrency: "unbounded",
  });
  const workspaceHashes = yield* Effect.forEach(workspaces, (cwd) => hashWorkspaceDirectory(cwd), {
    concurrency: "unbounded",
  });
  const hash = yield* sha256Object([root, ...workspaceHashes.sort()]);
  return { hash, workspaces: Array.from(workspaces).map(relativeToRoot) };
});

/**
 * Source provider for vite-based workers (`props.vite`, set by
 * `Website.Vite`): the vite builder produces the client assets and the
 * server bundle in one pass; diff never builds — the `input` hash over
 * the project tree is the change signal.
 *
 * This module is the lazy-import boundary for the vite toolchain (see
 * the module note above): the dispatch in `Source.ts` dynamically
 * imports it, so its ~0.5s module cost is only paid for vite-based
 * workers.
 */
export const makeViteSource = (vite: ViteOptions): SourceProvider => ({
  ownsAssets: true,
  build: Effect.fn(function* (ctx) {
    const path = yield* Path.Path;
    const env = yield* resolveViteEnv(ctx.env ?? {}, ctx.selfUrl);
    const { clientDirectory, foldkit, base, serverBundle, externalWorkspaces } = yield* viteBuild(
      vite.rootDir,
      env,
      {
        // A relative `vite.main` is documented to resolve from the Vite
        // root. The rolldown plugin resolves the worker entry with no
        // importer (i.e. against `process.cwd()`), which breaks when the
        // deploy runs from a different directory (e.g. a monorepo infra
        // package) — absolutize before handing it over (#796).
        // A package export or virtual module (`vike:server`) goes to Vite
        // as is.
        main: vite.main
          ? yield* resolveViteMain(path.resolve(initialCwd, vite.rootDir ?? "."), vite.main)
          : undefined,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: vite.viteEnvironments,
        framework: vite.framework,
      },
      ctx.fqn,
    );
    const declaredAssets = ctx.assets && typeof ctx.assets !== "string" ? ctx.assets : undefined;
    // What the build itself says about its assets, filled in under what
    // the resource declared: a framework that records which pages it
    // prerendered knows the routing better than a default would, and the
    // resource's own `assets` still has the last word.
    const derivedAssets =
      clientDirectory && vite.framework === "foldkit"
        ? yield* Effect.promise(() => import("../../Website/FoldkitBuild.ts")).pipe(
            Effect.map(({ foldkitAssetsFromManifest }) =>
              foldkitAssetsFromManifest(foldkit?.manifest),
            ),
          )
        : undefined;
    const [assets, bundle, input] = yield* Effect.all(
      [
        clientDirectory
          ? readAssets({
              ...derivedAssets,
              ...declaredAssets,
              // `clientDirectory` from the build child is absolute; the
              // rootDir only matters as a legacy fallback.
              directory: path.resolve(initialCwd, vite.rootDir ?? ".", clientDirectory),
              // The resolved Vite `base` is what rewrote the URLs in the
              // emitted HTML, so it is the only prefix the manifest can
              // agree with.
              base,
            })
          : Effect.undefined,
        serverBundle,
        hashViteInput(vite.rootDir, vite.memo, externalWorkspaces),
      ],
      { concurrency: "unbounded" },
    );
    if (!assets && !bundle) {
      return yield* Effect.die(new Error("Vite build produced neither assets nor server output"));
    }
    return {
      bundle,
      assets,
      hash: {
        bundle: bundle?.hash,
        assets: assets?.hash,
        input: input.hash,
        additionalWorkspaces: input.workspaces,
      },
    };
  }),
  hash: Effect.fn(function* (_ctx, previous) {
    const { hash, workspaces } = yield* hashViteInput(
      vite.rootDir,
      vite.memo,
      Effect.succeed(previous?.additionalWorkspaces ?? []),
    );
    return { input: hash, additionalWorkspaces: workspaces };
  }),
  dev: Effect.fn(function* (ctx) {
    const devServer = yield* viteDev(
      vite.rootDir,
      ctx.env ?? {},
      {
        main: vite.main,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: vite.viteEnvironments,
        worker: {
          name: ctx.workerName,
          bindings: ctx.worker.bindings,
          durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
          hyperdrives: ctx.worker.hyperdrives,
          queueConsumers: yield* ctx.worker.queueConsumers,
          assets: ctx.worker.assets,
        },
        context: ctx.runtimeContext,
      },
      { port: 0 },
    );
    return {
      mode: "server",
      url: new URL(devServer.resolvedUrls!.local[0]),
    } satisfies SourceDevHandle;
  }),
});
