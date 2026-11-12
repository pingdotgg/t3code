import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as vite from "vite";
import { cachedFunction } from "../Util/cached-function.ts";
import { sha256 } from "../Util/index.ts";
import {
  BundleError,
  bundleErrorFromUnknown,
  bundleOutputFromFiles,
  type BundleFile,
  type BundleOutput,
} from "./Bundle.ts";

export interface ViteBuildOutput {
  readonly clientDirectory: string | undefined;
  /**
   * The client environment's resolved Vite `base`. The build rewrites
   * every emitted asset URL with it, so the uploaded asset manifest must
   * be keyed with the same prefix to agree with the HTML.
   */
  readonly base: string | undefined;
  // This is emitted as an Effect instead of a value so we can process it in parallel with reading the client assets.
  readonly serverBundle: Effect.Effect<BundleOutput | undefined, BundleError>;
  readonly externalWorkspaces: Effect.Effect<Set<string>, PlatformError>;
}

// `@vitejs/plugin-rsc` writes these modules separately after build completes instead of emitting them as chunks.
// So, we need to detect them and read them from the file system manually.
const RSC_MANIFEST = {
  "virtual:vite-rsc/assets-manifest": "__vite_rsc_assets_manifest.js",
  "virtual:vite-rsc/environment-imports": "__vite_rsc_env_imports_manifest.js",
} as const;

/**
 * Structural subset of `vite.Environment` used by the bundling helpers.
 * Typed structurally rather than as `vite.Environment` so plugin hooks whose
 * `this` context is typed against a different vite copy in the install graph
 * (bun peer-variant duplication) still assign.
 */
interface EnvironmentLike {
  readonly name: string;
  readonly config: {
    readonly base: string;
    readonly root: string;
    readonly build: { readonly outDir: string };
  };
}

/** Whether `directory` exists and is not empty. */
const isNonEmptyDirectory = Effect.fn(function* (
  fs: FileSystem.FileSystem,
  directory: string | undefined,
) {
  if (!directory || !(yield* fs.exists(directory))) return false;
  return (yield* fs.readDirectory(directory)).length > 0;
});

/**
 * A Vite plugin that collects the output of the build and makes it available as an Effect.
 * @param entryEnvironment - The environment to use as the entry point for the server bundle. Defaults to "ssr".
 */
