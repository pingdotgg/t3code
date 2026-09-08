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
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { Artifacts } from "../../Artifacts.ts";
import type * as Bundle from "../../Bundle/Bundle.ts";
import type { WorkflowExport } from "../Workflows/Workflow.ts";
import type { AssetReadResult, ValidationError } from "./Assets.ts";
import type { DurableObjectExport } from "./DurableObject.ts";
import { makeInlineScriptSource } from "./Sources/InlineScript.ts";
import { makePrebuiltSource } from "./Sources/Prebuilt.ts";
import { isPythonMain, makePythonSource } from "./Sources/Python.ts";
import { makeRolldownSource } from "./Sources/Rolldown.ts";
import type {
  WorkerAssetsConfig,
  WorkerProps,
  WorkerSourceDescriptor,
} from "./Worker.ts";

/**
 * The hash slots a Worker source contributes to
 * `Worker["Attributes"]["hash"]`. Slots a source doesn't use are
 * `undefined`. The `metadata` hash (#745) is deliberately NOT a source
 * slot — it covers the deploy-time metadata surface and stays owned by
 * the WorkerProvider.
 */
export interface SourceHash {
  readonly bundle: string | undefined;
  readonly assets: string | undefined;
  readonly input: string | undefined;
  /**
   * Auxiliary metadata for the `input` hash (vite's auto-detected
   * workspace directories, relative to the source root). Never compared
   * as a change signal — only carried so the next `hash()` call can
   * recompute `input` over the same workspace set.
   */
  readonly additionalWorkspaces: string[] | undefined;
}

export interface SourceBuildOutput {
  /**
   * Server bundle. `undefined` for assets-only workers (e.g. a static
   * vite site with no server environment).
   */
  readonly bundle: Bundle.BundleOutput | undefined;
  /**
   * Static assets, already read and manifest-hashed. `undefined` when the
   * source doesn't own assets — the WorkerProvider merges in the
   * props-level `assets` for those sources (see
   * {@link SourceProvider.ownsAssets}).
   */
  readonly assets: AssetReadResult | undefined;
  /** Source-owned hash slots. Slots the source doesn't use are omitted. */
  readonly hash: Partial<SourceHash>;
}

/**
 * Everything a source may need, derived once by the WorkerProvider from
 * `(id, props, stack)`. Source-specific inputs (entry module path, vite
 * options, inline script, ...) are closed over by the provider instance
 * itself — providers are resolved per Worker from props, not injected
 * once per stack.
 */
export interface SourceContext {
  /** Logical id of the Worker resource. */
  readonly id: string;
  /** Physical script name. */
  readonly workerName: string;
  readonly compatibility: {
    readonly date: string;
    readonly flags: string[];
  };
  /** Effect-entry vs external-entry (async workers). Drives the virtual-entry plugin. */
  readonly entry:
    | { readonly kind: "external" }
    | {
        readonly kind: "effect";
        readonly exports: Record<string, DurableObjectExport | WorkflowExport>;
      };
  readonly stack: { readonly name: string; readonly stage: string };
  /**
   * Raw `props.env`. Deliberately unresolved: env entries may be Effects
   * whose evaluation requires plan-phase context that is not available
   * inside lifecycle operations — a source that needs literal values
   * (e.g. vite's `import.meta.env` defines) resolves them itself, exactly
   * as the vite arm always has.
   */
  readonly env: Record<string, unknown> | undefined;
  /** `props.build` passthrough for rolldown-based sources. */
  readonly extraOptions: Bundle.BundleExtraOptions | undefined;
  /**
   * Raw `props.assets`. Sources that own their assets (vite) merge its
   * routing config into the assets they read out of the build; sources
   * that don't own assets never touch it (the WorkerProvider reads and
   * diffs props-level assets centrally).
   */
  readonly assets: WorkerAssetsConfig | undefined;
}

/**
 * Runtime wiring for local dev, derived by the LocalWorkerProvider.
 * Server-mode sources that embed their own workerd (the vite plugin)
 * consume `worker` + `runtimeContext`; bundle-mode sources ignore both.
 */
export interface DevContext extends SourceContext {
  readonly worker: {
    readonly bindings: BindingHook<BindingServices>[];
    readonly durableObjectNamespaces: (RuntimeDurableObject & {
      uniqueKey: string;
    })[];
    readonly hyperdrives: Record<string, Required<HyperdriveOrigin>>;
    /** Re-read on each (re)start so late-registered consumers are observed. */
    readonly queueConsumers: Effect.Effect<RuntimeQueueConsumer[]>;
    readonly assets: RuntimeAssets | undefined;
  };
  /** RuntimeServices context for providers that embed cloudflare-runtime. */
  readonly runtimeContext: Context.Context<RuntimeServices>;
}

