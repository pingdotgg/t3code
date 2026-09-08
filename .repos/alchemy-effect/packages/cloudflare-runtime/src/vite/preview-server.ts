import type { BindingHooks, Module } from "../core/index.ts";
import * as Runtime from "../core/Runtime.ts";
import * as RuntimeServices from "../core/RuntimeServices.ts";
import { PlatformServices } from "../Platform.ts";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import type { CloudflareVitePluginOptions } from "./plugin.ts";

/**
 * The freshly built worker a preview server hosts: which directory holds the
 * server modules, which of them is the entry, and where the client assets
 * live. Derived by the preview plugin from the resolved Vite config.
 */
export interface PreviewWorkerBuild {
  /**
   * Absolute directory containing the built server modules (the entry
   * environment's `build.outDir`). Every file under it (recursively) is
   * loaded into workerd as a module, so relative imports between chunks —
   * including nested child-environment output like waku's `server/ssr` —
   * resolve exactly as they would on the deployed worker.
   */
  readonly directory: string;
  /** The entry module's name, relative to `directory` (POSIX separators). */
  readonly entryModule: string;
  /** Absolute directory of the built client assets, if any. */
  readonly assetsDirectory?: string | undefined;
}

export interface PreviewServerHandle {
  readonly address: URL;
  readonly close: () => Promise<void>;
}

/**
 * Boot workerd (via `cloudflare-runtime`'s `Runtime.start`) over the built
 * worker output on disk. Unlike the dev server there is no module runner and
 * no module fallback: the build is self-contained, so every module is read
 * from the output directory upfront (entry first — workerd treats the first
 * module as the main module) and handed to workerd directly. Assets are
 * served by the runtime's disk-backed assets plugin from the client build
 * directory.
 *
 * When the plugin options carry no `context`, a runtime context is built
 * into the preview's own scope and torn down by `close()` — unlike the dev
 * server's process-lifetime cached context. This matters for build-time SSG
 * (waku boots a preview server mid-`buildApp`): a lingering context's open
 * handles would keep the build process alive after the build completes.
 */
export const startPreviewServer = async <B extends BindingHooks = BindingHooks>(
  options: CloudflareVitePluginOptions<B>,
  build: PreviewWorkerBuild,
): Promise<PreviewServerHandle> => {
  const scope = Scope.makeUnsafe();
  // Only sweep handles for a context we build (and tear down) ourselves; a
  // caller-provided context is process-lifetime by design (dev semantics).
  const sweep = options.context === undefined ? makeHandleSweep() : undefined;
  try {
    const context =
      options.context ??
      (await makePreviewContext().pipe(
        Layer.buildWithScope(scope),
        Effect.runPromise,
      ));
    const address = await serve(options, build).pipe(
      Effect.provide(context),
      Scope.provide(scope),
      Effect.runPromise,
    );
    return {
      address,
      close: async () => {
        await closeScope(scope);
        sweep?.();
      },
    };
  } catch (error) {
    await closeScope(scope);
    sweep?.();
    throw error;
  }
};

/**
 * Workaround for a `cloudflare-runtime` teardown gap: building the runtime
 * context spawns a detached, uninterruptible fiber (`DockerLive`) that binds
 * a Docker proxy server (`server.listen(0)`) and probes the local Docker
 * daemon with no finalizer — so a build process that booted a preview server
 * for SSG can never exit on its own, even after the runtime scope closes.
 *
 * Until the runtime tears that fiber down (or starts it lazily), snapshot
 * the process's libuv handles before the context is built and, on close,
 * `unref()` whatever appeared since and survived scope teardown. `unref` is
 * strictly about process exit: leaked handles keep working for as long as
 * the process lives, they just stop pinning the event loop. Handles we own
 * are already closed by the scope; the caller's preview http server is
 * closed by the caller immediately after, so unref-ing it is harmless.
 */
const makeHandleSweep = (): (() => void) => {
  const getHandles = (): Array<{ unref?: () => void }> => {
    const process_ = process as unknown as {
      _getActiveHandles?: () => Array<{ unref?: () => void }>;
    };
    try {
      return process_._getActiveHandles?.() ?? [];
    } catch {
      return [];
    }
  };
  const before = new Set(getHandles());
  return () => {
    for (const handle of getHandles()) {
      if (before.has(handle)) continue;
      try {
        handle.unref?.();
      } catch {
        // best-effort: exiting cleanly matters more than the odd handle
      }
    }
  };
};

