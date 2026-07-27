import type { NonEmptyArray } from "effect/Array";
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
type RscManifestId = keyof typeof RSC_MANIFEST;

/**
 * Structural subset of `vite.Environment` used by the bundling helpers.
 * Typed structurally rather than as `vite.Environment` so plugin hooks whose
 * `this` context is typed against a different vite copy in the install graph
 * (bun peer-variant duplication) still assign.
 */
interface EnvironmentLike {
  readonly name: string;
  readonly config: {
    readonly root: string;
    readonly build: { readonly outDir: string };
  };
}

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
  let serverEntry: string | undefined;
  const serverChunks = new Map<
    string,
    Effect.Effect<BundleFile, BundleError>
  >();
  const maybeExternalWorkspaces = new Set<string>();

  const findUp = yield* cachedFunction(
    (
      dir: string,
      filenames: Array<string>,
    ): Effect.Effect<string | undefined, PlatformError> =>
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
  const collectExternalWorkspaces = (): Effect.Effect<
    Set<string>,
    PlatformError
  > =>
    Effect.forEach(maybeExternalWorkspaces, (directory) =>
      findUp(directory, ["package.json"]),
    ).pipe(
      Effect.map(
        (paths) =>
          new Set(paths.filter((file) => file !== undefined).map(path.dirname)),
      ),
    );
  const plugin: vite.Plugin = {
    name: "alchemy:build-output",
    sharedDuringBuild: true,
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
        if (
          !path.isAbsolute(id) ||
          id.includes("node_modules") ||
          id.startsWith(root)
        ) {
          continue;
        }
        maybeExternalWorkspaces.add(path.dirname(id));
      }
      if (this.environment.name === "client") {
        clientDirectory = path.resolve(
          root,
          this.environment.config.build.outDir,
        );
        return;
      }
      const files = Object.values(bundle);
      if (this.environment.name === entryEnvironment) {
        const entryChunk = files.find(
          (file) => file.type === "chunk" && file.isEntry,
        );
        if (!entryChunk) {
          throw new Error(
            `Entry chunk not found for environment "${this.environment.name}"`,
          );
        }
        serverEntry = fileName(entryChunk.fileName, this.environment);
      }
      await Promise.all(
        files.map(async (file) => {
          if (file.type === "chunk") {
            file.imports
              .filter(
                (self): self is keyof typeof RSC_MANIFEST =>
                  self in RSC_MANIFEST,
              )
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
                  readRscManifestChunk(id, this.environment),
                );
              });
          }
          const name = fileName(file.fileName, this.environment);
          const content = file.type === "chunk" ? file.code : file.source;
          serverChunks.set(
            name,
            sha256(content).pipe(
              Effect.map((hash) => ({ path: name, content, hash })),
            ),
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
    return `${relativeOutDir}/${name}`;
  };

  // Manually read the RSC manifest chunk from the file system.
  // This is only safe to run *after* the build has completed.
  const readRscManifestChunk = (
    id: RscManifestId,
    environment: EnvironmentLike,
  ) => {
    const name = RSC_MANIFEST[id];
    return fs
      .readFile(
        path.resolve(
          environment.config.root,
          environment.config.build.outDir,
          name,
        ),
      )
      .pipe(
        Effect.flatMap((content) =>
          sha256(content).pipe(
            Effect.map(
              (hash): BundleFile => ({
                path: fileName(name, environment),
                content,
                hash,
              }),
            ),
          ),
        ),
        Effect.mapError(bundleErrorFromUnknown),
      );
  };

  const makeServerBundle = () => {
    if (!serverEntry && !serverChunks.size) return Effect.undefined;
    if (!serverEntry)
      return Effect.die(new Cause.NoSuchElementError("Missing server entry"));
    const filePaths = Array.from(serverChunks.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    const server: NonEmptyArray<Effect.Effect<BundleFile, BundleError>> = [
      getChunk(serverEntry),
    ];
    for (const filePath of filePaths) {
      if (filePath === serverEntry) continue;
      server.push(getChunk(filePath));
    }
    return Effect.all(server, { concurrency: "unbounded" }).pipe(
      Effect.flatMap(bundleOutputFromFiles),
    );
  };

  const getChunk = (path: string) => {
    const chunk = serverChunks.get(path);
    if (!chunk) {
      return Effect.die(
        new Cause.NoSuchElementError(`Chunk ${path} not found`),
      );
    }
    return chunk;
  };

  return {
    plugin,
    // Read lazily so callers observe the state collected during the build.
    // Only safe to await *after* `builder.buildApp()` has resolved.
    output: Effect.sync(
      (): ViteBuildOutput => ({
        clientDirectory,
        serverBundle: makeServerBundle(),
        externalWorkspaces: collectExternalWorkspaces(),
      }),
    ),
  };
});
