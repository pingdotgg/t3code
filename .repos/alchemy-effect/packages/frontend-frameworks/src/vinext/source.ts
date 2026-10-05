/**
 * `@alchemy.run/frontend-frameworks/vinext/source` — alchemy Worker
 * source provider for vinext. Implements the `WorkerSourceModule`
 * contract structurally (no alchemy import).
 *
 * `build()` runs Vite's `createBuilder` in a child process with
 * `@alchemy.run/cloudflare-runtime/vite` injected (the
 * `vite-plugin-cloudflare:alchemy` presence plugin), then vinext prerender
 * and a platform-agnostic cache seed (`putText` into KV HTTP).
 * `hash()` is a project-tree memo. `dev()` is Vite's own server with
 * the same plugin stack.
 */
import cloudflare from "@alchemy.run/cloudflare-runtime/vite";
import type {
  BindingHook,
  BindingServices,
  HyperdriveOrigin,
  Assets as RuntimeAssets,
  DurableObjectNamespace as RuntimeDurableObject,
  QueueConsumer as RuntimeQueueConsumer,
  RuntimeServices,
} from "@alchemy.run/cloudflare-runtime/core";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";
import { createRequire } from "node:module";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { resolveViteDevPort } from "../core/DevPort.ts";
import { runBuildChild } from "../core/BuildChild.ts";
import { toOutputFile, type BuildOutput } from "../core/BuildOutput.ts";
import { ModuleLoadError } from "../core/Loader.ts";
import {
  ALCHEMY_CLOUDFLARE_VITE_INJECTED,
  DEFAULT_WORKER_ENTRY,
  makeVinextPluginOptions,
} from "./cloudflare.ts";
import {
  VINEXT_CACHE_BINDING,
  VINEXT_KV_CACHE_BINDING,
} from "./PrerenderCache.ts";
import {
  resolveVinextRoot,
  runVinextPrerenderIfConfigured,
} from "./Prerender.ts";
import { kvHttpNamespaceFromEnv, kvHttpSink } from "./cache/kv-http.ts";
import { makeVinextCachePlugin } from "./cache/plugin.ts";
import { seedPrerenderTo } from "./cache/seed.ts";

const PROVIDER = "@alchemy.run/frontend-frameworks/vinext/source";

const VINEXT_SERVER_ENTRIES = [
  "dist/server/index.js",
  "dist/server/ssr/index.js",
] as const;

const RSC_MANIFEST = {
  "virtual:vite-rsc/assets-manifest": "__vite_rsc_assets_manifest.js",
  "virtual:vite-rsc/environment-imports": "__vite_rsc_env_imports_manifest.js",
} as const;

const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

// ─────────────────────────────────────────────────────────────────────
// Structural mirror of alchemy's Worker source contract
// ─────────────────────────────────────────────────────────────────────

export interface SourceHash {
  readonly bundle: string | undefined;
  readonly assets: string | undefined;
  readonly input: string | undefined;
  readonly additionalWorkspaces: Array<string> | undefined;
}

export interface BundleFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly hash: string;
}

export interface BundleOutput {
  readonly files: [BundleFile, ...Array<BundleFile>];
  readonly hash: string;
}

export interface AssetReadResult {
  directory: string;
  config: Record<string, unknown> | undefined;
  manifest: Record<string, { hash: string; size: number }>;
  _headers: string | undefined;
  _redirects: string | undefined;
  hash: string;
}

export interface SourceBuildOutput {
  readonly bundle: BundleOutput | undefined;
  readonly assets: AssetReadResult | undefined;
  readonly hash: SourceHash;
}

export interface SourceContext {
  readonly id: string;
  readonly workerName: string;
  readonly compatibility: {
    readonly date: string;
    readonly flags: Array<string>;
  };
  readonly entry:
    | { readonly kind: "external" }
    | { readonly kind: "effect"; readonly exports: Record<string, unknown> };
  readonly stack: { readonly name: string; readonly stage: string };
  readonly env: Record<string, unknown> | undefined;
  readonly extraOptions: unknown;
  readonly assets: unknown;
}

