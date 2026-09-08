/**
 * Alchemy Worker source provider for Astro projects.
 *
 * The default export implements alchemy's `WorkerSourceModule` contract
 * (`packages/alchemy/src/Cloudflare/Workers/Source.ts`) **structurally** —
 * this package deliberately does not depend on `alchemy`, so the types
 * below mirror the shapes of `SourceProvider` / `SourceContext` /
 * `DevContext` / `SourceBuildOutput` / `SourceHash` / `SourceDevHandle`
 * instead of importing them. The contract is structural on purpose:
 * version skew degrades to a load-time `SourceProviderError`, not a
 * crash.
 *
 * Semantics mirror alchemy's built-in Vite source
 * (`Workers/Sources/Vite.ts`):
 *
 * - `build()` runs the programmatic Astro build via this package's
 *   `Framework` service, maps `serverModules` (entry first) to the
 *   bundle files, reads `clientDirectory` into an asset manifest, and
 *   computes a rebuild-free `input` hash over the project tree.
 * - `hash()` recomputes only the `input` hash (never builds) — the memo
 *   fast path that lets an unchanged project skip the build entirely.
 * - `dev()` starts `astro dev` with the `ssr` environment executing
 *   inside workerd (via `@alchemy.run/cloudflare-runtime/vite`) and
 *   returns a `server`-mode handle.
 *
 * The `input` hash includes this package's version so upgrading the
 * integration (which can change build output) busts the memo even when
 * project sources are unchanged.
 */
import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import { runBuildChild } from "../core/BuildChild.ts";
import * as FrameworkCore from "../core/index.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";
import { createRequire } from "node:module";
import * as Astro from "./Astro.ts";
import cloudflareTarget from "./cloudflare.ts";

// ─────────────────────────────────────────────────────────────────────
// Structural mirrors of alchemy's source-provider contract
// (packages/alchemy/src/Cloudflare/Workers/Source.ts). Keep in sync.
// ─────────────────────────────────────────────────────────────────────

/** Mirror of alchemy's `SourceHash`. */
export interface SourceHash {
  readonly bundle: string | undefined;
  readonly assets: string | undefined;
  readonly input: string | undefined;
  readonly additionalWorkspaces: Array<string> | undefined;
}

/** Mirror of alchemy's `Bundle.BundleFile`. */
export interface BundleFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly hash: string;
}

/** Mirror of alchemy's `Bundle.BundleOutput`. */
export interface BundleOutput {
  readonly files: [BundleFile, ...Array<BundleFile>];
  readonly hash: string;
}

/** Mirror of alchemy's `AssetReadResult` (Workers/Assets.ts). */
export interface AssetReadResult {
  readonly directory: string;
  readonly config: Record<string, unknown> | undefined;
  readonly manifest: Record<string, { hash: string; size: number }>;
  readonly _headers: string | undefined;
  readonly _redirects: string | undefined;
  readonly hash: string;
}

/** Mirror of alchemy's `SourceBuildOutput`. */
export interface SourceBuildOutput {
  readonly bundle: BundleOutput | undefined;
  readonly assets: AssetReadResult | undefined;
  readonly hash: SourceHash;
}

/** Mirror of alchemy's `SourceContext` (the slots this source reads). */
export interface SourceContext {
  readonly id: string;
  readonly workerName: string;
  readonly compatibility: {
    readonly date: string;
    readonly flags: Array<string>;
  };
  readonly stack: { readonly name: string; readonly stage: string };
  readonly env: Record<string, unknown> | undefined;
  /** Raw `props.assets` — a directory string or an asset-config object. */
  readonly assets: string | Record<string, unknown> | undefined;
}

type PluginWorker = Exclude<CloudflareVitePluginOptions["worker"], undefined>;

