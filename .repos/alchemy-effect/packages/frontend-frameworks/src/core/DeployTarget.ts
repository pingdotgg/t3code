import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import type * as Scope from "effect/Scope";
import * as NodePath from "node:path";
import type { BuildOutput } from "./BuildOutput.ts";
import { loadProjectModule } from "./Loader.ts";

export class DeployTargetError extends Data.TaggedError<"DeployTargetError">(
  "DeployTargetError",
)<{
  /** The target platform involved (e.g. "cloudflare"), when known. */
  readonly platform?: string | undefined;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Services a target hook may require. The same set the e2e harness (and the
 * alchemy-side adapters) provide to `Framework` layers while building them.
 */
export type DeployTargetServices = FileSystem.FileSystem | Path.Path;

/**
 * Bundler-facing settings a target contributes to any pass that resolves or
 * bundles *server* code for it — the framework's own server build and/or the
 * target's finishing pass. Platform-neutral: just conditions and externals,
 * no bundler-specific plugin types.
 */
export interface DeployTargetBundleOptions {
  /**
   * Module-resolution conditions for server code, most specific first
   * (e.g. `["workerd", "worker", "module", "browser"]` for Cloudflare).
   */
  readonly conditions?: ReadonlyArray<string> | undefined;
  /**
   * Import-specifier prefixes that must stay external to the bundle because
   * the target runtime provides them (e.g. `["cloudflare:"]`; AWS might use
   * `["@aws-sdk/"]` when the runtime ships the SDK).
   */
  readonly external?: ReadonlyArray<string> | undefined;
  /** `package.json` main fields, in resolution order (e.g. `["module", "main"]`). */
  readonly mainFields?: ReadonlyArray<string> | undefined;
}

/**
 * The user's own server entry — the generic carriage for "a user worker/
 * function entry that wraps the framework's emitted entry".
 *
 * Some apps need their own module to be the deployed entry point instead of
 * the framework's: on Cloudflare Workers the canonical case is a worker entry
 * that wraps the framework's fetch handler and additionally exports Durable
 * Object / Workflow classes, which must live on the same worker for their
 * bindings to resolve. The pattern is platform-generic (an AWS target could
 * carry a handler module that wraps the framework handler with middleware),
 * so the carriage lives on the {@link DeployTarget} contract:
 *
 * - The **target config** carries the raw user value in its own shape
 *   (Cloudflare: the vite/rolldown plugin's `main` option). The target
 *   surfaces it here so framework packages can consult it platform-neutrally
 *   (config stays opaque to framework-core).
 * - The **framework package** honors it in two places: the user entry becomes
 *   the bundler entry the framework build/dev pipeline serves (instead of the
 *   framework's own emitted entry), and the built chunk produced from it
 *   becomes `serverModules[0]` (see `selectEntryByFacade` in the collector).
 * - The **framework package** must also expose a stable importable specifier
 *   for its emitted server handler so the user entry has something to wrap.
 *   Convention: `virtual:{framework}/server-entry` (precedent: React Router's
 *   `virtual:react-router/server-build`; waku ships
 *   `virtual:waku/server-entry`).
 */
export interface DeployTargetEntry {
  /**
   * The user's entry module: an absolute path, or a path relative to the
   * project root (resolve with {@link resolveDeployTargetEntry}).
   */
  readonly main: string;
}

/**
 * Resolve a target's user-entry module ({@link DeployTargetEntry}) to an
 * absolute path against the project root. Returns `undefined` when the target
 * (or its entry) is absent — the framework's own entry should be used.
 */
export const resolveDeployTargetEntry = (
  target: Pick<DeployTarget, "entry"> | undefined,
  context: { readonly root: string },
): string | undefined =>
  target?.entry === undefined
    ? undefined
    : NodePath.isAbsolute(target.entry.main)
      ? target.entry.main
      : NodePath.resolve(context.root, target.entry.main);

/** Common inputs every target hook receives. */
export interface DeployTargetContext {
  /** Absolute project root. */
  readonly root: string;
  /** The framework driving the target (e.g. "waku", "sveltekit"), when known. */
  readonly framework?: string | undefined;
}

export interface DeployTargetBuildContext extends DeployTargetContext {
  /**
   * Process environment for a wholesale `build` child. Applied only in
   * that process — never on the engine.
   */
  readonly env?: Record<string, string> | undefined;
}

export interface DeployTargetFinishContext extends DeployTargetContext {
  /**
   * Absolute path of the on-disk server entry the framework's adapt step
   * produced, for finishing passes that re-bundle from disk (e.g. SvelteKit's
   * `_worker.js`). Omitted when the framework build is already in-memory.
   */
  readonly entry?: string | undefined;
}

export interface DeployTargetServeContext extends DeployTargetContext {
  /** The build to serve. */
  readonly output: BuildOutput;
  /** Requested port; the target may fall back to an ephemeral port. */
  readonly port?: number | undefined;
}

/** A locally-serving instance of built framework server code. */
export interface DeployTargetServer {
  /** The local URL the server is listening on. */
  readonly url: string;
  /**
   * Optional direct dispatch into the server (e.g. miniflare's
   * `dispatchFetch`). Callers fall back to plain HTTP `fetch` against `url`.
   */
  readonly fetch?:
    | ((path: string, init?: RequestInit) => Promise<Response>)
    | undefined;
}

/**
 * A deploy target — the platform a framework build is produced *for*, passed
 * to framework integrations as a plain value (a prop). Cloudflare Workers is
 * the first implementation; future targets (AWS Lambda, ...) implement the
 * same seams without any change to the framework packages.
 *
 * Only the platform-generic seams live here:
 *
 * - `bundle` — resolve/bundle conditions for server code.
 * - `build` — optional *wholesale* build takeover: when defined, the
 *   framework package delegates its entire production build to the target
 *   (the OpenNext case for Next.js). Most targets leave this undefined and
 *   let the framework drive the build.
 * - `finish` — optional finishing pass over the framework-produced
 *   {@link BuildOutput} (the SvelteKit-style post-adapt re-bundle for the
 *   target runtime). Use {@link applyDeployTargetFinish} to run it.
 * - `serve` — the target's local serving story for *built* server code
 *   (preview-parity: miniflare / cloudflare-runtime today, a Lambda emulator
 *   later). Scoped: closing the Scope stops the server. The framework's own
 *   HMR dev server is NOT this seam — dev integration that reaches inside the
 *   framework's toolchain lives in the per-framework target module.
 * - `config` — opaque target configuration carriage (Cloudflare: worker
 *   name/bindings/compatibility; AWS later: its own shape). Framework-core
 *   never inspects it.
 * - `entry` — the user's own server entry, when the target's config carries
 *   one: a module that wraps the framework's emitted entry (and, on
 *   Cloudflare, re-exports Durable Object classes). See
 *   {@link DeployTargetEntry}.
 *
 * The framework-*specific* halves of an integration (waku's adapter fork,
 * astro's integration fork, kit's in-memory adapter) are intentionally NOT
 * part of this interface. Each framework package declares its own target
 * interface extending `DeployTarget` with those hooks, and ships its
 * Cloudflare implementation as a subpath module
 * (e.g. `@alchemy.run/frontend-frameworks/waku/cloudflare`) selected via the framework's
 * `target` option.
 */
export interface DeployTarget<Config = unknown> {
  /** Stable platform identifier (e.g. "cloudflare", "aws"). */
  readonly platform: string;
  /** Opaque target configuration. Never inspected by framework-core. */
  readonly config: Config;
  /** The user's own server entry wrapping the framework's emitted entry, when configured. */
  readonly entry?: DeployTargetEntry | undefined;
  readonly bundle?: DeployTargetBundleOptions | undefined;
  readonly build?:
    | ((
        context: DeployTargetBuildContext,
      ) => Effect.Effect<BuildOutput, DeployTargetError, DeployTargetServices>)
    | undefined;
  readonly finish?:
    | ((
        output: BuildOutput,
        context: DeployTargetFinishContext,
      ) => Effect.Effect<BuildOutput, DeployTargetError, DeployTargetServices>)
    | undefined;
  readonly serve?:
    | ((
        context: DeployTargetServeContext,
      ) => Effect.Effect<
        DeployTargetServer,
        DeployTargetError,
        Scope.Scope | DeployTargetServices
      >)
    | undefined;
}

/**
 * Identity helper with inference: preserves the concrete target type
 * (including framework-specific extensions) while checking it against the
 * {@link DeployTarget} contract.
 */
export const makeDeployTarget = <T extends DeployTarget>(target: T): T =>
  target;

/** Structural guard for {@link DeployTarget} values. */
export const isDeployTarget = (value: unknown): value is DeployTarget =>
  Predicate.hasProperty(value, "platform") &&
  typeof (value as { platform: unknown }).platform === "string" &&
  Predicate.hasProperty(value, "config");

/**
 * How a target is passed to a framework integration:
 *
 * - a {@link DeployTarget} value — used as-is (full type safety over the
 *   target's config; build it in your config file by importing the target
 *   module directly)
 * - a factory `(config) => DeployTarget` — applied to the framework-provided
 *   config (the shape a target module's default export takes)
 * - a module specifier string (e.g. `"@alchemy.run/frontend-frameworks/waku/cloudflare"`) —
 *   loaded from the *project's* `node_modules`; the module must
 *   default-export (or named-export `target`) a target value or factory
 */
export type DeployTargetInput<
  T extends DeployTarget = DeployTarget,
  Config = unknown,
> = T | ((config: Config) => T) | string;

/** The exports a target module may provide (see {@link resolveDeployTarget}). */
interface DeployTargetModule {
  readonly default?: unknown;
  readonly target?: unknown;
}

const invalidTarget = (specifier: string) =>
  new DeployTargetError({
    message:
      `"${specifier}" does not provide a usable deploy target: expected a default export ` +
      "(or named export `target`) that is a DeployTarget value or a `(config) => DeployTarget` " +
      "factory",
  });

/**
 * Resolve a {@link DeployTargetInput} to a concrete target:
 *
 * - a string is imported from the project's own dependency tree (via
 *   `loadProjectModule`, so the project's installed target module is the one
 *   used); its default export (or named export `target`) is resolved next
 * - a factory is applied to `config`
 * - a target value is validated and returned as-is
 */
export const resolveDeployTarget: <T extends DeployTarget, Config>(
  root: string,
  input: DeployTargetInput<T, Config>,
  config: Config,
) => Effect.Effect<T, DeployTargetError> = Effect.fn(function* <
  T extends DeployTarget,
  Config,
>(root: string, input: DeployTargetInput<T, Config>, config: Config) {
  let candidate: unknown = input;
  let specifier = "the provided deploy target";
  if (typeof input === "string") {
    specifier = input;
    const module_ = yield* loadProjectModule<DeployTargetModule>(
      root,
      input,
    ).pipe(
      Effect.mapError(
        (error) =>
          new DeployTargetError({ message: error.message, cause: error.cause }),
      ),
    );
    candidate = module_.default ?? module_.target;
  }
  if (typeof candidate === "function") {
    candidate = (candidate as (config: Config) => T)(config);
  }
  if (!isDeployTarget(candidate)) {
    return yield* Effect.fail(invalidTarget(specifier));
  }
  return candidate as T;
});

/**
 * Run the target's finishing pass over a framework-produced build, if the
 * target defines one; otherwise pass the build through unchanged.
 */
export const applyDeployTargetFinish = (
  target: DeployTarget | undefined,
  output: BuildOutput,
  context: DeployTargetFinishContext,
): Effect.Effect<BuildOutput, DeployTargetError, DeployTargetServices> =>
  target?.finish !== undefined
    ? target.finish(output, context)
    : Effect.succeed(output);
