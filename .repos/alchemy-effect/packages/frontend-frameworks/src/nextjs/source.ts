/**
 * The alchemy Worker source-provider entry for Next.js
 * (`@alchemy.run/frontend-frameworks/nextjs/source`).
 *
 * The default export implements alchemy's `WorkerSourceModule` contract
 * (`packages/alchemy/src/Cloudflare/Workers/Source.ts`) **structurally** —
 * this package deliberately does not import alchemy types. The shapes
 * mirrored here are:
 *
 * - `WorkerSourceModule` — `{ make(options) => Effect<SourceProvider> }`
 * - `SourceProvider` — `{ ownsAssets, build(ctx), hash(ctx, previous), dev(ctx) }`
 * - `SourceBuildOutput` — `{ bundle: { files, hash }, assets: AssetReadResult, hash }`
 * - `AssetReadResult` — the manifest shape alchemy's asset uploader consumes
 *   (per-file hash = sha256 hex truncated to 32 chars, the Workers Assets
 *   API's content-address format)
 *
 * `build()` wraps this package's `Framework` service (the OpenNext-based,
 * wrangler-free pipeline in `Nextjs.ts`): server modules become the worker
 * bundle (entry first), `.open-next/assets` becomes the static-assets
 * manifest, and the project tree is content-hashed for rebuild-free diffs.
 * `hash()` never builds — it recomputes the input-tree hash (including this
 * package's version, so an adapter upgrade busts the memo). `dev()` is v1
 * preview parity: the built worker served under cloudflare-runtime (workerd);
 * ISR revalidation writes are a documented no-op (read-only static-assets
 * incremental cache).
 */
import type {
  BindingHooks,
  RuntimeWorker,
} from "@alchemy.run/cloudflare-runtime/core";
import * as FrameworkCore from "../core/index.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";
import { createRequire } from "node:module";
import { runBuildChild } from "../core/BuildChild.ts";
import * as Nextjs from "./Nextjs.ts";

const packageVersion: string = createRequire(import.meta.url)(
  "../../package.json",
).version;

const PROVIDER = "@alchemy.run/frontend-frameworks/nextjs/source";

// ─────────────────────────────────────────────────────────────────────
// Structural mirrors of alchemy's Source.ts contract
// ─────────────────────────────────────────────────────────────────────

/**
 * Structural mirror of alchemy's `Cloudflare.Workers.SourceProviderError`
 * (same `_tag`, so alchemy-side `Effect.catchTag` handles it as its own).
 */
export class SourceProviderError extends Data.TaggedError(
  "Cloudflare.Workers.SourceProviderError",
)<{
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Mirror of alchemy's `SourceHash` (the Worker `hash` attribute slots). */
export interface SourceHash {
  readonly bundle: string | undefined;
  readonly assets: string | undefined;
  readonly input: string | undefined;
  readonly additionalWorkspaces: Array<string> | undefined;
}

/** Mirror of alchemy's `Bundle.BundleFile`. */
export interface SourceBundleFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly hash: string;
}

/** Mirror of alchemy's `AssetReadResult` (Workers Assets manifest shape). */
export interface SourceAssets {
  directory: string;
  config: Record<string, unknown> | undefined;
  manifest: Record<string, { hash: string; size: number }>;
  _headers: string | undefined;
  _redirects: string | undefined;
  hash: string;
}

/** Mirror of alchemy's `SourceBuildOutput`. */
export interface SourceBuildOutput {
  readonly bundle:
    | { readonly files: Array<SourceBundleFile>; readonly hash: string }
    | undefined;
  readonly assets: SourceAssets | undefined;
  readonly hash: SourceHash;
}

/** The subset of alchemy's `SourceContext` this provider consumes. */
export interface SourceContext {
  readonly id: string;
  readonly workerName: string;
  readonly compatibility: {
    readonly date: string;
    readonly flags: Array<string>;
  };
  readonly assets?: string | Record<string, unknown> | undefined;
}

type WorkerWiring = Omit<
  RuntimeWorker<BindingHooks>,
  "compatibilityDate" | "compatibilityFlags" | "modules"
>;