/** Mirror of alchemy's `DevContext` (the slots this source reads). */
export interface DevContext extends SourceContext {
  readonly worker: {
    readonly name: string;
    readonly bindings: PluginWorker["bindings"];
    readonly durableObjectNamespaces: PluginWorker["durableObjectNamespaces"];
    readonly hyperdrives: PluginWorker["hyperdrives"];
    readonly queueConsumers: Effect.Effect<
      Exclude<PluginWorker["queueConsumers"], undefined>
    >;
    readonly assets: PluginWorker["assets"] | undefined;
  };
  readonly runtimeContext: CloudflareVitePluginOptions["context"];
}

/** Mirror of alchemy's `SourceDevHandle` (`server` mode only). */
export interface SourceDevHandle {
  readonly mode: "server";
  readonly url: URL;
}

/**
 * Structural twin of alchemy's `Cloudflare.Workers.SourceProviderError`
 * — same `_tag` and fields, so `Effect.catchTag` on the alchemy side
 * matches errors raised here.
 */
export class SourceProviderError extends Data.TaggedError(
  "Cloudflare.Workers.SourceProviderError",
)<{
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SourceError = PlatformError | SourceProviderError;

type SourceServices = FileSystem.FileSystem | Path.Path;

/** Mirror of alchemy's `SourceProvider` (with this module's closed error/requirement channels). */
export interface SourceProvider {
  readonly ownsAssets: boolean;
  readonly build: (
    ctx: SourceContext,
  ) => Effect.Effect<SourceBuildOutput, SourceError, SourceServices>;
  readonly hash: (
    ctx: SourceContext,
    previous: SourceHash | undefined,
  ) => Effect.Effect<Partial<SourceHash>, SourceError, SourceServices>;
  readonly dev: (
    ctx: DevContext,
  ) => Effect.Effect<
    SourceDevHandle,
    SourceError,
    SourceServices | Scope.Scope
  >;
}

// ─────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────

/**
 * Controls which files are hashed to decide whether a rebuild is
 * needed. Mirrors alchemy's `MemoOptions` semantics: by default every
 * non-gitignored file under the root is hashed, plus the nearest
 * package-manager lockfile.
 */
export interface MemoOptions {
  /** Glob patterns of files to hash, relative to the directory. @default all files */
  readonly include?: Array<string>;
  /** Glob patterns to exclude. @default gitignore rules up to the repo root */
  readonly exclude?: Array<string>;
  /**
   * Whether to include the nearest lockfile in the hash.
   * @default true when both `include` and `exclude` are unset
   */
  readonly lockfile?: boolean;
}

/**
 * Provider options carried on the Worker's `source` descriptor. Must be
 * JSON-serializable and JSON-stable (they persist in state and
 * participate in the Worker's metadata hash).
 */
export interface AstroSourceOptions {
  /** Astro project root. Defaults to the process working directory. */
  readonly rootDir?: string;
  /** Rebuild-scope configuration (see {@link MemoOptions}). */
  readonly memo?: MemoOptions & {
    /**
     * Additional workspace directories to hash. `"auto"` (default)
     * auto-detects workspaces from the build's module graph; an explicit
     * array pins them.
     */
    readonly workspaces?:
      | "auto"
      | Array<MemoOptions & { readonly cwd: string }>;
  };
  /**
   * The name of the KV binding injected into Astro's session config
   * when present on the Worker env.
   * @default "SESSION"
   */
  readonly sessionKVBindingName?: string;
  /**
   * Zero-config sessions: default Astro's session driver to Cloudflare KV
   * (binding `sessionKVBindingName`) when none is configured. `false`
   * leaves the session config untouched.
   * @default true
   */
  readonly sessions?: boolean;
  /**
   * Auto-inject an in-memory local KV namespace for the session binding: in
   * dev on the dev worker, at build time on the workerd prerender worker
   * (so session-touching pages can prerender before the Worker's real
   * namespace exists). Disable once the Worker's own bindings deliver a KV
   * binding with that name (e.g. when alchemy provisions the session
   * namespace and passes it through the dev bindings).
   * @default true
   */
  readonly sessionDevKV?: boolean;
  /**
   * Runtime used to prerender static pages.
   * @default "workerd"
   */
  readonly prerenderEnvironment?: "workerd" | "node";
  /**
   * JSON-serializable subset of Astro config merged into the in-memory
   * `AstroInlineConfig`. The project's `astro.config.*` file loads
   * natively; astro merges this inline overlay OVER it (scalars here
   * override the file). The file itself participates in the `input`
   * memo hash like any other project file, so these options stay
   * JSON-serializable while the config file stays fully expressive.
   */
  readonly astro?: {
    readonly site?: string;
    readonly base?: string;
    readonly output?: "server" | "static";
    readonly srcDir?: string;
    readonly publicDir?: string;
    readonly outDir?: string;
    readonly trailingSlash?: "always" | "never" | "ignore";
  };
  /**
   * Path to an alternate Astro config file, resolved against
   * {@link rootDir} when relative. Defaults to astro's own config
   * discovery (`astro.config.*` in the project root).
   */
  readonly config?: string;
}

const PROVIDER = "@alchemy.run/frontend-frameworks/astro/source";

const packageMeta: { version: string; root: string | undefined } = (() => {
  try {
    const require = createRequire(import.meta.url);
    const path = require.resolve("../../package.json");
    return {
      version: (require(path) as { version: string }).version,
      root: path.slice(0, path.length - "package.json".length - 1),
    };
  } catch {
    return { version: "unknown", root: undefined };
  }
})();

const packageVersion = packageMeta.version;

// ─────────────────────────────────────────────────────────────────────
// Hashing primitives (mirror alchemy's Util/sha256 + Command/Memo)
// ─────────────────────────────────────────────────────────────────────

const sha256Hex = (input: string | Uint8Array): Effect.Effect<string> =>
  Effect.sync(() =>
    NodeCrypto.createHash("sha256").update(input).digest("hex"),
  );

/** Recursively sort object keys so JSON.stringify is order-stable. */
const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !ArrayBuffer.isView(value)
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
};

