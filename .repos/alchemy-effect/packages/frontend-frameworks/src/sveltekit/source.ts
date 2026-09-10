/**
 * `@alchemy.run/frontend-frameworks/sveltekit/source` — alchemy Worker source provider for
 * SvelteKit projects.
 *
 * The default export satisfies alchemy's `WorkerSourceModule` contract
 * (`packages/alchemy/src/Cloudflare/Workers/Source.ts`) **structurally**:
 * the `Source*` shapes below mirror alchemy's `SourceProvider` /
 * `SourceContext` / `SourceBuildOutput` interfaces rather than importing
 * them, so this package carries no dependency on alchemy. Version skew
 * degrades to a load-time `SourceProviderError` on the alchemy side.
 *
 * Semantics mirror alchemy's built-in vite source
 * (`Workers/Sources/Vite.ts`):
 *
 * - `build()` runs the SvelteKit Framework service (programmatic Vite build
 *   with the wrangler-free in-memory Cloudflare adapter + workerd rolldown
 *   re-bundle) and maps its `BuildOutput` onto the source contract:
 *   `serverModules` (entry first) → bundle files, `clientDirectory` →
 *   assets (manifest-hashed, honoring `.assetsignore` / `_headers` /
 *   `_redirects`), project-tree hash → the `input` hash slot.
 * - `hash()` recomputes the `input` hash **without building** — a memo hash
 *   over the project tree (gitignore-aware by default, narrowable via
 *   `memo.include`/`memo.exclude`), the discovered external workspaces, the
 *   lockfile, this package's version, and the build-affecting options.
 * - `dev()` starts SvelteKit's own Vite dev server (Node SSR, full HMR)
 *   with the proxy-backed `platform`: the Worker's binding hooks
 *   (`ctx.worker.bindings`) are served on `platform.env` through
 *   cloudflare-runtime's platform proxy (workerd hosting the real local
 *   bindings), `caches` round-trips, and `cf`/`ctx` match wrangler's
 *   `getPlatformProxy` mocks. Literal `props.env` values are additionally
 *   applied as `platform.env` overrides.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import fg from "fast-glob";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { runBuildChild } from "../core/BuildChild.ts";
import { makeCloudflareTarget } from "./cloudflare.ts";
import {
  make as makeSvelteKit,
  type SvelteKitAdapterOptions,
  type SvelteKitOptions,
} from "./SvelteKit.ts";

const PROVIDER = "@alchemy.run/frontend-frameworks/sveltekit/source";

// ─────────────────────────────────────────────────────────────────────
// Structural mirror of alchemy's Worker source contract
// (packages/alchemy/src/Cloudflare/Workers/Source.ts). Do not import
// alchemy here — the contract is structural by design.
// ─────────────────────────────────────────────────────────────────────

/** Mirror of alchemy's `SourceHash`. */
export interface SourceHash {
  readonly bundle: string | undefined;
  readonly assets: string | undefined;
  readonly input: string | undefined;
  readonly additionalWorkspaces: Array<string> | undefined;
}

/** Mirror of alchemy's `Bundle.BundleFile` / `Bundle.BundleOutput`. */
export interface SourceBundleFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly hash: string;
}

export interface SourceBundleOutput {
  readonly files: [SourceBundleFile, ...Array<SourceBundleFile>];
  readonly hash: string;
}

/** Mirror of alchemy's `AssetReadResult` (`Workers/Assets.ts`). */
export interface SourceAssetReadResult {
  directory: string;
  config: Record<string, unknown> | undefined;
  manifest: Record<string, { hash: string; size: number }>;
  _headers: string | undefined;
  _redirects: string | undefined;
  hash: string;
}

/** Mirror of alchemy's `SourceBuildOutput`. */
export interface SourceBuildOutput {
  readonly bundle: SourceBundleOutput | undefined;
  readonly assets: SourceAssetReadResult | undefined;
  readonly hash: SourceHash;
}

/** Mirror of alchemy's `SourceContext` (the subset this source reads). */
export interface SourceContext {
  readonly id: string;
  readonly workerName: string;
  readonly compatibility: {
    readonly date: string;
    readonly flags: Array<string>;
  };
  readonly stack: { readonly name: string; readonly stage: string };
  readonly env: Record<string, unknown> | undefined;
  readonly assets: Record<string, unknown> | string | undefined;
}