/** The subset of alchemy's `DevContext` this provider consumes. */
export interface DevContext extends SourceContext {
  readonly worker: {
    readonly name: string;
    readonly bindings: NonNullable<WorkerWiring["bindings"]>;
    readonly durableObjectNamespaces: NonNullable<
      WorkerWiring["durableObjectNamespaces"]
    >;
    readonly hyperdrives: NonNullable<WorkerWiring["hyperdrives"]>;
    readonly queueConsumers: Effect.Effect<
      NonNullable<WorkerWiring["queueConsumers"]>
    >;
    readonly assets: WorkerWiring["assets"] | undefined;
  };
  /**
   * The host's runtime stack (a `Context.Context<RuntimeServices>`) — the
   * dev binding proxy is hosted in it instead of the credential-free
   * internal layer, so `Alchemy.remote()` bindings resolve in dev.
   */
  readonly runtimeContext: unknown;
}

export type SourceDevHandle = { readonly mode: "server"; readonly url: URL };

export type SourceError = SourceProviderError | PlatformError;

export type SourceServices = FileSystem.FileSystem | Path.Path;

/** Mirror of alchemy's `SourceProvider` (the arms this module implements). */
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
 * Controls which project files are content-hashed to decide whether the
 * OpenNext build needs to re-run. Mirrors the semantics of alchemy's
 * `MemoOptions` (`Command/Memo.ts`) with a built-in glob matcher:
 * `**` crosses directory boundaries, `*`/`?` stay within a segment.
 */
export interface NextjsMemoOptions {
  /** Glob patterns of files to hash, relative to the project root. @default all files */
  readonly include?: Array<string> | undefined;
  /** Glob patterns to exclude from hashing. Build outputs (`.next`, `.open-next`, `dist`) and `node_modules` are always excluded. */
  readonly exclude?: Array<string> | undefined;
  /**
   * Include the nearest package-manager lockfile in the hash, even when it
   * lives above the project root (e.g. a monorepo root).
   * @default true when both `include` and `exclude` are unset; false otherwise
   */
  readonly lockfile?: boolean | undefined;
}

/**
 * The JSON-serializable options of the `@alchemy.run/frontend-frameworks/nextjs/source`
 * descriptor (`WorkerProps.source.options`). Must stay JSON-stable — the
 * descriptor persists in state and participates in the Worker metadata hash.
 */
export interface NextjsSourceOptions {
  /** The Next.js project root. Defaults to the process working directory. */
  readonly root?: string | undefined;
  /** Rebuild-scope configuration (which files bust the build memo). */
  readonly memo?: NextjsMemoOptions | undefined;
  /** Path of the OpenNext config, relative to the project root. @default "open-next.config.ts" */
  readonly configPath?: string | undefined;
  /**
   * The command the OpenNext pipeline runs to build the Next.js app. A
   * `buildCommand` in the project's `open-next.config.ts` takes precedence.
   * @default "npx next build"
   */
  readonly buildCommand?: string | undefined;
  /** Skip the internal `next build` (reuse an existing `.next`). */
  readonly skipNextBuild?: boolean | undefined;
  /** Minify the OpenNext bundling steps and the final bundle pass. */
  readonly minify?: boolean | undefined;
  /** Enable OpenNext debug logging (and verbose workerd output in dev). */
  readonly debug?: boolean | undefined;
  /** Dev-server behavior (JSON-stable; does not affect the build). */
  readonly dev?:
    | {
        /**
         * - `"preview"` (default): build the OpenNext worker and serve it
         *   under `cloudflare-runtime` (workerd) — production parity, no HMR.
         * - `"hmr"`: run the real `next dev` (Turbopack HMR) in Node with the
         *   worker's bindings proxied from `cloudflare-runtime` onto
         *   OpenNext's `getCloudflareContext()` contract. App code runs in
         *   Node, not workerd — CF-specific runtime behavior and ISR/caching
         *   semantics still need `"preview"`.
         * @default "preview"
         */
        readonly mode?: "preview" | "hmr" | undefined;
      }
    | undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Hashing helpers (mirroring alchemy's Memo.ts / Assets.ts semantics)
// ─────────────────────────────────────────────────────────────────────

const sha256Hex = (input: string | Uint8Array): Effect.Effect<string> =>
  Effect.sync(() =>
    NodeCrypto.createHash("sha256").update(input).digest("hex"),
  );

/** JSON.stringify with recursively sorted object keys (stable across runs). */
const stableStringify = (value: unknown): string => {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, entry]) => [k, stable(entry)]),
      );
    }
    return v;
  };
  return JSON.stringify(stable(value ?? null));
};

/**
 * Compile a glob to a RegExp: `**` crosses `/` boundaries, `*` and `?` stay
 * within a path segment. Enough for memo scoping (`app/**`, `package.json`);
 * not a full gitignore engine.
 */