const sha256Object = (input: unknown): Effect.Effect<string> =>
  Effect.flatMap(
    Effect.sync(() => JSON.stringify(stableValue(input))),
    sha256Hex,
  );

// ─────────────────────────────────────────────────────────────────────
// Glob / gitignore matching (self-contained approximation of the
// fast-glob + gitignore semantics alchemy's `hashDirectory` uses)
// ─────────────────────────────────────────────────────────────────────

const escapeRegex = (char: string): string =>
  /[\\^$.|+()[\]{}]/.test(char) ? `\\${char}` : char;

/**
 * Convert a glob body (no negation/anchoring — handled by callers) to a
 * regex source. Supports `**`, `*`, `?`; everything else is literal.
 */
const globToRegexSource = (glob: string): string => {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const prevBoundary = i === 0 || glob[i - 1] === "/";
      let j = i + 2;
      if (prevBoundary && glob[j] === "/") {
        // `**/` segment — zero or more whole path segments.
        out += "(?:[^/]+/)*";
        i = j + 1;
        continue;
      }
      out += ".*";
      i = j;
      continue;
    }
    if (c === "*") {
      out += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    out += escapeRegex(c);
    i++;
  }
  return out;
};

interface IgnoreRule {
  readonly regex: RegExp;
  readonly dirOnly: boolean;
  readonly negated: boolean;
}

/** Compile one gitignore-style rule line. Returns `undefined` for blanks/comments. */
const compileIgnoreRule = (raw: string): IgnoreRule | undefined => {
  let line = raw.trim();
  if (line.length === 0 || line.startsWith("#")) {
    return undefined;
  }
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1).trim();
    if (line.length === 0) return undefined;
  }
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  line = line.replaceAll("\\", "/");
  // A slash anywhere (after stripping the trailing one) anchors the
  // pattern to the ignore root; otherwise it matches at any depth.
  const anchored = line.startsWith("/") || line.includes("/");
  if (line.startsWith("/")) {
    line = line.slice(1);
  }
  if (line.length === 0) return undefined;
  const body = globToRegexSource(line);
  const source = anchored ? `^${body}$` : `(?:^|/)${body}$`;
  try {
    return { regex: new RegExp(source), dirOnly, negated };
  } catch {
    return undefined;
  }
};