/** Mirror of alchemy's `DevContext` (the subset this source reads). */
export interface SourceDevContext extends SourceContext {
  /**
   * Runtime wiring derived by alchemy's LocalWorkerProvider. `bindings` are
   * cloudflare-runtime `BindingHook`s — typed opaquely here to keep this
   * module free of an alchemy/cloudflare-runtime type dependency; they are
   * fed to the dev platform proxy as-is.
   */
  readonly worker: {
    readonly name: string;
    readonly bindings: ReadonlyArray<unknown>;
  };
  /**
   * The host's pre-built `Context<RuntimeServices>` (opaque here). Handed
   * to the dev platform proxy so remote()-lowered bindings resolve against
   * the host's runtime stack.
   */
  readonly runtimeContext: unknown;
}

/** Mirror of alchemy's server-mode `SourceDevHandle`. */
export interface SourceDevHandle {
  readonly mode: "server";
  readonly url: URL;
}

/**
 * Same tag as alchemy's `Cloudflare.Workers.SourceProviderError`, so the
 * errors this module raises are members of alchemy's closed `SourceError`
 * union structurally.
 */
export class SourceProviderError extends Data.TaggedError(
  "Cloudflare.Workers.SourceProviderError",
)<{
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SourceError = SourceProviderError | PlatformError;

type SourceServices = FileSystem.FileSystem | Path.Path;

/** Mirror of alchemy's `SourceProvider` (structural). */
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
    ctx: SourceDevContext,
  ) => Effect.Effect<
    SourceDevHandle,
    SourceError,
    SourceServices | Scope.Scope
  >;
}

// ─────────────────────────────────────────────────────────────────────
// Descriptor options (JSON-serializable — they persist in alchemy state
// and participate in the Worker's metadata hash)
// ─────────────────────────────────────────────────────────────────────

export interface SvelteKitMemoOptions {
  /** Glob patterns of files to hash, relative to `rootDir`. @default all non-gitignored files */
  readonly include?: Array<string> | undefined;
  /** Glob patterns to exclude. @default gitignore rules from `rootDir` up to the repo root */
  readonly exclude?: Array<string> | undefined;
  /**
   * Include the nearest package-manager lockfile in the hash.
   * @default true when both `include` and `exclude` are unset
   */
  readonly lockfile?: boolean | undefined;
}

export interface SvelteKitSourceOptions {
  /**
   * SvelteKit project root. Relative paths resolve from the process working
   * directory. @default process.cwd()
   */
  readonly rootDir?: string | undefined;
  /** Narrows the rebuild-detection input hash. */
  readonly memo?: SvelteKitMemoOptions | undefined;
  /**
   * SvelteKit configuration overrides. With a project-owned
   * `vite.config.*` (loaded natively), these merge over the options of the
   * user's own `sveltekit(...)` call (integration wins); without one they
   * are passed to `sveltekit(config)` wholesale. Must be JSON-serializable
   * — it persists in state.
   */
  readonly kit?: Record<string, unknown> | undefined;
  /** Options for the wrangler-free Cloudflare adapter. */
  readonly adapter?: SvelteKitAdapterOptions | undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Hashing (mirrors alchemy's Command/Memo.ts + Util/sha256.ts semantics:
// machine-independent — only relative paths and file bytes are hashed)
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
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stableValue(v)]),
    );
  }
  return value;
};

const sha256Stable = (input: unknown): Effect.Effect<string> =>
  sha256Hex(JSON.stringify(stableValue(input) ?? null));

/**
 * Convert gitignore-style rules into fast-glob `ignore` patterns — a copy of
 * alchemy's `Util/gitignore-rules-to-globs.ts` (common cases only).
 */
const gitignoreRulesToGlobs = (rules: ReadonlyArray<string>): Array<string> => {
  const out: Array<string> = [];
  for (const raw of rules) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    let rest = line;
    const dirOnly = rest.endsWith("/");
    if (dirOnly) {
      rest = rest.slice(0, -1);
    }
    rest = rest.replace(/\\/g, "/");
    if (rest.length === 0) continue;
    const anchored = rest.startsWith("/");
    if (anchored) {
      rest = rest.slice(1);
    }
    if (rest.length === 0) continue;
    const hasSlash = rest.includes("/");
    if (dirOnly) {
      out.push(anchored || hasSlash ? `${rest}/**` : `**/${rest}/**`);
    } else if (anchored || hasSlash) {
      out.push(rest, `${rest}/**`);
    } else {
      out.push(`**/${rest}`, `**/${rest}/**`);
    }
  }
  return out;
};