const globToRegExp = (glob: string): RegExp => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` also matches zero directories.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
};

/**
 * Directories that are never inputs: VCS metadata and this integration's own
 * build outputs. Pruning them is load-bearing — `build()` writes `.next`,
 * `.open-next`, and `dist` into the project root, so hashing them would make
 * every deploy dirty its own memo.
 */
const ALWAYS_PRUNED = new Set([
  "node_modules",
  ".git",
  ".next",
  ".open-next",
  "dist",
  ".turbo",
  ".vercel",
  ".alchemy",
  ".wrangler",
]);

const ALWAYS_IGNORED_FILES = new Set([".DS_Store"]);

/** Recursively list files under `root` (relative, `/`-separated), pruning `prune`d directories. */
const listProjectFiles = Effect.fn(function* (
  root: string,
  prune: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const out: Array<string> = [];
  const walk = (relative: string): Effect.Effect<void, PlatformError, never> =>
    Effect.gen(function* () {
      const absolute = relative === "" ? root : path.join(root, relative);
      const entries = yield* fs.readDirectory(absolute);
      for (const entry of entries) {
        const rel = relative === "" ? entry : `${relative}/${entry}`;
        const info = yield* fs.stat(path.join(root, rel));
        if (info.type === "Directory") {
          if (!prune.has(entry)) {
            yield* walk(rel);
          }
        } else if (info.type === "File" && !ALWAYS_IGNORED_FILES.has(entry)) {
          out.push(rel);
        }
      }
    });
  yield* walk("");
  return out.sort();
});

const findUp = Effect.fn(function* (start: string, filenames: Array<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = start;
  for (;;) {
    for (const filename of filenames) {
      const candidate = path.join(dir, filename);
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
});

/**
 * Content-hash the project's input tree. Deterministic for an unchanged tree
 * and machine-independent for identical bytes: only root-relative paths are
 * hashed, never absolute ones. The material additionally covers this
 * package's version and the build-affecting options, so an adapter upgrade
 * or an options change busts the memo without any file edit.
 */
const hashInputTree = Effect.fn(function* (
  root: string,
  options: NextjsSourceOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const memo = options.memo ?? {};
  const include = (memo.include ?? ["**/*"]).map(globToRegExp);
  const exclude = (memo.exclude ?? []).map(globToRegExp);
  const files = (yield* listProjectFiles(root, ALWAYS_PRUNED)).filter(
    (file) =>
      include.some((re) => re.test(file)) &&
      !exclude.some((re) => re.test(file)),
  );
  const path = yield* Path.Path;
  const entries = yield* Effect.forEach(
    files,
    (file) =>
      fs.readFile(path.join(root, file)).pipe(
        Effect.flatMap(sha256Hex),
        Effect.map((hash) => `${file}:${hash}`),
      ),
    { concurrency: 16 },
  );
  // Mirror alchemy's Memo.ts default: the nearest lockfile participates
  // only when the memo scope wasn't explicitly narrowed.
  const includeLockfile = memo.lockfile ?? !(memo.include || memo.exclude);
  let lockfileHash: string | undefined;
  if (includeLockfile) {
    const lockfile = yield* findUp(root, [
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]);
    if (lockfile !== undefined) {
      lockfileHash = yield* fs
        .readFile(lockfile)
        .pipe(Effect.flatMap(sha256Hex));
    }
  }
  return yield* sha256Hex(
    stableStringify({
      version: packageVersion,
      options: {
        configPath: options.configPath,
        buildCommand: options.buildCommand,
        skipNextBuild: options.skipNextBuild,
        minify: options.minify,
      },
      files: entries,
      lockfile: lockfileHash,
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────
// Assets (mirror of alchemy's readAssets manifest semantics)
// ─────────────────────────────────────────────────────────────────────

const MAX_ASSET_SIZE = 1024 * 1024 * 25; // 25MB (Workers Assets limit)
const MAX_ASSET_COUNT = 20_000;

const maybeReadString = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(file)
    .pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * Read the client directory into the Workers Assets manifest shape alchemy's
 * uploader consumes: keys are `/`-prefixed paths, per-file hash is the sha256
 * hex digest truncated to 32 chars (the API's content-address format), and
 * the aggregate `hash` covers config + manifest + `_headers`/`_redirects`.
 */
const readClientAssets = Effect.fn(function* (
  directory: string,
  config: Record<string, unknown> | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [files, _headers, _redirects] = yield* Effect.all([
    // The client directory is a build product (`.open-next/assets`): every
    // file in it is servable, so nothing is pruned (mirroring readAssets).
    listProjectFiles(directory, new Set<string>()),
    maybeReadString(path.join(directory, "_headers")),
    maybeReadString(path.join(directory, "_redirects")),
  ]);
  const ignore = yield* maybeReadString(path.join(directory, ".assetsignore"));
  const ignored = (ignore ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(globToRegExp);
  const manifest: Record<string, { hash: string; size: number }> = {};
  let count = 0;
  yield* Effect.forEach(
    files,
    Effect.fn(function* (name) {
      if (
        name === ".assetsignore" ||
        name === "_headers" ||
        name === "_redirects" ||
        ignored.some((re) => re.test(name))
      ) {
        return;
      }
      const file = path.join(directory, name);
      const stat = yield* fs.stat(file);
      const size = Number(stat.size);
      if (size > MAX_ASSET_SIZE) {
        return yield* new SourceProviderError({
          provider: PROVIDER,
          message: `Asset ${name} is too large (${(size / 1024 / 1024).toFixed(1)} MB; the Workers Assets limit is 25 MB)`,
        });
      }
      count++;
      if (count > MAX_ASSET_COUNT) {
        return yield* new SourceProviderError({
          provider: PROVIDER,
          message: `Too many assets in ${directory} (the Workers Assets limit is ${MAX_ASSET_COUNT})`,
        });
      }
      const hash = (yield* fs
        .readFile(file)
        .pipe(Effect.flatMap(sha256Hex))).slice(0, 32);
      manifest[`/${name}`] = { hash, size };
    }),
    { concurrency: 16 },
  );
  const sortedManifest = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  // Like alchemy's readAssets, `directory` is deliberately excluded from the
  // hash material: identical bytes at a different absolute path must produce
  // the same hash.
  const hash = yield* sha256Hex(
    stableStringify({ config, manifest: sortedManifest, _headers, _redirects }),
  );
  return {
    directory,
    config,
    manifest: sortedManifest,
    _headers,
    _redirects,
    hash,
  } satisfies SourceAssets;
});

// ─────────────────────────────────────────────────────────────────────
// The provider
// ─────────────────────────────────────────────────────────────────────

const assetsConfigOf = (
  ctx: SourceContext,
): Record<string, unknown> | undefined =>
  ctx.assets !== undefined && typeof ctx.assets !== "string"
    ? (ctx.assets as Record<string, unknown>)
    : undefined;

const frameworkError = (
  cause: FrameworkCore.FrameworkError,
): SourceProviderError =>
  new SourceProviderError({
    provider: PROVIDER,
    message: cause.message,
    cause,
  });

/** Run `use` against a freshly-built `Framework` service for `options`. */
const withFramework = <A, E, R>(
  options: Nextjs.NextjsFrameworkOptions,
  use: (
    framework: FrameworkCore.Framework["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const framework = yield* FrameworkCore.Framework;
    return yield* use(framework);
  }).pipe(Effect.provide(Nextjs.make(options)));

/**
 * The production build runs in a disposable child process with
 * `cwd = project root` (see `core/BuildChild.ts`). The OpenNext pipeline
 * itself already runs in its own child (`runner.mjs`, nested inside this
 * one), but the surrounding steps — `open-next.config.ts` handling, the
 * final bundle pass, cache population — execute framework/user code that
 * must not run in the engine process either. The shared `core/BuildChildRunner`
 * entry imports this module in the child and calls the exported
 * {@link buildInChild}.
 */
export interface NextjsBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly configPath: string | undefined;
  readonly buildCommand: string | undefined;
  readonly skipNextBuild: boolean | undefined;
  readonly minify: boolean | undefined;
  readonly debug: boolean | undefined;
}

export const buildInChild = (config: NextjsBuildChildConfig) =>
  withFramework(
    {
      root: config.rootDir,
      vite: {
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: config.compatibilityFlags,
      },
      nextjs: {
        configPath: config.configPath,
        buildCommand: config.buildCommand,
        skipNextBuild: config.skipNextBuild,
        minify: config.minify,
        debug: config.debug,
      },
    },
    (framework) => framework.build({ root: config.rootDir }),
  );

const makeProvider = (options: NextjsSourceOptions): SourceProvider => {
  const frameworkOptions = (
    ctx: SourceContext,
  ): Nextjs.NextjsFrameworkOptions => ({
    root: options.root,
    vite: {
      compatibilityDate: ctx.compatibility.date,
      compatibilityFlags: ctx.compatibility.flags,
    },
    nextjs: {
      configPath: options.configPath,
      buildCommand: options.buildCommand,
      skipNextBuild: options.skipNextBuild,
      minify: options.minify,
      debug: options.debug,
    },
    dev: options.dev,
  });

  const resolveRoot = Effect.fn(function* () {
    const path = yield* Path.Path;
    return path.resolve(
      options.root ?? (yield* Effect.sync(() => process.cwd())),
    );
  });

  return {
    ownsAssets: true,

    build: Effect.fn(function* (ctx) {
      const root = yield* resolveRoot();
      const output = yield* runBuildChild({
        module: import.meta.url,
        rootDir: root,
        framework: "nextjs",
        config: {
          rootDir: root,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          configPath: options.configPath,
          buildCommand: options.buildCommand,
          skipNextBuild: options.skipNextBuild,
          minify: options.minify,
          debug: options.debug,
        } satisfies NextjsBuildChildConfig,
      }).pipe(Effect.mapError(frameworkError));
      if (
        output.serverModules === undefined ||
        output.serverModules.length === 0
      ) {
        return yield* new SourceProviderError({
          provider: PROVIDER,
          message: "The OpenNext build produced no server modules",
        });
      }
      const files = output.serverModules.map((file): SourceBundleFile => ({
        path: file.name,
        content: file.content,
        hash: file.hash,
      }));
      const bundleHash = yield* sha256Hex(
        stableStringify(files.map(({ path, hash }) => ({ path, hash }))),
      );
      const [assets, input] = yield* Effect.all([
        output.clientDirectory !== undefined
          ? readClientAssets(output.clientDirectory, assetsConfigOf(ctx))
          : Effect.succeed(undefined),
        hashInputTree(root, options),
      ]);
      return {
        bundle: { files, hash: bundleHash },
        assets,
        hash: {
          bundle: bundleHash,
          assets: assets?.hash,
          input,
          additionalWorkspaces: undefined,
        },
      } satisfies SourceBuildOutput;
    }),

    // Rebuild-free: the input-tree hash is the change signal (like the vite
    // source). `previous` is never consulted — state can be stale/foreign.
    hash: Effect.fn(function* (_ctx, _previous) {
      const root = yield* resolveRoot();
      return { input: yield* hashInputTree(root, options) };
    }),

    // Default ("preview"): always build on dev start (OpenNext memoizes
    // where possible) and serve the built worker under cloudflare-runtime
    // (workerd) with the alchemy-managed binding wiring. No HMR; ISR
    // revalidation writes are a no-op.
    // With `options.dev.mode: "hmr"`, the Framework instead runs the real
    // `next dev` (Turbopack HMR) in Node — the alchemy-managed bindings are
    // proxied through cloudflare-runtime's platform proxy onto OpenNext's
    // getCloudflareContext() contract.
    dev: Effect.fn(function* (ctx) {
      const root = yield* resolveRoot();
      const queueConsumers = yield* ctx.worker.queueConsumers;
      const devOptions: Nextjs.NextjsFrameworkOptions = {
        ...frameworkOptions(ctx),
        // The host's runtime stack (includes remote-bindings support) — the
        // dev binding proxy is hosted in it instead of the credential-free
        // internal layer, so `Alchemy.remote()` bindings resolve in dev.
        services: ctx.runtimeContext,
        vite: {
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
        },
      };
      const server = yield* withFramework(devOptions, (framework) =>
        framework.dev({ root }),
      ).pipe(Effect.mapError(frameworkError));
      return {
        mode: "server",
        url: new URL(server.url),
      } satisfies SourceDevHandle;
    }),
  };
};

/**
 * The `WorkerSourceModule` implementation: validate the descriptor options
 * and hand back the provider.
 */
const make = (
  options: unknown,
): Effect.Effect<SourceProvider, SourceProviderError, SourceServices> => {
  if (
    options !== undefined &&
    (typeof options !== "object" || Array.isArray(options))
  ) {
    return Effect.fail(
      new SourceProviderError({
        provider: PROVIDER,
        message:
          "Invalid source options: expected a plain JSON object (NextjsSourceOptions)",
      }),
    );
  }
  return Effect.succeed(makeProvider((options ?? {}) as NextjsSourceOptions));
};

export default { make };