const compileIgnoreRules = (rules: ReadonlyArray<string>): Array<IgnoreRule> =>
  rules
    .map(compileIgnoreRule)
    .filter((rule): rule is IgnoreRule => rule !== undefined);

/**
 * Gitignore matching: the LAST matching rule wins; `dirOnly` rules only
 * match directories. Paths are `/`-separated and relative (no leading
 * slash).
 */
const isIgnored = (
  rules: ReadonlyArray<IgnoreRule>,
  path: string,
  isDirectory: boolean,
): boolean => {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) continue;
    if (rule.regex.test(path)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
};

/** Compile positive glob patterns (memo include/exclude), anchored to the root. */
const compileGlobs = (globs: ReadonlyArray<string>): Array<RegExp> =>
  globs.flatMap((glob) => {
    try {
      return [new RegExp(`^${globToRegexSource(glob.replace(/^\.\//, ""))}$`)];
    } catch {
      return [];
    }
  });

const matchesAny = (regexes: ReadonlyArray<RegExp>, path: string): boolean =>
  regexes.some((regex) => regex.test(path));

// ─────────────────────────────────────────────────────────────────────
// Directory walking + input hashing (mirror of alchemy's hashDirectory
// / hashViteInput recipe: `${relative}:${hash}` per workspace, sorted,
// hashed together — machine-independent, never hashes absolute paths)
// ─────────────────────────────────────────────────────────────────────

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const readGitIgnoreRules = (
  cwd: string,
): Effect.Effect<Array<string>, PlatformError, SourceServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rules = yield* fs.readFileString(path.join(cwd, ".gitignore")).pipe(
      Effect.map((file) => file.split("\n")),
      Effect.catchTag("PlatformError", () =>
        Effect.succeed([] as Array<string>),
      ),
    );
    const parent = path.dirname(cwd);
    if (parent === cwd || (yield* fs.exists(path.join(cwd, ".git")))) {
      return rules;
    }
    return [...(yield* readGitIgnoreRules(parent)), ...rules];
  });

const findUp = (
  cwd: string,
  filenames: ReadonlyArray<string>,
): Effect.Effect<string | undefined, PlatformError, SourceServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const filename of filenames) {
      const candidate = path.join(cwd, filename);
      if (yield* fs.exists(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(cwd);
    if (parent === cwd) {
      return undefined;
    }
    return yield* findUp(parent, filenames);
  });

/**
 * List files under `cwd` (relative, `/`-separated, sorted), pruning
 * ignored directories during the walk so `node_modules`-scale trees are
 * never traversed.
 */
const listFiles = (
  cwd: string,
  options: {
    readonly include: ReadonlyArray<RegExp> | undefined;
    readonly ignoreRules: ReadonlyArray<IgnoreRule>;
    readonly exclude: ReadonlyArray<RegExp>;
  },
): Effect.Effect<Array<string>, PlatformError, SourceServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: Array<string> = [];
    const walk = (relative: string): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        const absolute = relative === "" ? cwd : path.join(cwd, relative);
        const entries = yield* fs.readDirectory(absolute);
        for (const entry of entries.sort()) {
          const rel = relative === "" ? entry : `${relative}/${entry}`;
          const stat = yield* fs
            .stat(path.join(cwd, rel))
            .pipe(
              Effect.catchTag("PlatformError", () => Effect.succeed(undefined)),
            );
          if (stat === undefined) continue;
          if (stat.type === "Directory") {
            if (
              isIgnored(options.ignoreRules, rel, true) ||
              matchesAny(options.exclude, rel) ||
              matchesAny(options.exclude, `${rel}/`)
            ) {
              continue;
            }
            yield* walk(rel);
            continue;
          }
          if (stat.type !== "File") continue;
          if (isIgnored(options.ignoreRules, rel, false)) continue;
          if (matchesAny(options.exclude, rel)) continue;
          if (
            options.include !== undefined &&
            !matchesAny(options.include, rel)
          ) {
            continue;
          }
          files.push(rel);
        }
      });
    yield* walk("");
    return files.sort();
  });