export const viteBuildOutputPlugin = Effect.fn(function* ({
  entryEnvironment = "ssr",
}: {
  entryEnvironment?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let clientDirectory: string | undefined;
  let base: string | undefined;
  // Where the client build writes, and the `public/` it would copy. Read from
  // the resolved config because the client environment may never build.
  let clientOutDir: string | undefined;
  let publicDir: string | undefined;
  // Assets the entry environment imports by URL (`import url from
  // "./logo.png"`), keyed by output file name. They belong with the static
  // assets, not in the Worker bundle.
  const importedAssets = new Map<string, string>();
  let serverEntry: string | undefined;
  // `undefined` for an output a plugin removed after writing it (Vike deletes
  // its `.vite/manifest.json`): it isn't deployed, as with Wrangler.
  const serverChunks = new Map<string, Effect.Effect<BundleFile | undefined, BundleError>>();
  const maybeExternalWorkspaces = new Set<string>();

  const findUp = yield* cachedFunction(
    (dir: string, filenames: Array<string>): Effect.Effect<string | undefined, PlatformError> =>
      Effect.filter(
        filenames.map((filename) => path.join(dir, filename)),
        fs.exists,
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(([match]) => {
          if (match) {
            return Effect.succeed(match);
          }
          const parent = path.dirname(dir);
          if (parent === dir) {
            return Effect.undefined;
          }
          return findUp(parent, filenames);
        }),
      ),
  );
  const collectExternalWorkspaces = (): Effect.Effect<Set<string>, PlatformError> =>
    Effect.forEach(maybeExternalWorkspaces, (directory) =>
      findUp(directory, ["package.json"]),
    ).pipe(
      Effect.map((paths) => new Set(paths.filter((file) => file !== undefined).map(path.dirname))),
    );
  const plugin: vite.Plugin = {
    name: "alchemy:build-output",
    sharedDuringBuild: true,
    configResolved(config) {
      const outDir = config.environments?.client?.build.outDir;
      clientOutDir = outDir === undefined ? undefined : path.resolve(config.root, outDir);
      publicDir = config.publicDir || undefined;
    },
    // Collect the client output directory and server chunks as each
    // environment writes its bundle. We deliberately do NOT resolve the build
    // result from a `buildApp` hook: on Vite 8, when a project declares no
    // `builder.buildApp` (e.g. a plain client-only SPA), `builder.buildApp()`
    // runs post-order `buildApp` hooks *before* the default environment builds,
    // so a hook fires while the output is still empty (issue #792). Instead,
    // `viteBuild` reads `output` *after* `builder.buildApp()` resolves — by
    // which point every environment that actually built has run `writeBundle`.
    async writeBundle(_, bundle) {
      const root = path.resolve(this.environment.config.root);
      for (const id of this.getModuleIds()) {
        if (!path.isAbsolute(id) || id.includes("node_modules") || id.startsWith(root)) {
          continue;
        }
        maybeExternalWorkspaces.add(path.dirname(id));
      }
      if (this.environment.name === "client") {
        clientDirectory = path.resolve(root, this.environment.config.build.outDir);
        base = this.environment.config.base;
        return;
      }
      const files = Object.values(bundle);
      if (this.environment.name === entryEnvironment) {
        // Frameworks can add entries of their own (Vike's export-less
        // `entry.mjs`), so prefer the `index` entry the Cloudflare plugin
        // names the Worker, then one with exports.
        const entryChunks = files.filter(
          (file): file is vite.Rolldown.OutputChunk => file.type === "chunk" && file.isEntry,
        );
        const entryChunk =
          entryChunks.find((chunk) => chunk.name === "index") ??
          entryChunks.find((chunk) => chunk.exports.length > 0) ??
          entryChunks[0];
        if (!entryChunk) {
          throw new Error(`Entry chunk not found for environment "${this.environment.name}"`);
        }
        serverEntry = fileName(entryChunk.fileName, this.environment);
      }
      const outDir = path.resolve(root, this.environment.config.build.outDir);
      const urlAssets = new Set<string>();
      for (const file of files) {
        if (file.type !== "chunk" || this.environment.name !== entryEnvironment) continue;
        const metadata = (file as { viteMetadata?: { importedAssets?: Set<string> } }).viteMetadata;
        for (const asset of metadata?.importedAssets ?? []) {
          urlAssets.add(asset);
          importedAssets.set(asset, path.join(outDir, asset));
        }
      }
      await Promise.all(
        files.map(async (file) => {
          if (file.type === "asset" && urlAssets.has(file.fileName)) return;
          // Vite's build metadata (`.vite/manifest.json`), not a Worker module.
          if (file.fileName.startsWith(".vite/")) return;
          if (file.type === "chunk") {
            file.imports
              .filter((self): self is keyof typeof RSC_MANIFEST => self in RSC_MANIFEST)
              .forEach((id) => {
                // Key by the environment-prefixed path, NOT the bare manifest
                // filename. `@vitejs/plugin-rsc` emits a copy of the same-named
                // manifest into every environment's outDir (e.g. both
                // `dist/rsc/__vite_rsc_assets_manifest.js` and
                // `dist/ssr/__vite_rsc_assets_manifest.js`), and each
                // environment's chunks import their own copy via a relative
                // specifier. Keying by the bare filename collapses them into a
                // single entry, dropping every copy but the last — so the
                // entry worker's `import "../__vite_rsc_assets_manifest.js"`
                // resolves to a module that isn't in the bundle and the
                // deployed Worker fails at startup.
                serverChunks.set(
                  fileName(RSC_MANIFEST[id], this.environment),
                  readOutputFile(RSC_MANIFEST[id], this.environment),
                );
              });
          }
          // Read back from disk once the build completes, as Wrangler deploys
          // the output directory: plugins can rewrite written chunks in their
          // own `writeBundle` (Vike inlines its assets manifest there).
          serverChunks.set(
            fileName(file.fileName, this.environment),
            readOutputFile(file.fileName, this.environment),
          );
        }),
      );
    },
  };

  // The server bundle may include chunks from more than one Vite environment, so we need to prefix them with the environment-specific output directory.
  // Flattening them doesn't work because of relative imports between environments.
  //
  // `build.outDir` can be resolved to an absolute path (e.g. `@vitejs/plugin-rsc`
  // does this), which would leak the build machine's filesystem path into the
  // worker module names and produce non-portable, leading-`/` specifiers that
  // Cloudflare rejects. Normalize it back to a path relative to the project root
  // so module names match the single-environment case (`dist/ssr/worker.js`).
  const fileName = (name: string, environment: EnvironmentLike) => {
    const outDir = environment.config.build.outDir;
    const relativeOutDir = path.isAbsolute(outDir)
      ? path.relative(environment.config.root, outDir)
      : outDir;
    // `path.relative` (and user-configured outDirs) yield backslashes on
    // Windows; worker module names are import specifiers, so a name like
    // `dist\ssr/index.js` deploys fine but can never be resolved by the
    // entry's `import "ssr/index.js"` — the worker 1101s at request time.
    return `${relativeOutDir.replaceAll("\\", "/")}/${name}`;
  };

  // Read an output file from the file system.
  // This is only safe to run *after* the build has completed.
  const readOutputFile = (name: string, environment: EnvironmentLike) => {
    const file = path.resolve(environment.config.root, environment.config.build.outDir, name);
    return fs.exists(file).pipe(
      Effect.flatMap((exists) => (exists ? readFile(file, name, environment) : Effect.undefined)),
      Effect.mapError(bundleErrorFromUnknown),
    );
  };

  const readFile = (file: string, name: string, environment: EnvironmentLike) =>
    fs.readFile(file).pipe(
      Effect.flatMap((content) =>
        sha256(content).pipe(
          Effect.map((hash): BundleFile => ({
            path: fileName(name, environment),
            content,
            hash,
          })),
        ),
      ),
      Effect.mapError(bundleErrorFromUnknown),
    );

  const makeServerBundle = () => {
    if (!serverEntry && !serverChunks.size) return Effect.undefined;
    if (!serverEntry) return Effect.die(new Cause.NoSuchElementError("Missing server entry"));
    const filePaths = Array.from(serverChunks.keys()).sort((a, b) => a.localeCompare(b));
    const entry = getChunk(serverEntry).pipe(
      Effect.flatMap((file) =>
        file
          ? Effect.succeed(file)
          : Effect.die(new Cause.NoSuchElementError(`Chunk ${serverEntry} not found`)),
      ),
    );
    const rest = filePaths
      .filter((filePath) => filePath !== serverEntry)
      .map((filePath) => getChunk(filePath));
    return Effect.all([entry, ...rest], { concurrency: "unbounded" }).pipe(
      Effect.flatMap(([entryFile, ...files]) =>
        bundleOutputFromFiles([
          entryFile,
          ...files.filter((file): file is BundleFile => file !== undefined),
        ]),
      ),
    );
  };

  // Mirrors `@cloudflare/vite-plugin`: assets the Worker imports move to the
  // client output. Without a client build (no `index.html`), Vite never copies
  // `public/` (the Worker builds with `copyPublicDir: false`), so the client
  // output is created from `public/` plus those assets, as the plugin's
  // fallback client build does.
  const collectAssets = Effect.fn(function* () {
    let directory = clientDirectory;
    if (directory === undefined) {
      const hasPublic = yield* isNonEmptyDirectory(fs, publicDir);
      if (clientOutDir === undefined || (!hasPublic && importedAssets.size === 0)) {
        return undefined;
      }
      directory = clientOutDir;
      yield* fs.remove(directory, { recursive: true, force: true });
      yield* fs.makeDirectory(directory, { recursive: true });
      if (hasPublic) yield* fs.copy(publicDir!, directory);
    }
    for (const [asset, source] of importedAssets) {
      const destination = path.join(directory, asset);
      if (yield* fs.exists(destination)) continue;
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.copyFile(source, destination);
    }
    return directory;
  });

  const getChunk = (path: string) => {
    const chunk = serverChunks.get(path);
    if (!chunk) {
      return Effect.die(new Cause.NoSuchElementError(`Chunk ${path} not found`));
    }
    return chunk;
  };

  return {
    plugin,
    // Read lazily so callers observe the state collected during the build.
    // Only safe to await *after* `builder.buildApp()` has resolved.
    output: Effect.gen(function* () {
      const assetsDirectory = yield* collectAssets();
      return {
        clientDirectory: assetsDirectory,
        base,
        serverBundle: makeServerBundle(),
        externalWorkspaces: collectExternalWorkspaces(),
      };
    }),
  };
});