const findUp = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  cwd: string,
  filenames: Array<string>,
) {
  let dir = cwd;
  for (;;) {
    for (const filename of filenames) {
      const file = NodePath.join(dir, filename);
      if (yield* fs.exists(file)) {
        return file;
      }
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
});

/** Collect `.gitignore` rules from `cwd` up to the repo root (parents first). */
const readGitIgnoreRules = (
  fs: FileSystem.FileSystem,
  cwd: string,
): Effect.Effect<Array<string>, PlatformError> =>
  Effect.gen(function* () {
    const rules = yield* fs
      .readFileString(NodePath.join(cwd, ".gitignore"))
      .pipe(
        Effect.map((file) => file.split("\n")),
        Effect.catchTag("PlatformError", () =>
          Effect.succeed([] as Array<string>),
        ),
      );
    const parent = NodePath.dirname(cwd);
    if (parent === cwd || (yield* fs.exists(NodePath.join(cwd, ".git")))) {
      return rules;
    }
    const parentRules = yield* readGitIgnoreRules(fs, parent);
    return [...parentRules, ...rules];
  });

/**
 * Deterministic content hash of the files in `cwd` matched by `memo` —
 * mirror of alchemy's `hashDirectory` (`Command/Memo.ts`).
 */
const hashDirectory = Effect.fnUntraced(function* (
  cwd: string,
  memo: SvelteKitMemoOptions | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const include = memo?.include ?? ["**/*"];
  const exclude = memo?.exclude ?? [
    "**/.git/**",
    ...gitignoreRulesToGlobs(yield* readGitIgnoreRules(fs, cwd)),
  ];
  const lockfile = memo?.lockfile ?? !(memo?.include || memo?.exclude);
  const [files, lockfilePath] = yield* Effect.all(
    [
      Effect.promise(() =>
        fg.glob(include, { cwd, ignore: exclude, onlyFiles: true, dot: true }),
      ),
      lockfile
        ? Effect.map(
            findUp(fs, cwd, [
              "bun.lock",
              "bun.lockb",
              "package-lock.json",
              "pnpm-lock.yaml",
              "yarn.lock",
            ]),
            (file) => (file ? NodePath.relative(cwd, file) : undefined),
          )
        : Effect.succeed(undefined),
    ],
    { concurrency: "unbounded" },
  );
  if (lockfilePath && !files.includes(lockfilePath)) {
    files.push(lockfilePath);
  }
  const hashes = yield* Effect.forEach(
    files.sort(),
    (file) =>
      fs.readFile(NodePath.join(cwd, file)).pipe(
        Effect.flatMap(sha256Hex),
        Effect.map((hash) => `${file}:${hash}`),
      ),
    { concurrency: 16 },
  );
  return yield* sha256Stable(hashes);
});

/** This package's version — part of the `input` hash so an adapter upgrade busts the memo. */
const packageVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = NodePath.dirname(fileURLToPath(import.meta.url));
  const content = yield* fs.readFileString(
    NodePath.join(dir, "../../package.json"),
  );
  return (JSON.parse(content) as { version: string }).version;
});

/**
 * The rebuild-free `input` hash: project tree + external workspaces +
 * package version + build-affecting options. Mirrors alchemy's
 * `hashViteInput` semantics (`Workers/Sources/Vite.ts`) — never hashes
 * absolute paths, so relocating an identical tree is a no-op.
 */
const hashSvelteKitInput = Effect.fnUntraced(function* (
  rootDir: string,
  options: SvelteKitSourceOptions,
  workspaces: Iterable<string>,
) {
  const version = yield* packageVersion;
  const hashWorkspace = (cwd: string, memo?: SvelteKitMemoOptions) =>
    hashDirectory(NodePath.resolve(rootDir, cwd), memo).pipe(
      Effect.map(
        (hash) =>
          `${NodePath.relative(rootDir, NodePath.resolve(rootDir, cwd))}:${hash}`,
      ),
    );
  const [root, ...workspaceHashes] = yield* Effect.all(
    [
      hashWorkspace(rootDir, options.memo),
      ...Array.from(workspaces, (cwd) => hashWorkspace(cwd)),
    ],
    { concurrency: "unbounded" },
  );
  const hash = yield* sha256Stable({
    version,
    options: {
      memo: options.memo,
      kit: options.kit,
      adapter: options.adapter,
    },
    tree: [root, ...workspaceHashes.sort()],
  });
  return {
    hash,
    workspaces: Array.from(workspaces, (cwd) =>
      NodePath.relative(rootDir, NodePath.resolve(rootDir, cwd)),
    ),
  };
});