/**
 * Deterministic content hash of a directory per the given memo options —
 * the structural mirror of alchemy's `hashDirectory`.
 */
const hashDirectory = (
  cwd: string,
  memo: MemoOptions | undefined,
): Effect.Effect<string, PlatformError, SourceServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const include = memo?.include ? compileGlobs(memo.include) : undefined;
    const exclude = memo?.exclude ? compileGlobs(memo.exclude) : [];
    // Gitignore-based exclusion applies whenever no explicit exclude
    // globs are given (matching alchemy's resolveMemoOptions).
    const ignoreRules = memo?.exclude
      ? []
      : compileIgnoreRules([".git/", ...(yield* readGitIgnoreRules(cwd))]);
    const useLockfile = memo?.lockfile ?? !(memo?.include || memo?.exclude);
    const files = yield* listFiles(cwd, { include, ignoreRules, exclude });
    if (useLockfile) {
      const lockfile = yield* findUp(cwd, LOCKFILES);
      if (lockfile !== undefined) {
        const rel = path.relative(cwd, lockfile).replaceAll("\\", "/");
        if (!files.includes(rel)) {
          files.push(rel);
        }
      }
    }
    const hashes = yield* Effect.forEach(
      files,
      (file) =>
        fs.readFile(path.resolve(cwd, file)).pipe(
          Effect.flatMap(sha256Hex),
          Effect.map((hash) => `${file}:${hash}`),
        ),
      { concurrency: 16 },
    );
    return yield* sha256Object(hashes);
  });

/**
 * The `input` hash: root tree + workspace trees + this package's
 * version. Mirrors alchemy's `hashViteInput` recipe (workspace hashes
 * are `${relativePath}:${hash}`, sorted) with the provider version as
 * extra material so integration upgrades bust the memo.
 */
const hashAstroInput = (
  rootDir: string,
  memo: AstroSourceOptions["memo"],
  additionalWorkspaces: Effect.Effect<
    Iterable<string>,
    PlatformError,
    SourceServices
  >,
): Effect.Effect<
  { hash: string; workspaces: Array<string> | undefined },
  PlatformError,
  SourceServices
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const salt = `${PROVIDER}@${packageVersion}`;
    // Normalize workspace directories to a root-relative, `/`-separated
    // form so the hash label is identical whether the workspace came
    // from the build (absolute) or from persisted state (relative) —
    // and machine-independent (never hashes absolute paths).
    const toRelative = (cwd: string): string =>
      (path.isAbsolute(cwd)
        ? path.relative(rootDir, cwd)
        : path.normalize(cwd)
      ).replaceAll("\\", "/");
    const hashWorkspaceDirectory = (
      cwdRelative: string,
      options?: MemoOptions,
    ) =>
      hashDirectory(path.resolve(rootDir, cwdRelative), options).pipe(
        Effect.map((hash) => `${cwdRelative}:${hash}`),
      );
    const hashRoot = hashDirectory(rootDir, memo).pipe(
      Effect.map((hash) => `:${hash}`),
    );
    if (Array.isArray(memo?.workspaces)) {
      const [root, ...workspaces] = yield* Effect.all(
        [
          hashRoot,
          ...memo.workspaces.map(({ cwd, ...options }) =>
            hashWorkspaceDirectory(toRelative(cwd), options),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const hash = yield* sha256Object([salt, root, ...workspaces.sort()]);
      return { hash, workspaces: undefined };
    }
    const [root, workspaces] = yield* Effect.all(
      [hashRoot, additionalWorkspaces],
      {
        concurrency: "unbounded",
      },
    );
    // Exclude this integration package's own tree from auto-detected
    // workspaces (it escapes the collector's node_modules filter when
    // workspace-linked): its influence on the build is covered by the
    // version salt, and hashing its build artifacts would churn.
    const isOwnPackage = (cwd: string): boolean => {
      if (packageMeta.root === undefined) return false;
      const resolved = path.resolve(rootDir, cwd);
      return (
        resolved === packageMeta.root ||
        resolved.startsWith(packageMeta.root + path.sep)
      );
    };
    const relativeWorkspaces = [
      ...new Set(
        Array.from(workspaces)
          .filter((cwd) => !isOwnPackage(cwd))
          .map(toRelative),
      ),
    ].sort();
    const workspaceHashes = yield* Effect.forEach(
      relativeWorkspaces,
      (cwd) => hashWorkspaceDirectory(cwd),
      { concurrency: "unbounded" },
    );
    const hash = yield* sha256Object([salt, root, ...workspaceHashes.sort()]);
    return { hash, workspaces: relativeWorkspaces };
  });

// ─────────────────────────────────────────────────────────────────────
// Asset reading (mirror of alchemy's `readAssets`: per-file sha256
// truncated to 32 hex chars — the hash format Cloudflare's asset-upload
// sessions expect — with `.assetsignore` / `_headers` / `_redirects`
// handling, and a manifest-shaped overall hash)
// ─────────────────────────────────────────────────────────────────────

const MAX_ASSET_SIZE = 1024 * 1024 * 25; // 25MB
const MAX_ASSET_COUNT = 20_000;

const maybeReadString = (
  file: string,
): Effect.Effect<string | undefined, never, SourceServices> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs
      .readFileString(file)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(undefined))),
  );