export interface DevContext extends SourceContext {
  readonly worker: {
    readonly bindings: Array<BindingHook<BindingServices>>;
    readonly durableObjectNamespaces: Array<
      RuntimeDurableObject & { uniqueKey: string }
    >;
    readonly hyperdrives: Record<string, Required<HyperdriveOrigin>>;
    readonly queueConsumers: Effect.Effect<Array<RuntimeQueueConsumer>>;
    readonly assets: RuntimeAssets | undefined;
  };
  readonly runtimeContext: Context.Context<RuntimeServices>;
}

export interface ServerDevHandle {
  readonly mode: "server";
  readonly url: URL;
}

export class SourceProviderError extends Data.TaggedError(
  "Cloudflare.Workers.SourceProviderError",
)<{
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type VinextSourceError =
  | SourceProviderError
  | PlatformError
  | ModuleLoadError;
export type SourceRequirements = FileSystem.FileSystem | Path.Path;

export interface SourceProvider {
  readonly ownsAssets: boolean;
  readonly build: (
    ctx: SourceContext,
  ) => Effect.Effect<SourceBuildOutput, VinextSourceError, SourceRequirements>;
  readonly hash: (
    ctx: SourceContext,
    previous: SourceHash | undefined,
  ) => Effect.Effect<
    Partial<SourceHash>,
    VinextSourceError,
    SourceRequirements
  >;
  readonly dev: (
    ctx: DevContext,
  ) => Effect.Effect<
    ServerDevHandle,
    VinextSourceError,
    SourceRequirements | Scope.Scope
  >;
}

export interface VinextMemoOptions {
  readonly include?: Array<string> | undefined;
  readonly exclude?: Array<string> | undefined;
  readonly lockfile?: boolean | undefined;
}

export interface VinextSourceOptions {
  readonly rootDir?: string | undefined;
  readonly main?: string | undefined;
  readonly memo?: VinextMemoOptions | undefined;
  readonly viteEnvironments?: {
    readonly entry?: string;
    readonly children?: ReadonlyArray<string>;
  };
}

export interface VinextBuildChildConfig {
  readonly rootDir: string;
  readonly main: string | undefined;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly viteEnvironments:
    | { entry?: string; children?: ReadonlyArray<string> }
    | undefined;
}

const sha256 = (input: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(input).digest("hex");

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (
    value !== null &&
    typeof value === "object" &&
    value.constructor === Object
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
};

const sha256Object = (value: unknown): string =>
  sha256(JSON.stringify(stableValue(value)));

const isBindingMarker = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "~alchemy/Kind" in value;

// ─────────────────────────────────────────────────────────────────────
// Hash / assets (same contract as waku/source)
// ─────────────────────────────────────────────────────────────────────

const LOCKFILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const escapeRegExpChar = (char: string): string =>
  /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;

const globBodyToRegExpSource = (glob: string): string => {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:[^/]+/)*";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += escapeRegExpChar(char);
      i += 1;
    }
  }
  return source;
};

