import type {
  BindingHook,
  BindingServices,
  HyperdriveOrigin,
  Assets as RuntimeAssets,
  DurableObjectNamespace as RuntimeDurableObject,
  QueueConsumer as RuntimeQueueConsumer,
  RuntimeServices,
} from "@alchemy.run/cloudflare-runtime/core";
import * as FrameworkCore from "../core/index.ts";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";
import { createRequire } from "node:module";
import { runBuildChild } from "../core/BuildChild.ts";
import { makeWakuCloudflareTarget } from "./cloudflare.ts";
import { layer as wakuFrameworkLayer } from "./Waku.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Structural mirror of alchemy's Worker source-provider contract.
//
// This module is loaded dynamically by alchemy's `loadSource` (see
// `packages/alchemy/src/Cloudflare/Workers/Source.ts` — `WorkerSourceModule`,
// `SourceProvider`, `SourceContext`, `DevContext`, `SourceBuildOutput`). The
// contract is deliberately implemented STRUCTURALLY — no alchemy import — so
// version skew degrades to a load-time `SourceProviderError` instead of a
// crash. Keep these shapes in sync with the alchemy interfaces.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirror of alchemy `Cloudflare/Workers/Source.SourceHash`. */
export interface SourceHash {
  readonly bundle: string | undefined;
  readonly assets: string | undefined;
  readonly input: string | undefined;
  readonly additionalWorkspaces: Array<string> | undefined;
}

/** Mirror of alchemy `Bundle/Bundle.BundleFile`. */
export interface BundleFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly hash: string;
}

/** Mirror of alchemy `Bundle/Bundle.BundleOutput`. */
export interface BundleOutput {
  readonly files: [BundleFile, ...Array<BundleFile>];
  readonly hash: string;
}

/** Mirror of alchemy `Cloudflare/Workers/Assets.AssetReadResult`. */
export interface AssetReadResult {
  directory: string;
  config: Record<string, unknown> | undefined;
  manifest: Record<string, { hash: string; size: number }>;
  _headers: string | undefined;
  _redirects: string | undefined;
  hash: string;
}

/** Mirror of alchemy `Cloudflare/Workers/Source.SourceBuildOutput`. */
export interface SourceBuildOutput {
  readonly bundle: BundleOutput | undefined;
  readonly assets: AssetReadResult | undefined;
  readonly hash: SourceHash;
}

/** Mirror of alchemy `Cloudflare/Workers/Source.SourceContext`. */
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
  /** Raw `props.assets` (routing config; sources that own assets merge it in). */
  readonly assets: unknown;
}