const readClientAssets = (
  directory: string,
  config: Record<string, unknown> | undefined,
): Effect.Effect<AssetReadResult, SourceError, SourceServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [ignoreFile, _headers, _redirects] = yield* Effect.all([
      maybeReadString(path.join(directory, ".assetsignore")),
      maybeReadString(path.join(directory, "_headers")),
      maybeReadString(path.join(directory, "_redirects")),
    ]);
    const ignoreRules = compileIgnoreRules([
      ".assetsignore",
      "_headers",
      "_redirects",
      ...(ignoreFile?.split("\n") ?? []),
    ]);
    const files = yield* listFiles(directory, {
      include: undefined,
      ignoreRules,
      exclude: [],
    });
    if (files.length > MAX_ASSET_COUNT) {
      return yield* new SourceProviderError({
        provider: PROVIDER,
        message: `Too many assets in ${directory} (maximum is ${MAX_ASSET_COUNT}, found ${files.length})`,
      });
    }
    const manifest: Record<string, { hash: string; size: number }> = {};
    yield* Effect.forEach(
      files,
      Effect.fn(function* (name) {
        const file = path.join(directory, name);
        const stat = yield* fs.stat(file);
        const size = Number(stat.size);
        if (size > MAX_ASSET_SIZE) {
          return yield* new SourceProviderError({
            provider: PROVIDER,
            message: `Asset ${name} is too large (${(size / 1024 / 1024).toFixed(1)} MB; the maximum is ${MAX_ASSET_SIZE / 1024 / 1024} MB)`,
          });
        }
        const content = yield* fs.readFile(file);
        const hash = (yield* sha256Hex(content)).slice(0, 32);
        manifest[`/${name}`] = { hash, size };
      }),
      { concurrency: 16 },
    );
    const sortedManifest = Object.fromEntries(
      Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
    );
    const hash = yield* sha256Object({
      config,
      manifest: sortedManifest,
      _headers,
      _redirects,
    });
    return {
      directory,
      config,
      manifest: sortedManifest,
      _headers,
      _redirects,
      hash,
    };
  });

// ─────────────────────────────────────────────────────────────────────
// The provider
// ─────────────────────────────────────────────────────────────────────

/**
 * Feed the Worker's literal env values into `process.env` so `astro:env`
 * server secrets (`getSecret`) resolve while Astro runs in the node process
 * — config loading and node prerendering read env from `process.env`. This
 * is the role upstream's `loadWranglerEnv` (wrangler `vars` + `.dev.vars`)
 * plays at `astro:config:done`. Strings pass through, `Redacted<string>`s
 * are unwrapped, numbers/booleans are stringified; everything else
 * (Effects, resource bindings) is skipped — those are delivered as real
 * bindings at runtime, not build-time values. Exported for testing.
 */