// ─────────────────────────────────────────────────────────────────────
// Assets (mirror of alchemy's `readAssets` in `Workers/Assets.ts`:
// manifest of 32-hex content hashes, honoring `.assetsignore`,
// `_headers`, `_redirects`; the overall hash excludes the directory
// path so identical bytes hash identically across machines)
// ─────────────────────────────────────────────────────────────────────

const MAX_ASSET_SIZE = 1024 * 1024 * 25; // 25MB (Cloudflare limit)
const MAX_ASSET_COUNT = 20_000;

const maybeReadString = (fs: FileSystem.FileSystem, file: string) =>
  fs
    .readFileString(file)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(error),
      ),
    );

const readAssetsDirectory = Effect.fnUntraced(function* (
  directory: string,
  config: Record<string, unknown> | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const [ignore, _headers, _redirects] = yield* Effect.all([
    maybeReadString(fs, NodePath.join(directory, ".assetsignore")),
    maybeReadString(fs, NodePath.join(directory, "_headers")),
    maybeReadString(fs, NodePath.join(directory, "_redirects")),
  ]);
  const files = yield* Effect.promise(() =>
    fg.glob(["**/*"], {
      cwd: directory,
      ignore: [
        ".assetsignore",
        "_headers",
        "_redirects",
        ...gitignoreRulesToGlobs(ignore?.split("\n") ?? []),
      ],
      onlyFiles: true,
      dot: true,
    }),
  );
  if (files.length > MAX_ASSET_COUNT) {
    return yield* Effect.fail(
      new SourceProviderError({
        provider: PROVIDER,
        message: `Too many assets in ${directory} (maximum is ${MAX_ASSET_COUNT}, found ${files.length})`,
      }),
    );
  }
  const entries = yield* Effect.forEach(
    files.sort(),
    Effect.fnUntraced(function* (name) {
      const file = NodePath.join(directory, name);
      const content = yield* fs.readFile(file);
      if (content.byteLength > MAX_ASSET_SIZE) {
        return yield* Effect.fail(
          new SourceProviderError({
            provider: PROVIDER,
            message: `Asset ${name} is too large (the maximum size is 25 MB)`,
          }),
        );
      }
      const hash = (yield* sha256Hex(content)).slice(0, 32);
      return [
        `/${name.replaceAll("\\", "/")}`,
        { hash, size: content.byteLength },
      ] as const;
    }),
    { concurrency: 16 },
  );
  const manifest = Object.fromEntries(
    [...entries].sort((a, b) => a[0].localeCompare(b[0])),
  );
  const hash = yield* sha256Stable({ config, manifest, _headers, _redirects });
  return {
    directory,
    config,
    manifest,
    _headers,
    _redirects,
    hash,
  } satisfies SourceAssetReadResult;
});

// ─────────────────────────────────────────────────────────────────────
// The provider
// ─────────────────────────────────────────────────────────────────────

const wrapFrameworkError = (error: {
  readonly message: string;
  readonly cause?: unknown;
}) =>
  new SourceProviderError({
    provider: PROVIDER,
    message: error.message,
    cause: error.cause ?? error,
  });

const assetsConfig = (
  assets: SourceContext["assets"],
): Record<string, unknown> | undefined => {
  if (assets === undefined || typeof assets === "string") {
    return undefined;
  }
  const { directory: _directory, hash: _hash, ...config } = assets;
  return Object.keys(config).length > 0 ? config : undefined;
};

/**
 * Resolve the Worker's literal env values as dev `platform.env` overrides:
 * strings pass through, `Redacted<string>`s are unwrapped, everything else
 * (Effects, resource bindings) is skipped — those are delivered as real
 * bindings through the platform proxy via `ctx.worker.bindings`. A
 * same-named literal wins over the proxied value.
 */
const resolveDevEnvOverrides = (
  env: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (
      Redacted.isRedacted(value) &&
      typeof Redacted.value(value) === "string"
    ) {
      out[key] = Redacted.value(value);
    }
  }
  return out;
};

/**
 * SvelteKit resolves its config (and the postbuild analyse/prerender worker
 * threads re-derive `outDir`) relative to `process.cwd()` — with the
 * in-memory config there is no `vite.config` file for the workers to
 * re-load, so their fallback resolves against the cwd. The build therefore
 * runs in a disposable child process whose working directory IS the project
 * root (see `core/BuildChild.ts`) — no in-process `chdir`, no process-level
 * lock, unbounded build concurrency. The shared `core/BuildChildRunner`
 * entry imports this module in the child and calls the exported
 * {@link buildInChild}.
 */