const compileIgnoreRule = (raw: string): RegExp | undefined => {
  let rule = raw.trim();
  if (rule.length === 0 || rule.startsWith("#") || rule.startsWith("!")) {
    return undefined;
  }
  if (rule.endsWith("/")) rule = rule.slice(0, -1);
  if (rule.length === 0) return undefined;
  const anchored = rule.includes("/");
  if (rule.startsWith("/")) rule = rule.slice(1);
  const body = globBodyToRegExpSource(rule);
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${body}(?:/.*)?$`);
};

const compileIgnoreRules = (rules: ReadonlyArray<string>): Array<RegExp> =>
  rules
    .map(compileIgnoreRule)
    .filter((regex): regex is RegExp => regex !== undefined);

const compileIncludeGlobs = (globs: ReadonlyArray<string>): Array<RegExp> =>
  globs.map((glob) => new RegExp(`^${globBodyToRegExpSource(glob)}$`));

const matchesAny = (regexes: ReadonlyArray<RegExp>, path: string): boolean =>
  regexes.some((regex) => regex.test(path));

const findUp = Effect.fn(function* (
  startDir: string,
  filenames: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = startDir;
  for (;;) {
    for (const filename of filenames) {
      const candidate = path.join(dir, filename);
      if (yield* fs.exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
});

const readGitIgnoreRules = Effect.fn(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const chain: Array<Array<string>> = [];
  let dir = rootDir;
  for (;;) {
    const gitignore = path.join(dir, ".gitignore");
    if (yield* fs.exists(gitignore)) {
      chain.unshift((yield* fs.readFileString(gitignore)).split("\n"));
    }
    if (yield* fs.exists(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain.flat();
});

interface ResolvedMemo {
  readonly include: Array<RegExp> | undefined;
  readonly exclude: Array<RegExp>;
  readonly lockfile: boolean;
}

const resolveMemo = Effect.fn(function* (
  rootDir: string,
  distDir: string,
  memo: VinextMemoOptions | undefined,
) {
  const exclude =
    memo?.exclude !== undefined
      ? compileIgnoreRules(memo.exclude)
      : compileIgnoreRules(yield* readGitIgnoreRules(rootDir));
  return {
    include:
      memo?.include !== undefined
        ? compileIncludeGlobs(memo.include)
        : undefined,
    exclude: [
      ...compileIgnoreRules(["node_modules", ".git", `/${distDir}`]),
      ...exclude,
    ],
    lockfile: memo?.lockfile ?? !(memo?.include || memo?.exclude),
  } satisfies ResolvedMemo;
});

const hashDirectory = Effect.fn(function* (
  rootDir: string,
  memo: ResolvedMemo,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const walk: (dir: string, rel: string) => Effect.Effect<void, PlatformError> =
    Effect.fn(function* (dir: string, rel: string) {
      const entries = (yield* fs.readDirectory(dir)).sort();
      for (const entry of entries) {
        const relPath = rel === "" ? entry : `${rel}/${entry}`;
        if (matchesAny(memo.exclude, relPath)) continue;
        const absPath = path.join(dir, entry);
        const stat = yield* fs.stat(absPath);
        if (stat.type === "Directory") {
          yield* walk(absPath, relPath);
        } else if (stat.type === "File") {
          if (
            memo.include !== undefined &&
            !matchesAny(memo.include, relPath)
          ) {
            continue;
          }
          files.push(relPath);
        }
      }
    });
  yield* walk(rootDir, "");
  if (memo.lockfile) {
    const lockfile = yield* findUp(rootDir, LOCKFILE_NAMES);
    if (lockfile !== undefined) {
      const relative = path.relative(rootDir, lockfile).replaceAll("\\", "/");
      if (!files.includes(relative)) files.push(relative);
    }
  }
  const hashes = yield* Effect.forEach(
    files.sort(),
    Effect.fn(function* (file) {
      return `${file}:${sha256(yield* fs.readFile(path.join(rootDir, file)))}`;
    }),
    { concurrency: 16 },
  );
  return sha256Object(hashes);
});

const hashVinextInput = Effect.fn(function* (params: {
  rootDir: string;
  memo: VinextMemoOptions | undefined;
  options: VinextSourceOptions;
  workspaces: Iterable<string>;
}) {
  const path = yield* Path.Path;
  const memo = yield* resolveMemo(params.rootDir, "dist", params.memo);
  const workspaceMemo = yield* resolveMemo(params.rootDir, "dist", undefined);
  const [root, ...workspaceHashes] = yield* Effect.all(
    [
      hashDirectory(params.rootDir, memo),
      ...Array.from(params.workspaces).map((workspace) =>
        Effect.gen(function* () {
          const resolved = path.resolve(params.rootDir, workspace);
          const rules = yield* readGitIgnoreRules(resolved);
          const hash = yield* hashDirectory(resolved, {
            ...workspaceMemo,
            exclude: [...workspaceMemo.exclude, ...compileIgnoreRules(rules)],
          });
          return `${path.relative(params.rootDir, resolved).replaceAll("\\", "/")}:${hash}`;
        }),
      ),
    ],
    { concurrency: 4 },
  );
  return {
    hash: sha256Object({
      version: PACKAGE_VERSION,
      root,
      workspaces: workspaceHashes.sort(),
      options: {
        main: params.options.main,
        viteEnvironments: params.options.viteEnvironments,
      },
    }),
    workspaces: Array.from(params.workspaces).map((workspace) =>
      path
        .relative(params.rootDir, path.resolve(params.rootDir, workspace))
        .replaceAll("\\", "/"),
    ),
  };
});

const SPECIAL_ASSET_FILES = [".assetsignore", "_headers", "_redirects"];

const maybeReadString = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );
});

const readClientAssets = Effect.fn(function* (
  directory: string,
  config: Record<string, unknown> | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [entries, ignoreFile, _headers, _redirects] = yield* Effect.all([
    fs.readDirectory(directory, { recursive: true }),
    maybeReadString(path.join(directory, ".assetsignore")),
    maybeReadString(path.join(directory, "_headers")),
    maybeReadString(path.join(directory, "_redirects")),
  ]);
  const ignores = compileIgnoreRules([
    ...SPECIAL_ASSET_FILES,
    ...(ignoreFile?.split("\n") ?? []),
  ]);
  const manifest = new Map<string, { hash: string; size: number }>();
  yield* Effect.forEach(
    entries,
    Effect.fn(function* (name) {
      const relPath = name.replaceAll("\\", "/");
      if (matchesAny(ignores, relPath)) return;
      const file = path.join(directory, name);
      const stat = yield* fs.stat(file);
      if (stat.type !== "File") return;
      const content = yield* fs.readFile(file);
      manifest.set(relPath.startsWith("/") ? relPath : `/${relPath}`, {
        hash: sha256(content).slice(0, 32),
        size: Number(stat.size),
      });
    }),
    { concurrency: 16 },
  );
  const sortedManifest = Object.fromEntries(
    Array.from(manifest.entries()).sort((a, b) => a[0].localeCompare(b[0])),
  );
  return {
    directory,
    config,
    manifest: sortedManifest,
    _headers,
    _redirects,
    hash: sha256Object({
      config,
      manifest: sortedManifest,
      _headers,
      _redirects,
    }),
  } satisfies AssetReadResult;
});

const assetsConfigOf = (
  assets: unknown,
): Record<string, unknown> | undefined => {
  if (assets === undefined || assets === null || typeof assets !== "object") {
    return undefined;
  }
  const {
    directory: _d,
    hash: _h,
    ...config
  } = assets as Record<string, unknown>;
  return Object.keys(config).length > 0 ? config : undefined;
};

// ─────────────────────────────────────────────────────────────────────
// Vite createBuilder + output collection
// ─────────────────────────────────────────────────────────────────────

type ViteModule = typeof import("vite");

const loadVite = async (projectRoot: string): Promise<ViteModule> => {
  try {
    const require = createRequire(nodePath.join(projectRoot, "package.json"));
    return await import(
      /* @vite-ignore */ pathToFileURL(require.resolve("vite")).href
    );
  } catch {
    return await import("vite");
  }
};

const getDefine = (env: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, raw]) => {
      if (!key.startsWith("VITE_")) return [];
      const value = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
      return [[`import.meta.env.${key}`, JSON.stringify(value)] as const];
    }),
  );

const relativeJsImports = (code: string): readonly string[] => {
  const specs = new Set<string>();
  for (const match of code.matchAll(
    /(?:from|import)\s*["'](\.\.?\/[^"']+\.js)["']/g,
  )) {
    specs.add(match[1]!);
  }
  return [...specs];
};

interface EnvironmentLike {
  readonly name: string;
  readonly config: {
    readonly base: string;
    readonly root: string;
    readonly build: { readonly outDir: string };
  };
}

const makeOutputCollector = (entryEnvironment: string) => {
  let clientDirectory: string | undefined;
  let serverEntry: string | undefined;
  const serverChunks = new Map<string, { content: string | Uint8Array }>();
  const maybeExternalWorkspaces = new Set<string>();

  const fileName = (name: string, environment: EnvironmentLike) => {
    const outDir = environment.config.build.outDir;
    const relativeOutDir = nodePath.isAbsolute(outDir)
      ? nodePath.relative(environment.config.root, outDir)
      : outDir;
    return `${relativeOutDir.replaceAll("\\", "/")}/${name}`;
  };

  const plugin = {
    name: "alchemy:vinext-build-output",
    sharedDuringBuild: true,
    async writeBundle(
      this: {
        environment: EnvironmentLike;
        getModuleIds: () => Iterable<string>;
      },
      _opts: unknown,
      bundle: Record<
        string,
        {
          type: string;
          fileName: string;
          isEntry?: boolean;
          code?: string;
          source?: string | Uint8Array;
          imports?: Array<string>;
        }
      >,
    ) {
      const root = nodePath.resolve(this.environment.config.root);
      for (const id of this.getModuleIds()) {
        if (
          !nodePath.isAbsolute(id) ||
          id.includes("node_modules") ||
          id.startsWith(root)
        ) {
          continue;
        }
        maybeExternalWorkspaces.add(nodePath.dirname(id));
      }
      if (this.environment.name === "client") {
        clientDirectory = nodePath.resolve(
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
        if (entryChunk) {
          serverEntry = fileName(entryChunk.fileName, this.environment);
        }
      }
      for (const file of files) {
        if (file.type === "chunk") {
          for (const spec of file.imports ?? []) {
            if (spec in RSC_MANIFEST) {
              const manifest = RSC_MANIFEST[spec as keyof typeof RSC_MANIFEST];
              serverChunks.set(fileName(manifest, this.environment), {
                content: "",
              });
            }
          }
        }
        const name = fileName(file.fileName, this.environment);
        const content =
          file.type === "chunk" ? (file.code ?? "") : (file.source ?? "");
        serverChunks.set(name, { content });
      }
    },
  };

  return {
    plugin,
    snapshot: () => ({
      clientDirectory,
      serverEntry,
      serverChunks,
      externalWorkspaces: maybeExternalWorkspaces,
    }),
  };
};

const readRscManifestsFromDisk = Effect.fn(function* (
  root: string,
  chunks: Map<string, { content: string | Uint8Array }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [name, chunk] of chunks) {
    if (chunk.content !== "") continue;
    const filePath = path.join(root, name);
    if (yield* fs.exists(filePath)) {
      chunks.set(name, { content: yield* fs.readFile(filePath) });
    } else {
      chunks.delete(name);
    }
  }
});

const syncVinextServerModules = Effect.fn(function* (
  root: string,
  chunks: Map<string, { content: string | Uint8Array }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pending: string[] = [...VINEXT_SERVER_ENTRIES];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const bundlePath = pending.pop()!;
    if (seen.has(bundlePath)) continue;
    seen.add(bundlePath);
    const filePath = path.join(root, bundlePath);
    if (!(yield* fs.exists(filePath))) continue;
    const content = yield* fs.readFileString(filePath);
    chunks.set(bundlePath, { content });
    const dir = nodePath.posix.dirname(bundlePath);
    for (const spec of relativeJsImports(content)) {
      const next = nodePath.posix.normalize(nodePath.posix.join(dir, spec));
      if (!next.startsWith("dist/server/") || chunks.has(next)) continue;
      pending.push(next);
    }
  }
});

const collectExternalWorkspaces = Effect.fn(function* (dirs: Iterable<string>) {
  const path = yield* Path.Path;
  const found = yield* Effect.forEach(
    dirs,
    (directory) =>
      findUp(directory, ["package.json"]).pipe(
        Effect.map((file) =>
          file !== undefined ? path.dirname(file) : undefined,
        ),
      ),
    { concurrency: "unbounded" },
  );
  return new Set(found.filter((dir): dir is string => dir !== undefined));
});

/**
 * Child-process vinext production build. `runBuildChild` sets cwd to the
 * project root before importing this module.
 */
export const buildInChild = (config: VinextBuildChildConfig) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = path.resolve(config.rootDir);
    process.env[ALCHEMY_CLOUDFLARE_VITE_INJECTED] = "1";
    const cachePlugin = yield* makeVinextCachePlugin(root, "kv");
    const pluginOptions = makeVinextPluginOptions({
      root,
      main: config.main,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      viteEnvironments: config.viteEnvironments,
    });
    const collector = makeOutputCollector(
      pluginOptions.viteEnvironments?.entry ?? "rsc",
    );
    const vite = yield* Effect.promise(() => loadVite(root));
    yield* Effect.promise(async () => {
      const builder = await vite.createBuilder(
        {
          root,
          plugins: [
            cachePlugin,
            cloudflare(pluginOptions),
            collector.plugin as never,
          ],
          logLevel: "warn",
        },
        null,
      );
      await builder.buildApp();
    });
    yield* runVinextPrerenderIfConfigured(root);
    const snap = collector.snapshot();
    yield* readRscManifestsFromDisk(root, snap.serverChunks);
    yield* syncVinextServerModules(root, snap.serverChunks);
    if (snap.serverChunks.size === 0) {
      return {
        distDirectory: path.join(root, "dist"),
        clientDirectory: snap.clientDirectory,
        serverModules: undefined,
        externalWorkspaces: yield* collectExternalWorkspaces(
          snap.externalWorkspaces,
        ),
      } satisfies BuildOutput;
    }
    const names = Array.from(snap.serverChunks.keys()).sort((a, b) => {
      if (a === snap.serverEntry) return -1;
      if (b === snap.serverEntry) return 1;
      return a.localeCompare(b);
    });
    const serverModules = yield* Effect.forEach(names, (name) => {
      const chunk = snap.serverChunks.get(name)!;
      return toOutputFile(name, chunk.content);
    });
    return {
      distDirectory: path.join(root, "dist"),
      clientDirectory: snap.clientDirectory,
      serverModules,
      externalWorkspaces: yield* collectExternalWorkspaces(
        snap.externalWorkspaces,
      ),
    } satisfies BuildOutput;
  });

const resolveVinextCacheEnv = (env: Record<string, unknown>) =>
  Effect.gen(function* () {
    const resolved = { ...env };
    for (const key of [VINEXT_KV_CACHE_BINDING, VINEXT_CACHE_BINDING]) {
      const value = env[key];
      if (value == null || isBindingMarker(value)) continue;
      resolved[key] = Effect.isEffect(value)
        ? yield* value as Effect.Effect<unknown>
        : value;
    }
    return resolved;
  });

/**
 * Same `seedPrerenderTo(sink.putText)` as Redis / S3. The Worker provider
 * layer supplies the distilled KV HTTP client. Closed as `Effect<void>`
 * so the source contract stays `SourceRequirements`.
 */
const seedVinextPrerenderCache = (
  rootDir: string,
  env: Record<string, unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const namespace = kvHttpNamespaceFromEnv(env);
    if (namespace === undefined) return;
    const path = yield* Path.Path;
    yield* seedPrerenderTo(kvHttpSink(namespace), {
      rootDir: path.resolve(rootDir),
      label: "Cloudflare KV",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SourceProviderError({
            provider: PROVIDER,
            message: "Failed to seed the vinext prerender cache.",
            cause,
          }),
      ),
    );
  }) as Effect.Effect<void>;

export const makeVinextSourceProvider = (
  options: VinextSourceOptions,
): SourceProvider => {
  const rootDirOf = (path: Path.Path): string =>
    options.rootDir !== undefined
      ? path.resolve(options.rootDir)
      : process.cwd();

  return {
    ownsAssets: true,
    build: Effect.fn(function* (ctx) {
      const path = yield* Path.Path;
      const rootDir = rootDirOf(path);
      const output = yield* runBuildChild({
        runtime: "node",
        module: import.meta.url,
        rootDir,
        framework: "vinext",
        config: {
          rootDir,
          main: options.main,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          viteEnvironments: options.viteEnvironments,
        } satisfies VinextBuildChildConfig,
      }).pipe(
        Effect.mapError(
          (error) =>
            new SourceProviderError({
              provider: PROVIDER,
              message: "vinext build failed",
              cause: error.cause ?? error,
            }),
        ),
      );
      if (
        output.serverModules === undefined ||
        output.serverModules.length === 0
      ) {
        return yield* Effect.fail(
          new SourceProviderError({
            provider: PROVIDER,
            message: "vinext build produced no server modules",
          }),
        );
      }
      const files = output.serverModules.map((file) => ({
        path: file.name.replaceAll("\\", "/"),
        content: file.content,
        hash: file.hash,
      })) as [BundleFile, ...Array<BundleFile>];
      const bundle: BundleOutput = {
        files,
        hash: sha256Object(files.map((file) => [file.path, file.hash])),
      };
      const [assets, input] = yield* Effect.all(
        [
          output.clientDirectory !== undefined
            ? readClientAssets(
                output.clientDirectory,
                assetsConfigOf(ctx.assets),
              )
            : Effect.succeed(undefined),
          hashVinextInput({
            rootDir,
            memo: options.memo,
            options,
            workspaces: output.externalWorkspaces,
          }),
        ],
        { concurrency: "unbounded" },
      );
      yield* seedVinextPrerenderCache(
        rootDir,
        yield* resolveVinextCacheEnv(ctx.env ?? {}),
      );
      return {
        bundle,
        assets,
        hash: {
          bundle: bundle.hash,
          assets: assets?.hash,
          input: input.hash,
          additionalWorkspaces: input.workspaces,
        },
      };
    }),
    hash: Effect.fn(function* (_ctx, previous) {
      const path = yield* Path.Path;
      const input = yield* hashVinextInput({
        rootDir: rootDirOf(path),
        memo: options.memo,
        options,
        workspaces: previous?.additionalWorkspaces ?? [],
      });
      return { input: input.hash, additionalWorkspaces: input.workspaces };
    }),
    dev: Effect.fn(function* (ctx) {
      const path = yield* Path.Path;
      const rootDir = rootDirOf(path);
      process.env[ALCHEMY_CLOUDFLARE_VITE_INJECTED] = "1";
      const cachePlugin = yield* makeVinextCachePlugin(rootDir, "kv");
      const vite = yield* Effect.promise(() => loadVite(rootDir));
      const port = yield* resolveViteDevPort(vite.version).pipe(
        Effect.mapError(
          (error) =>
            new SourceProviderError({
              provider: PROVIDER,
              message: "Failed to allocate a vinext dev port",
              cause: error,
            }),
        ),
      );
      const pluginOptions = makeVinextPluginOptions({
        root: rootDir,
        main: options.main ?? DEFAULT_WORKER_ENTRY,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: options.viteEnvironments,
        worker: {
          name: ctx.workerName,
          bindings: ctx.worker.bindings,
          durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
          hyperdrives: ctx.worker.hyperdrives,
          queueConsumers: yield* ctx.worker.queueConsumers,
          assets: ctx.worker.assets,
        },
        context: ctx.runtimeContext,
      });
      const server = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const devServer = await vite.createServer({
            root: rootDir,
            define: getDefine(ctx.env ?? {}),
            plugins: [cachePlugin, cloudflare(pluginOptions)],
            server: { port, strictPort: false },
          });
          await devServer.listen();
          return devServer;
        }),
        (devServer) => Effect.promise(() => devServer.close()),
      );
      const local = server.resolvedUrls?.local[0];
      if (!local) {
        return yield* Effect.fail(
          new SourceProviderError({
            provider: PROVIDER,
            message: "vinext dev server started without a local URL",
          }),
        );
      }
      return { mode: "server", url: new URL(local) } satisfies ServerDevHandle;
    }),
  };
};

const sourceModule = {
  make: (
    options: unknown,
  ): Effect.Effect<SourceProvider, SourceProviderError> => {
    if (
      options !== undefined &&
      (typeof options !== "object" || options === null)
    ) {
      return Effect.fail(
        new SourceProviderError({
          provider: PROVIDER,
          message: `Invalid options for ${PROVIDER}: expected an object, got ${typeof options}`,
        }),
      );
    }
    return Effect.succeed(
      makeVinextSourceProvider((options ?? {}) as VinextSourceOptions),
    );
  },
};

export default sourceModule;