export const applyWorkerEnvToProcess = (
  env: Record<string, unknown> | undefined,
): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const [key, value] of Object.entries(env ?? {})) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else if (
        Redacted.isRedacted(value) &&
        typeof Redacted.value(value) === "string"
      ) {
        process.env[key] = Redacted.value(value) as string;
      } else if (typeof value === "number" || typeof value === "boolean") {
        process.env[key] = String(value);
      }
    }
  });

const failWith =
  (message: string) =>
  (cause: unknown): SourceProviderError =>
    new SourceProviderError({
      provider: PROVIDER,
      message:
        cause instanceof Error && cause.message
          ? `${message}: ${cause.message}`
          : message,
      cause,
    });

/** Extract the asset-routing config from raw `props.assets` (drop non-config keys). */
const assetConfigFromProps = (
  assets: SourceContext["assets"],
): Record<string, unknown> | undefined => {
  if (assets === undefined || typeof assets === "string") {
    return undefined;
  }
  const { directory: _directory, path: _path, hash: _hash, ...config } = assets;
  return Object.keys(config).length > 0 ? config : undefined;
};

/**
 * Resolve the Worker env into the plain strings the build child applies to
 * its `process.env` — same filter as {@link applyWorkerEnvToProcess}, but
 * producing JSON-safe data that can cross the process boundary.
 */
const resolveBuildEnv = (
  env: Record<string, unknown> | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (
      Redacted.isRedacted(value) &&
      typeof Redacted.value(value) === "string"
    ) {
      out[key] = Redacted.value(value) as string;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    }
  }
  return out;
};

/**
 * The production build runs in a disposable child process with
 * `cwd = project root` (see `core/BuildChild.ts`): the natively-loaded
 * `astro.config.*` executes user plugins/integrations that may read the
 * cwd, mutate `process.env`, or `process.chdir` — none of which may touch
 * the engine process. The shared `core/BuildChildRunner`
 * entry imports this module in the child and calls the exported
 * {@link buildInChild}.
 */
export interface AstroBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly env: Record<string, string>;
  readonly sessionKVBindingName: string | undefined;
  readonly sessions: boolean | undefined;
  readonly sessionDevKV: boolean | undefined;
  readonly prerenderEnvironment: "workerd" | "node" | undefined;
  readonly astro: AstroSourceOptions["astro"];
  readonly config: string | undefined;
}

export const buildInChild = (config: AstroBuildChildConfig) =>
  Effect.gen(function* () {
    // Worker env → process.env, confined to this disposable child (astro's
    // config loading and integrations read env at build time).
    yield* Effect.sync(() => {
      for (const [key, value] of Object.entries(config.env)) {
        process.env[key] = value;
      }
    });
    const astro = yield* FrameworkCore.Framework.pipe(
      Effect.provide(
        Astro.layer({
          root: config.rootDir,
          target: cloudflareTarget({
            worker: {
              compatibilityDate: config.compatibilityDate,
              compatibilityFlags: config.compatibilityFlags,
            },
            sessionKVBindingName: config.sessionKVBindingName,
            sessions: config.sessions,
            sessionDevKV: config.sessionDevKV,
            prerenderEnvironment: config.prerenderEnvironment,
          }),
          astro: config.astro,
          config: config.config,
        }),
      ),
    );
    return yield* astro.build({ root: config.rootDir });
  });