const makePreviewContext = () =>
  RuntimeServices.layerRuntime({
    api: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    },
  }).pipe(
    Layer.provideMerge(PlatformServices),
    Layer.provide(Layer.merge(Credentials.fromEnv(), FetchHttpClient.layer)),
  );

const closeScope = async (scope: Scope.Scope) => {
  await Effect.runPromiseExit(
    Scope.closeUnsafe(scope, Exit.void) ?? Effect.void,
  );
};

// Deliberately non-generic: `CloudflareVitePluginOptions<BindingHooks>` is a
// supertype of every instantiation, and `BindingRequirements<BindingHooks>`
// collapses to `never`, so the effect's requirements are fully discharged by
// the provided runtime context + scope. Keeping the caller's `B` generic here
// would leave a deferred `BindingRequirements<B>` in the requirements that
// `Effect.runPromise` cannot prove away.
const serve = Effect.fn(function* (
  options: CloudflareVitePluginOptions,
  build: PreviewWorkerBuild,
) {
  const runtime = yield* Runtime.Runtime;
  const modules = yield* Effect.promise(() => readWorkerModules(build));
  const assetsDirectory =
    options.worker?.assets?.directory ?? build.assetsDirectory;
  return yield* runtime.start({
    name: options.worker?.name ?? `vite-preview-${crypto.randomUUID()}`,
    modules,
    compatibilityDate: options.compatibilityDate ?? "2026-05-12",
    compatibilityFlags: options.compatibilityFlags ?? [],
    bindings: options.worker?.bindings ?? [],
    durableObjectNamespaces: options.worker?.durableObjectNamespaces,
    hyperdrives: options.worker?.hyperdrives,
    queueConsumers: options.worker?.queueConsumers,
    assets:
      options.worker?.assets !== undefined || assetsDirectory !== undefined
        ? { ...options.worker?.assets, directory: assetsDirectory }
        : undefined,
    logging: options.worker?.logging,
    unsafe: options.worker?.unsafe,
  });
});

/**
 * Read the built server output into workerd modules, entry first. Source maps
 * are skipped; everything else is typed by extension so wasm/text/data
 * modules emitted next to the chunks keep working.
 */
export const readWorkerModules = async (
  build: PreviewWorkerBuild,
): Promise<Array<Module>> => {
  const entries = await NodeFs.readdir(build.directory, {
    recursive: true,
    withFileTypes: true,
  });
  const modules = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = NodePath.join(entry.parentPath, entry.name);
        const name = NodePath.relative(build.directory, file).replaceAll(
          "\\",
          "/",
        );
        return readWorkerModule(file, name);
      }),
  );
  const found = modules.filter(
    (module): module is Module => module !== undefined,
  );
  const entryIndex = found.findIndex(
    (module) => module.name === build.entryModule,
  );
  if (entryIndex === -1) {
    throw new Error(
      `Cannot find the worker entry module "${build.entryModule}" in "${build.directory}". ` +
        "Run the build before starting the preview server.",
    );
  }
  const [entry] = found.splice(entryIndex, 1);
  return [entry!, ...found];
};

const readWorkerModule = async (
  file: string,
  name: string,
): Promise<Module | undefined> => {
  switch (NodePath.extname(file)) {
    case ".map":
      return undefined;
    case ".js":
    case ".mjs":
      return {
        name,
        type: "ESModule",
        content: await NodeFs.readFile(file, "utf8"),
      };
    case ".cjs":
      return {
        name,
        type: "CommonJsModule",
        content: await NodeFs.readFile(file, "utf8"),
      };
    case ".json":
      return {
        name,
        type: "Json",
        content: await NodeFs.readFile(file, "utf8"),
      };
    case ".txt":
    case ".html":
    case ".css":
    case ".sql":
      return {
        name,
        type: "Text",
        content: await NodeFs.readFile(file, "utf8"),
      };
    case ".wasm":
      return {
        name,
        type: "Wasm",
        content: new Uint8Array(await NodeFs.readFile(file)),
      };
    default:
      return {
        name,
        type: "Data",
        content: new Uint8Array(await NodeFs.readFile(file)),
      };
  }
};