/** Mirror of alchemy `Cloudflare/Workers/Source.DevContext`. */
export interface DevContext extends SourceContext {
  readonly worker: {
    readonly name: string;
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

/** The `server`-mode arm of alchemy's `SourceDevHandle` (waku dev is a vite dev server). */
export interface ServerDevHandle {
  readonly mode: "server";
  readonly url: URL;
}

/**
 * Tag-compatible mirror of alchemy's
 * `Cloudflare.Workers.SourceProviderError` — same `_tag`, same fields, so
 * `Effect.catchTag` on the alchemy side matches errors raised here.
 */
export class SourceProviderError extends Data.TaggedError(
  "Cloudflare.Workers.SourceProviderError",
)<{
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type WakuSourceError = SourceProviderError | PlatformError;

export type SourceRequirements = FileSystem.FileSystem | Path.Path;

/** Mirror of alchemy `Cloudflare/Workers/Source.SourceProvider` (narrowed E/R). */
export interface SourceProvider {
  readonly ownsAssets: boolean;
  readonly build: (
    ctx: SourceContext,
  ) => Effect.Effect<SourceBuildOutput, WakuSourceError, SourceRequirements>;
  readonly hash: (
    ctx: SourceContext,
    previous: SourceHash | undefined,
  ) => Effect.Effect<Partial<SourceHash>, WakuSourceError, SourceRequirements>;
  readonly dev: (
    ctx: DevContext,
  ) => Effect.Effect<
    ServerDevHandle,
    WakuSourceError,
    SourceRequirements | Scope.Scope
  >;
}

/**
 * Serializable options of the waku source descriptor
 * (`{ provider: "@alchemy.run/frontend-frameworks/waku/source", options }` on alchemy's
 * `WorkerProps.source`). MUST stay plain JSON data — the descriptor persists
 * in alchemy state and participates in the Worker metadata hash.
 */
export interface WakuSourceOptions {
  /** Project root. Defaults to the process working directory. */
  readonly rootDir?: string | undefined;
  /**
   * The user's own worker entry (the user-entry seam,
   * `DeployTarget.entry`): a module that wraps waku's handler — imported
   * from `virtual:waku/server-entry` — and re-exports extras (Durable
   * Object classes, additional handlers). Relative paths resolve against
   * the root. When unset, waku's own rsc server entry is deployed.
   */
  readonly main?: string | undefined;
  /** Waku `srcDir` (relative to the root). @default "src" */
  readonly srcDir?: string | undefined;
  /**
   * Waku `distDir` (relative to the root). If `waku.config.ts` customizes
   * `distDir`, mirror it here (or add it to `memo.exclude`) so the build
   * output stays excluded from the rebuild-deciding input hash.
   * @default "dist"
   */
  readonly distDir?: string | undefined;
  /** Waku `basePath`. @default "/" */
  readonly basePath?: string | undefined;
  /** Controls which files feed the rebuild-deciding `input` hash. */
  readonly memo?: WakuMemoOptions | undefined;
}

const wakuConfigFor = (options: WakuSourceOptions) => ({
  ...(options.srcDir !== undefined ? { srcDir: options.srcDir } : undefined),
  ...(options.distDir !== undefined ? { distDir: options.distDir } : undefined),
  ...(options.basePath !== undefined
    ? { basePath: options.basePath }
    : undefined),
});

/**
 * Input-hash scoping, mirroring the semantics of alchemy's `MemoOptions`
 * (`Command/Memo.ts`): by default every non-gitignored file under the root is
 * hashed plus the nearest package-manager lockfile; explicit `include` /
 * `exclude` globs narrow the scope.
 *
 * The glob support is a self-contained subset (`**`, `*`, `?`; gitignore-style
 * anchoring). Negated (`!`) gitignore rules are ignored (files they would
 * re-include stay excluded from the hash).
 */
export interface WakuMemoOptions {
  /** Glob patterns of files to hash, relative to the root. @default all files */
  readonly include?: Array<string> | undefined;
  /** Glob patterns to exclude. @default gitignore rules from the root up to the repo root */
  readonly exclude?: Array<string> | undefined;
  /**
   * Whether to include the nearest package-manager lockfile in the hash.
   * @default true when both `include` and `exclude` are unset; false otherwise
   */
  readonly lockfile?: boolean | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing primitives
// ─────────────────────────────────────────────────────────────────────────────

const sha256 = (input: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(input).digest("hex");

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
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

/** The integration's own version — included in the input hash so upgrading the
 * adapter busts the build memo even when project sources are unchanged. */
const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

// ─────────────────────────────────────────────────────────────────────────────
// Minimal gitignore-style matching (documented subset, zero dependencies)
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Compile one gitignore-style rule into a RegExp over root-relative posix
 * paths. The RegExp matches the path itself and everything under it (so a
 * rule matching a directory also matches its files). Returns `undefined` for
 * blank lines, comments, and negated rules (unsupported).
 */
const compileIgnoreRule = (raw: string): RegExp | undefined => {
  let rule = raw.trim();
  if (rule.length === 0 || rule.startsWith("#") || rule.startsWith("!")) {
    return undefined;
  }
  if (rule.endsWith("/")) {
    rule = rule.slice(0, -1);
  }
  if (rule.length === 0) {
    return undefined;
  }
  // Anchored when the rule contains a `/` (the trailing directory `/` was
  // already stripped above); otherwise it matches a basename at any depth.
  const anchored = rule.includes("/");
  if (rule.startsWith("/")) {
    rule = rule.slice(1);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Input-tree hashing (the rebuild-free change signal, mirroring the semantics
// of alchemy's `hashViteInput` / `hashDirectory`)
// ─────────────────────────────────────────────────────────────────────────────

const LOCKFILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

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
      if (yield* fs.exists(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
});

/** Collect `.gitignore` rules from `rootDir` up to the repo root (the first
 * directory containing `.git`), outermost first — same walk as alchemy's
 * `Command/Memo.ts`. Rules apply relative to `rootDir` (simplification). */
const readGitIgnoreRules = Effect.fn(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const chain: Array<Array<string>> = [];
  let dir = rootDir;
  for (;;) {
    const gitignore = path.join(dir, ".gitignore");
    if (yield* fs.exists(gitignore)) {
      const content = yield* fs.readFileString(gitignore);
      chain.unshift(content.split("\n"));
    }
    if (yield* fs.exists(path.join(dir, ".git"))) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
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
  memo: WakuMemoOptions | undefined,
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
      // Always excluded regardless of gitignore: dependency trees, VCS
      // metadata, and the build output waku itself writes (hashing `distDir`
      // would make every build bust its own memo).
      ...compileIgnoreRules(["node_modules", ".git", `/${distDir}`]),
      ...exclude,
    ],
    lockfile: memo?.lockfile ?? !(memo?.include || memo?.exclude),
  } satisfies ResolvedMemo;
});

/** Deterministic, machine-independent content hash of one directory tree:
 * sorted `[relativePosixPath, sha256(content)]` pairs (never absolute paths). */
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
        if (matchesAny(memo.exclude, relPath)) {
          continue;
        }
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
      if (!files.includes(relative)) {
        files.push(relative);
      }
    }
  }

  const hashes = yield* Effect.forEach(
    files.sort(),
    Effect.fn(function* (file) {
      const content = yield* fs.readFile(path.join(rootDir, file));
      return `${file}:${sha256(content)}`;
    }),
    { concurrency: 16 },
  );
  return sha256Object(hashes);
});

/**
 * The `input` hash slot: the project tree (+ workspaces + lockfile), the
 * integration's own package version, and the build-affecting waku options.
 * Deterministic for an unchanged tree and stable across `rootDir` moves.
 */
const hashWakuInput = Effect.fn(function* (params: {
  rootDir: string;
  distDir: string;
  memo: WakuMemoOptions | undefined;
  options: WakuSourceOptions;
  /** Workspace directories, absolute. */
  workspaces: Iterable<string>;
}) {
  const path = yield* Path.Path;
  const memo = yield* resolveMemo(params.rootDir, params.distDir, params.memo);
  const workspaceMemo = yield* resolveMemo(
    params.rootDir,
    params.distDir,
    undefined,
  );
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
  const hash = sha256Object({
    version: PACKAGE_VERSION,
    root,
    workspaces: workspaceHashes.sort(),
    options: {
      // Build-affecting: a changed user entry must bust the memo.
      main: params.options.main,
      srcDir: params.options.srcDir,
      distDir: params.options.distDir,
      basePath: params.options.basePath,
    },
  });
  const workspaces = Array.from(params.workspaces).map((workspace) =>
    path
      .relative(params.rootDir, path.resolve(params.rootDir, workspace))
      .replaceAll("\\", "/"),
  );
  return { hash, workspaces };
});

// ─────────────────────────────────────────────────────────────────────────────
// Client-asset reading (mirror of alchemy `Cloudflare/Workers/Assets.readAssets`)
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Read the client output directory into the manifest shape alchemy's
 * `putWorker`/`uploadAssets` consume: per-file `sha256(content).slice(0, 32)`
 * + byte size, keyed by `/`-prefixed posix path; the aggregate hash covers
 * only upload-affecting inputs (manifest, config, `_headers`, `_redirects` —
 * never the absolute directory path).
 */
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
      if (matchesAny(ignores, relPath)) {
        return;
      }
      const file = path.join(directory, name);
      const stat = yield* fs.stat(file);
      if (stat.type !== "File") {
        return;
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// The provider
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER = "@alchemy.run/frontend-frameworks/waku/source";

export interface WakuLikeSourceIntegration {
  readonly provider: string;
  readonly framework: string;
  readonly displayName: string;
  readonly buildModule: string;
  readonly layer: (options: {
    root: string;
    target: ReturnType<typeof makeWakuCloudflareTarget>;
  }) => Layer.Layer<FrameworkCore.Framework, never, SourceRequirements>;
}

/**
 * Waku assumes `process.cwd()` is the project root in several places (the
 * html-shell plugin's `index.html` input resolves against the cwd, and
 * rolldown resolves relative inputs from the cwd), exactly like its CLI,
 * which always runs from the project.
 *
 * The production **build** therefore runs in a disposable child process
 * whose working directory IS the project root (see `core/BuildChild.ts`) —
 * no in-process `chdir`, no lock, unbounded build concurrency. The shared `core/BuildChildRunner`
 * entry imports this module in the child and calls the exported
 * {@link buildInChild}.
 *
 * The **dev server** cannot cross a process boundary (its inputs —
 * `ctx.worker.bindings` hooks and `ctx.runtimeContext` — are live objects),
 * so only its startup window still chdirs in-process, serialized through
 * {@link cwdLock}; the cwd is restored as soon as the server is listening.
 */
const cwdLock = Semaphore.makeUnsafe(1);

const withRootCwd = <A, E, R>(
  rootDir: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Semaphore.withPermits(
    cwdLock,
    1,
  )(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.cwd();
        process.chdir(rootDir);
        return previous;
      }),
      () => effect,
      (previous) => Effect.sync(() => process.chdir(previous)),
    ),
  );

/** JSON config the build child reconstructs the waku framework from. */
export interface WakuBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly main: string | undefined;
  readonly waku: {
    readonly srcDir?: string;
    readonly distDir?: string;
    readonly basePath?: string;
  };
}