const makeAstroSourceProvider = (
  options: AstroSourceOptions,
): SourceProvider => {
  /** Canonical absolute project root (a relative `rootDir` resolves from cwd). */
  const resolveRoot = Effect.map(Path.Path, (path) =>
    path.resolve(options.rootDir ?? process.cwd()),
  );

  const framework = (rootDir: string, vite: CloudflareVitePluginOptions) =>
    FrameworkCore.Framework.pipe(
      Effect.provide(
        Astro.layer({
          root: rootDir,
          // This module IS the alchemy Cloudflare Worker source provider, so
          // it constructs the Cloudflare deploy target directly (as a value)
          // rather than resolving the default specifier.
          target: cloudflareTarget({
            worker: vite,
            sessionKVBindingName: options.sessionKVBindingName,
            sessions: options.sessions,
            sessionDevKV: options.sessionDevKV,
            prerenderEnvironment: options.prerenderEnvironment,
          }),
          astro: options.astro,
          config: options.config,
        }),
      ),
    );

  return {
    ownsAssets: true,

    build: (ctx) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const rootDir = yield* resolveRoot;
        const output = yield* runBuildChild({
          module: import.meta.url,
          rootDir,
          framework: "astro",
          config: {
            rootDir,
            compatibilityDate: ctx.compatibility.date,
            compatibilityFlags: ctx.compatibility.flags,
            env: resolveBuildEnv(ctx.env),
            sessionKVBindingName: options.sessionKVBindingName,
            sessions: options.sessions,
            sessionDevKV: options.sessionDevKV,
            prerenderEnvironment: options.prerenderEnvironment,
            astro: options.astro,
            config: options.config,
          } satisfies AstroBuildChildConfig,
        }).pipe(
          Effect.mapError((error) =>
            failWith("Astro build failed")(error.cause ?? error),
          ),
        );
        const files = (output.serverModules ?? []).map(
          (module): BundleFile => ({
            path: module.name,
            content: module.content,
            hash: module.hash,
          }),
        );
        const [bundleHash, assets, input] = yield* Effect.all(
          [
            sha256Object(
              files.map((file) => ({ path: file.path, hash: file.hash })),
            ),
            output.clientDirectory
              ? readClientAssets(
                  path.resolve(rootDir, output.clientDirectory),
                  assetConfigFromProps(ctx.assets),
                )
              : Effect.succeed(undefined),
            hashAstroInput(
              rootDir,
              options.memo,
              Effect.succeed(output.externalWorkspaces ?? []),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const bundle: BundleOutput | undefined =
          files.length > 0
            ? {
                files: files as [BundleFile, ...Array<BundleFile>],
                hash: bundleHash,
              }
            : undefined;
        if (bundle === undefined && assets === undefined) {
          return yield* new SourceProviderError({
            provider: PROVIDER,
            message: "Astro build produced neither assets nor server output",
          });
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
        } satisfies SourceBuildOutput;
      }),

    hash: (_ctx, previous) =>
      Effect.gen(function* () {
        const rootDir = yield* resolveRoot;
        const { hash, workspaces } = yield* hashAstroInput(
          rootDir,
          options.memo,
          Effect.succeed(previous?.additionalWorkspaces ?? []),
        );
        return { input: hash, additionalWorkspaces: workspaces };
      }),

    dev: (ctx) =>
      Effect.gen(function* () {
        const rootDir = yield* resolveRoot;
        yield* applyWorkerEnvToProcess(ctx.env);
        const queueConsumers = yield* ctx.worker.queueConsumers;
        const astro = yield* framework(rootDir, {
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          worker: {
            name: ctx.worker.name,
            bindings: ctx.worker.bindings,
            durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
            hyperdrives: ctx.worker.hyperdrives,
            queueConsumers,
            assets: ctx.worker.assets,
          },
          context: ctx.runtimeContext,
        });
        const server = yield* astro
          .dev({ root: rootDir, port: 0 })
          .pipe(Effect.mapError(failWith("Astro dev server failed to start")));
        return {
          mode: "server",
          url: new URL(server.url),
        } satisfies SourceDevHandle;
      }),
  };
};

/**
 * Mirror of alchemy's `WorkerSourceModule`: the default export's
 * `make(options)` builds a {@link SourceProvider} from the descriptor's
 * JSON-serializable options.
 */
const make = (
  options: unknown,
): Effect.Effect<SourceProvider, SourceProviderError, SourceServices> =>
  Effect.sync(() =>
    makeAstroSourceProvider((options ?? {}) as AstroSourceOptions),
  );

export default { make };