export interface SvelteKitBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly kit: Record<string, unknown> | undefined;
  readonly adapter: SvelteKitAdapterOptions | undefined;
}

export const buildInChild = (config: SvelteKitBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* makeSvelteKit({
      root: config.rootDir,
      target: makeCloudflareTarget,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      kit: config.kit,
      adapter: config.adapter,
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeSvelteKitSource = (
  options: SvelteKitSourceOptions,
): SourceProvider => {
  const rootDir = NodePath.resolve(options.rootDir ?? process.cwd());
  const frameworkOptions = (
    ctx: SourceContext,
    dev?: SvelteKitOptions["dev"],
  ): SvelteKitOptions => ({
    root: rootDir,
    // This module is Cloudflare-specific by contract (it implements alchemy's
    // Cloudflare Worker source), so it passes the target factory directly
    // instead of relying on specifier resolution from the project's
    // node_modules.
    target: makeCloudflareTarget,
    compatibilityDate: ctx.compatibility.date,
    compatibilityFlags: ctx.compatibility.flags,
    kit: options.kit,
    adapter: options.adapter,
    dev,
  });
  return {
    ownsAssets: true,
    build: Effect.fnUntraced(function* (ctx) {
      const output = yield* runBuildChild({
        module: import.meta.url,
        rootDir,
        framework: "sveltekit",
        config: {
          rootDir,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          kit: options.kit,
          adapter: options.adapter,
        } satisfies SvelteKitBuildChildConfig,
      }).pipe(Effect.mapError(wrapFrameworkError));
      if (
        output.serverModules === undefined ||
        output.serverModules.length === 0
      ) {
        return yield* Effect.fail(
          new SourceProviderError({
            provider: PROVIDER,
            message: "The SvelteKit build produced no server modules",
          }),
        );
      }
      if (output.clientDirectory === undefined) {
        return yield* Effect.fail(
          new SourceProviderError({
            provider: PROVIDER,
            message: "The SvelteKit build produced no client directory",
          }),
        );
      }
      const files = output.serverModules.map((module): SourceBundleFile => ({
        path: module.name,
        content: module.content,
        hash: module.hash,
      })) as [SourceBundleFile, ...Array<SourceBundleFile>];
      const [bundleHash, assets, input] = yield* Effect.all(
        [
          sha256Stable(files.map((file) => `${file.path}:${file.hash}`)),
          readAssetsDirectory(
            NodePath.resolve(rootDir, output.clientDirectory),
            assetsConfig(ctx.assets),
          ),
          hashSvelteKitInput(rootDir, options, output.externalWorkspaces),
        ],
        { concurrency: "unbounded" },
      );
      return {
        bundle: { files, hash: bundleHash },
        assets,
        hash: {
          bundle: bundleHash,
          assets: assets.hash,
          input: input.hash,
          additionalWorkspaces: input.workspaces,
        },
      } satisfies SourceBuildOutput;
    }),
    hash: Effect.fnUntraced(function* (_ctx, previous) {
      const { hash, workspaces } = yield* hashSvelteKitInput(
        rootDir,
        options,
        previous?.additionalWorkspaces ?? [],
      );
      return { input: hash, additionalWorkspaces: workspaces };
    }),
    dev: Effect.fnUntraced(function* (ctx: SourceDevContext) {
      const framework = yield* makeSvelteKit(
        frameworkOptions(ctx, {
          env: resolveDevEnvOverrides(ctx.env),
          bindings: ctx.worker.bindings,
          // The host's runtime stack (includes remote-bindings support) —
          // the dev platform proxy is hosted in it instead of the
          // credential-free internal layer, so `Alchemy.remote()` bindings
          // resolve in dev.
          services: ctx.runtimeContext,
        }),
      );
      const server = yield* framework
        .dev({ root: rootDir, port: 0 })
        .pipe(Effect.mapError(wrapFrameworkError));
      return {
        mode: "server",
        url: new URL(server.url),
      } satisfies SourceDevHandle;
    }),
  };
};

/**
 * The `WorkerSourceModule` contract: alchemy dynamically imports this module
 * and calls `make(descriptor.options)`.
 */
const sourceModule = {
  make: (
    options: unknown,
  ): Effect.Effect<SourceProvider, SourceProviderError> =>
    Effect.succeed(
      makeSvelteKitSource((options ?? {}) as SvelteKitSourceOptions),
    ),
};

export default sourceModule;