export const buildInChild = (config: WakuBuildChildConfig) =>
  Effect.gen(function* () {
    const waku = yield* FrameworkCore.Framework;
    return yield* waku.build({ root: config.rootDir });
  }).pipe(
    Effect.provide(
      wakuFrameworkLayer({
        root: config.rootDir,
        waku: config.waku,
        target: makeWakuCloudflareTarget({
          compatibilityDate: config.compatibilityDate,
          compatibilityFlags: config.compatibilityFlags,
          ...(config.main !== undefined ? { main: config.main } : undefined),
        }),
      }),
    ),
  );

/** Routing config from the raw `props.assets` (directory/hash keys are
 * path-level concerns owned by alchemy; only the routing config passes through). */
const assetsConfigOf = (
  assets: unknown,
): Record<string, unknown> | undefined => {
  if (assets === undefined || assets === null || typeof assets !== "object") {
    return undefined;
  }
  const {
    directory: _directory,
    hash: _hash,
    ...config
  } = assets as Record<string, unknown>;
  return Object.keys(config).length > 0 ? config : undefined;
};

export const makeWakuSourceProvider = (
  options: WakuSourceOptions,
  integration: WakuLikeSourceIntegration = {
    provider: PROVIDER,
    framework: "waku",
    displayName: "Waku",
    buildModule: import.meta.url,
    layer: ({ root, target }) =>
      wakuFrameworkLayer({ root, waku: wakuConfigFor(options), target }),
  },
): SourceProvider => {
  const rootDirOf = (path: Path.Path): string =>
    options.rootDir !== undefined
      ? path.resolve(options.rootDir)
      : process.cwd();
  const distDir = options.distDir ?? "dist";
  const wakuConfig = wakuConfigFor(options);

  return {
    // Waku's assets are a build product (`dist/public`), not a props-level
    // directory — the provider reads and diffs them itself.
    ownsAssets: true,

    build: Effect.fn(function* (ctx) {
      const path = yield* Path.Path;
      const rootDir = rootDirOf(path);
      // The build runs in a child process with cwd = rootDir (waku resolves
      // inputs relative to the cwd); `buildInChild` reconstructs the
      // framework + cloudflare target from this JSON config on the far side.
      const output = yield* runBuildChild({
        module: integration.buildModule,
        rootDir,
        framework: integration.framework,
        config: {
          rootDir,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          // The user-entry seam: surfaced as `DeployTarget.entry` and made
          // the vite plugin's `main` (resolved against the root by
          // `makeWakuPluginOptions`).
          main: options.main,
          waku: wakuConfig,
        } satisfies WakuBuildChildConfig,
      }).pipe(
        Effect.mapError(
          (error) =>
            new SourceProviderError({
              provider: integration.provider,
              message: `${integration.displayName} build failed`,
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
            provider: integration.provider,
            message: `${integration.displayName} build produced no server modules`,
          }),
        );
      }
      const [entry, ...rest] = output.serverModules;
      const files: [BundleFile, ...Array<BundleFile>] = [
        ...[entry!, ...rest].map((file) => ({
          path: file.name.replaceAll("\\", "/"),
          content: file.content,
          hash: file.hash,
        })),
      ] as [BundleFile, ...Array<BundleFile>];
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
          hashWakuInput({
            rootDir,
            distDir,
            memo: options.memo,
            options,
            workspaces: output.externalWorkspaces,
          }),
        ],
        { concurrency: "unbounded" },
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
      } satisfies SourceBuildOutput;
    }),

    // Rebuild-free: re-hash the project tree (+ previously-discovered
    // workspaces) — the same recipe as alchemy's vite source. `previous` is
    // only used for the auxiliary workspace list, never to skip recomputation.
    hash: Effect.fn(function* (_ctx, previous) {
      const path = yield* Path.Path;
      const rootDir = rootDirOf(path);
      const input = yield* hashWakuInput({
        rootDir,
        distDir,
        memo: options.memo,
        options,
        workspaces: (previous?.additionalWorkspaces ?? []).map((workspace) =>
          path.resolve(rootDir, workspace),
        ),
      });
      return { input: input.hash, additionalWorkspaces: input.workspaces };
    }),

    // Waku dev is a vite dev server with the cloudflare plugin embedded in
    // waku's own plugin stack (the rsc environment runs in workerd against
    // the host-provided worker wiring) — a `server`-mode dev handle.
    dev: Effect.fn(function* (ctx) {
      const path = yield* Path.Path;
      const rootDir = rootDirOf(path);
      const queueConsumers = yield* ctx.worker.queueConsumers;
      const framework = integration.layer({
        root: rootDir,
        target: makeWakuCloudflareTarget({
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          // Dev serves the wrapped user entry too, so DO classes exported
          // from it exist in dev.
          ...(options.main !== undefined ? { main: options.main } : undefined),
          worker: {
            name: ctx.worker.name,
            bindings: ctx.worker.bindings,
            durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
            hyperdrives: ctx.worker.hyperdrives,
            queueConsumers,
            assets: ctx.worker.assets,
          },
          context: ctx.runtimeContext,
        }),
      });
      // The dev server *starts* under the project cwd (waku resolves its
      // html shell and relative inputs from the cwd at startup); the cwd is
      // restored once the server is listening.
      const server = yield* withRootCwd(
        rootDir,
        Effect.gen(function* () {
          const waku = yield* FrameworkCore.Framework;
          return yield* waku.dev({ root: rootDir });
        }).pipe(
          Effect.provide(framework),
          Effect.mapError(
            (cause) =>
              new SourceProviderError({
                provider: integration.provider,
                message: `Failed to start the ${integration.framework} dev server`,
                cause,
              }),
          ),
        ),
      );
      return {
        mode: "server",
        url: new URL(server.url),
      } satisfies ServerDevHandle;
    }),
  };
};

/**
 * The dynamic-module contract alchemy's `loadSource` expects: the default
 * export's `make(options)` builds a `SourceProvider` from the descriptor's
 * JSON-serializable options.
 */
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
      makeWakuSourceProvider((options ?? {}) as WakuSourceOptions),
    );
  },
};

export default sourceModule;