/**
 * How a source serves local dev. Two irreducible modes:
 *
 * - `bundle` — the host runs workerd; the source supplies rebuild events
 *   and the host restarts workerd with each successful bundle.
 * - `server` — the source runs its own dev server (vite dev); the host
 *   points the WorkerProxy at `url`.
 */
export type SourceDevHandle =
  | {
      readonly mode: "bundle";
      readonly bundles: Stream.Stream<
        Bundle.BundleWatchEvent,
        SourceError,
        SourceDevServices
      >;
    }
  | {
      readonly mode: "server";
      readonly url: URL;
    };

/**
 * The closed requirements channel of a source. Anything else a source
 * needs (vite module loading, framework CLIs, workerd runtime services
 * for dev) it constructs internally — external providers must NOT demand
 * bespoke services from the WorkerProvider.
 */
export type SourceServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | Scope.Scope
  | Artifacts;

/** Requirements available to `dev()` (no per-run Artifacts cache in the local host). */
export type SourceDevServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | Scope.Scope;

/**
 * An error raised by an external source provider, wrapped at the load
 * boundary so the WorkerProvider's lifecycle error union stays closed.
 */
export class SourceProviderError extends Data.TaggedError(
  "Cloudflare.Workers.SourceProviderError",
)<{
  /** Module specifier or built-in kind. */
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SourceError =
  | Bundle.BundleError
  | ValidationError
  | PlatformError
  | SourceProviderError;

/**
 * A Worker source provider: supplies the static assets, the server
 * bundle, and hashes for memoization, plus a dev-serving story. The five
 * built-in arms (inline script, rolldown, python, prebuilt, vite) live in
 * `Workers/Sources/`; framework providers implement the same interface.
 */
export interface SourceProvider {
  /**
   * Whether this source produces its own static assets from its build
   * (vite, framework builds). When `false`, the WorkerProvider reads and
   * diffs the props-level `assets` directory centrally — including the
   * AssetsWithHash fast path — and the source only supplies the bundle.
   */
  readonly ownsAssets: boolean;

  /**
   * Full build. Called from reconcile (`putWorker`). If the build is
   * expensive it MUST be memoized per run via `Artifacts.cached` under
   * the same key `hash()` uses, so a diff that had to build doesn't
   * build twice.
   */
  readonly build: (
    ctx: SourceContext,
  ) => Effect.Effect<SourceBuildOutput, SourceError, SourceServices>;

  /**
   * Recompute the source-owned hash slots for diff, as cheaply as
   * possible and WITHOUT a full build when the source supports it.
   * `previous` is `output.hash` from state. Returns only the slots this
   * source uses; the WorkerProvider compares slot-wise against
   * `previous` — any defined slot that differs ⇒ update.
   *
   * Invariants:
   * - MUST be deterministic for an unchanged source tree and
   *   machine-independent for identical bytes (never hash absolute paths).
   * - If it cannot avoid building, it MUST route the build through the
   *   same `Artifacts.cached` key as `build()` so diff→reconcile builds
   *   once.
   * - `previous` is a hint, never truth: a source must not skip
   *   recomputation because `previous` looks fresh — it may only use it
   *   for auxiliary inputs (`additionalWorkspaces`).
   */
  readonly hash: (
    ctx: SourceContext,
    previous: SourceHash | undefined,
  ) => Effect.Effect<Partial<SourceHash>, SourceError, SourceServices>;

  /**
   * Local dev. Scoped: closing the Scope stops the watcher / dev server.
   */
  readonly dev: (
    ctx: DevContext,
  ) => Effect.Effect<
    SourceDevHandle,
    SourceError,
    SourceDevServices | Scope.Scope
  >;
}

/**
 * The contract of a dynamically-imported source-provider module: its
 * default export builds a {@link SourceProvider} from the descriptor's
 * (JSON-serializable) options. `make` provides the package's own layers
 * internally, so the closed {@link SourceServices} requirement holds.
 */
export interface WorkerSourceModule {
  readonly make: (
    options: unknown,
  ) => Effect.Effect<SourceProvider, SourceProviderError, SourceServices>;
}

/**
 * Validated provider modules memoized per specifier for the process
 * lifetime — a Worker resolves its source at least twice per deploy
 * (diff, then reconcile). `make(options)` still runs per resolution: a
 * stack can host several Workers of the same provider with different
 * options.
 */
const sourceModules = new Map<string, WorkerSourceModule>();

const importSourceModule = (
  specifier: string,
): Effect.Effect<WorkerSourceModule, SourceProviderError> =>
  Effect.suspend(() => {
    const cached = sourceModules.get(specifier);
    if (cached) {
      return Effect.succeed(cached);
    }
    return Effect.tryPromise({
      try: () => import(/* @vite-ignore */ specifier),
      catch: (cause) =>
        new SourceProviderError({
          provider: specifier,
          message:
            `Failed to import Worker source provider "${specifier}". ` +
            `Is the package installed in your project? Install it and re-run.`,
          cause,
        }),
    }).pipe(
      Effect.flatMap((mod: { default?: Partial<WorkerSourceModule> }) => {
        if (typeof mod.default?.make !== "function") {
          return Effect.fail(
            new SourceProviderError({
              provider: specifier,
              message:
                `Module "${specifier}" is not a Worker source provider: ` +
                `its default export must satisfy WorkerSourceModule ({ make(options) }).`,
            }),
          );
        }
        const module = mod.default as WorkerSourceModule;
        sourceModules.set(specifier, module);
        return Effect.succeed(module);
      }),
    );
  });

/**
 * Load an external source provider from its serializable descriptor:
 * dynamically import the module, validate the shape, and call
 * `make(options)`.
 */
export const loadSource = (
  descriptor: WorkerSourceDescriptor,
): Effect.Effect<SourceProvider, SourceProviderError, SourceServices> =>
  importSourceModule(descriptor.provider).pipe(
    Effect.flatMap((mod) => mod.make(descriptor.options)),
  );

/**
 * Resolve the {@link SourceProvider} for a Worker from its props. The
 * `source` descriptor (external providers) wins; legacy props map to the
 * built-in providers, preserving the historical precedence exactly:
 * `script` → `vite` → `.py` main → `bundle: false` → rolldown (default).
 *
 * `source` is mutually exclusive with `script`/`vite`/`main` — a source
 * is self-contained, and a provider that needs a custom entry takes it
 * in its own `options`.
 */
export const resolveSource = (
  props: WorkerProps,
): Effect.Effect<SourceProvider, SourceProviderError, SourceServices> => {
  if (props.source) {
    const conflict =
      props.script !== undefined
        ? "script"
        : props.vite
          ? "vite"
          : props.main !== undefined
            ? "main"
            : undefined;
    if (conflict) {
      return Effect.fail(
        new SourceProviderError({
          provider: props.source.provider,
          message:
            `Worker prop "source" is mutually exclusive with "${conflict}": ` +
            `a source provider is self-contained — pass a custom entry via the provider's own options instead.`,
        }),
      );
    }
    return loadSource(props.source);
  }
  if (props.script !== undefined) {
    return Effect.succeed(makeInlineScriptSource(props.script));
  }
  if (props.vite) {
    // Loaded lazily: `./Sources/Vite.ts` pulls in
    // `@alchemy.run/cloudflare-runtime/vite` (~0.5s), which is only
    // needed for vite-based workers — not for every Worker resolution.
    const vite = props.vite;
    return Effect.promise(() => import("./Sources/Vite.ts")).pipe(
      Effect.map((Vite) => Vite.makeViteSource(vite)),
    );
  }
  if (isPythonMain(props.main)) {
    return Effect.succeed(makePythonSource(props.main));
  }
  if (props.bundle === false) {
    return Effect.succeed(
      makePrebuiltSource({ main: props.main!, rules: props.rules }),
    );
  }
  return Effect.succeed(makeRolldownSource({ main: props.main! }));
};

/**
 * Derive the shared {@link SourceContext} from a Worker's props. Pure —
 * the physical `workerName` is computed by the caller (it may come from
 * persisted output state rather than the name generator).
 */
export const makeSourceContext = (params: {
  id: string;
  workerName: string;
  props: WorkerProps;
  compatibility: { date: string; flags: string[] };
  stack: { name: string; stage: string };
}): SourceContext => ({
  id: params.id,
  workerName: params.workerName,
  compatibility: params.compatibility,
  entry: params.props.isExternal
    ? { kind: "external" }
    : { kind: "effect", exports: params.props.exports ?? {} },
  stack: { name: params.stack.name, stage: params.stack.stage },
  env: params.props.env,
  extraOptions: params.props.build,
  assets: params.props.assets,
});
