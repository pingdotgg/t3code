import type * as cf from "@cloudflare/workers-types";
import * as workers from "@distilled.cloud/cloudflare/workers";
import type * as Config from "effect/Config";
import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { type MemoOptions } from "../../Command/Memo.ts";
import type { Dependencies } from "../../Dependencies.ts";
import type { InputProps } from "../../Input.ts";
import type { Named, Tag } from "../../Named.ts";
import {
  Platform,
  type Main,
  type MainRpc,
  type MakeShape,
  type PlatformProps,
  type PlatformServices,
} from "../../Platform.ts";
import {
  isResourceOfType,
  Resource,
  type ResourceClassLike,
} from "../../Resource.ts";
import type { Rpc } from "../../Rpc.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Self } from "../../Self.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Container } from "../Containers/Container.ts";
import type { DevContainerImage } from "../Containers/ContainerApplication.ts";
import type { DevOrigin } from "../Hyperdrive/Connection.ts";
import type { Providers } from "../Providers.ts";
import type { DispatchNamespace } from "../WorkersForPlatforms/DispatchNamespace.ts";
import type { WorkflowExport } from "../Workflows/Workflow.ts";
import type { Reference as ZoneReference } from "../Zone/lookup.ts";
import { type Assets, type AssetsProps } from "./Assets.ts";
import { type DurableObjectExport } from "./DurableObject.ts";
import { Request } from "./Request.ts";
import { bindWorkerAsyncBindings } from "./WorkerAsyncBindings.ts";
import type {
  WorkerBinding,
  WorkerBindingResource,
  WorkerBindings,
} from "./WorkerBinding.ts";
import { type ModuleRule, type WorkerBuildOptions } from "./WorkerBundle.ts";
import {
  makeWorkerRuntimeContext,
  type WorkerRuntimeContext,
} from "./WorkerRuntimeContext.ts";

export const WorkerTypeId = "Cloudflare.Worker";
export type WorkerTypeId = typeof WorkerTypeId;

export const isWorker = <T>(value: T): value is T & Worker =>
  isResourceOfType(value, WorkerTypeId);

export class WorkerEnvironment extends Context.Service<
  WorkerEnvironment,
  Record<string, any>
>()("Cloudflare.Workers.WorkerEnvironment") {}

export class CachePurgeError extends Data.TaggedError("CachePurgeError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Effect-native view of the Workers Cache runtime API on the execution
 * context (`ctx.cache`). Only available when the Worker has Workers Cache
 * enabled (the `cache` prop or `yield* Cloudflare.cache()`).
 */
export interface WorkerExecutionContextCache {
  /**
   * Purge cached responses by `Cache-Tag`, path prefix, or everything.
   */
  purge(
    options: cf.CachePurgeOptions,
  ): Effect.Effect<cf.CachePurgeResult, CachePurgeError, RuntimeContext>;
}

export class WorkerExecutionContext extends Context.Service<
  WorkerExecutionContext,
  {
    /**
     * Run an Effect in the background without blocking the response, keeping
     * the Worker alive until it settles. The Effect runs with the caller's
     * full context (services, tracing), and the resulting promise is
     * registered with workerd's `ctx.waitUntil`.
     */
    waitUntil<A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<void, never, R | RuntimeContext>;
    /**
     * Forward the request to the origin if the Worker throws an unhandled
     * exception, instead of returning an error page.
     */
    passThroughOnException(): Effect.Effect<void, never, RuntimeContext>;
    /**
     * The Workers Cache runtime API (`ctx.cache`).
     */
    readonly cache: WorkerExecutionContextCache;
    /**
     * The raw workerd ExecutionContext, for interop with async APIs.
     */
    readonly raw: cf.ExecutionContext;
  }
>()("Cloudflare.Workers.WorkerExecutionContext") {}

export const fromExecutionContext = (
  ctx: cf.ExecutionContext,
): WorkerExecutionContext["Service"] => ({
  raw: ctx,
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      // Register the promise with workerd un-awaited — waitUntil extends the
      // invocation's lifetime without blocking the response.
      yield* Effect.sync(() =>
        ctx.waitUntil(Effect.runPromise(effect.pipe(Effect.provide(context)))),
      );
    }),
  passThroughOnException: () => Effect.sync(() => ctx.passThroughOnException()),
  cache: {
    purge: (options) =>
      ctx.cache
        ? Effect.tryPromise({
            try: () => ctx.cache!.purge(options),
            catch: (cause) =>
              new CachePurgeError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Unknown cache purge error",
                cause,
              }),
          })
        : Effect.fail(
            new CachePurgeError({
              message:
                "ctx.cache is not available — enable Workers Cache on this " +
                "Worker (the `cache` prop or `yield* Cloudflare.cache()`) " +
                "and note it is not supported in local dev.",
            }),
          ),
  },
});

/**
 * A {@link WorkerExecutionContext} whose methods resolve the live per-event
 * context from the calling fiber at call time. Provided during the Worker's
 * init phase (plan and runtime module init) so the service can be yielded
 * and closed over in the top-level closure; every method is colored with
 * `RuntimeContext`, so it can only be *run* inside a handler, where the
 * bridge provides the real per-event context that these methods defer to.
 */
export const deferredExecutionContext: WorkerExecutionContext["Service"] = {
  get raw(): cf.ExecutionContext {
    throw new Error(
      "WorkerExecutionContext.raw is only available inside a request handler",
    );
  },
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    liveExecutionContext.pipe(
      Effect.flatMap((live) => live.waitUntil(effect)),
    ) as Effect.Effect<void, never, R | RuntimeContext>,
  passThroughOnException: () =>
    liveExecutionContext.pipe(
      Effect.flatMap((live) => live.passThroughOnException()),
    ) as Effect.Effect<void, never, RuntimeContext>,
  cache: {
    purge: (options) =>
      liveExecutionContext.pipe(
        Effect.flatMap((live) => live.cache.purge(options)),
      ) as Effect.Effect<cf.CachePurgeResult, CachePurgeError, RuntimeContext>,
  },
};

const liveExecutionContext = WorkerExecutionContext.pipe(
  Effect.flatMap((live) =>
    live === deferredExecutionContext
      ? Effect.die(
          new Error(
            "WorkerExecutionContext can only be used inside a request handler",
          ),
        )
      : Effect.succeed(live),
  ),
);

export type WorkerEvent = Exclude<
  {
    [type in keyof cf.ExportedHandler]: {
      kind: "Cloudflare.Workers.WorkerEvent";
      type: type;
      input: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[0];
      env: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[1];
      context: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[2];
    };
  }[keyof cf.ExportedHandler],
  undefined
>;

export const isWorkerEvent = (value: any): value is WorkerEvent =>
  value?.kind === "Cloudflare.Workers.WorkerEvent";

/**
 * Assets configuration that includes a pre-computed hash.
 * When hash is provided, it's used directly for diffing instead of computing from directory contents.
 * This is useful when integrating with Build resources that produce a deterministic hash.
 */
export interface AssetsWithHash extends AssetsProps {
  /**
   * Pre-computed hash of the assets. When provided, this hash is used for diffing
   * to determine if the worker needs to be redeployed.
   */
  hash: string;
}

export interface WorkerObservability extends Exclude<
  workers.PutScriptRequest["metadata"]["observability"],
  undefined
> {}

export interface WorkerLimits extends Exclude<
  workers.PutScriptRequest["metadata"]["limits"],
  undefined
> {}

export interface WorkerCache extends Exclude<
  workers.PutScriptRequest["metadata"]["cache"],
  undefined
> {}

export type WorkerPlacement = Exclude<
  workers.PutScriptRequest["metadata"]["placement"],
  undefined
>;

export const ExportedHandlerMethods = [
  "fetch",
  "tail",
  "trace",
  "tailStream",
  "scheduled",
  "test",
  "email",
  "queue",
] as const satisfies (keyof cf.ExportedHandler)[];

export type WorkerServices =
  | Worker
  | Request
  | WorkerExecutionContext
  | WorkerEnvironment
  | CloudflareEnvironment
  | Container.Application<any>
  | Self;

export type WorkerShape<Req = never> = Main<WorkerServices | Req> &
  MainRpc<WorkerServices | Req>;

export type WorkerEnv = Record<
  string,
  | string
  | number
  | boolean
  | null
  | readonly unknown[]
  | { readonly [key: string]: unknown }
  | Redacted.Redacted<string>
>;

export type WorkerBindingProps = {
  [bindingName in string]:
    | WorkerBindingResource
    | Effect.Effect<WorkerBindingResource, any, any>;
};

export type NormalizedBindings<
  Bindings extends WorkerBindingProps = {},
  AssetsConfig extends WorkerAssetsConfig | undefined = undefined,
> = {
  [B in keyof Bindings]: Bindings[B] extends Effect.Effect<
    infer T extends WorkerBindingResource,
    any,
    any
  >
    ? T extends Redacted.Redacted<infer T> | Config.Config<infer T>
      ? T
      : T
    : Extract<Bindings[B], WorkerBindingResource>;
} & (undefined extends AssetsConfig ? {} : { ASSETS: Assets });

export type WorkerAssetsConfig = string | AssetsProps | AssetsWithHash;

export interface WorkerRouteConfig {
  /**
   * URL pattern to match incoming requests against, e.g.
   * `"subdomain.example.com/*"` or `"example.com/api/*"`.
   */
  pattern: string;
  /**
   * Cloudflare zone ID. Equivalent to Wrangler's `zone_id`.
   */
  zoneId?: string;
  /**
   * Cloudflare zone name, e.g. `"example.com"`. Equivalent to Wrangler's
   * `zone_name`.
   */
  zoneName?: string;
  /**
   * Zone reference — a zone ID, zone name, or `{ zoneId, name? }` object.
   * Alternative to `zoneId` / `zoneName`.
   */
  zone?: ZoneReference;
}

export interface WorkerProps<
  Bindings extends WorkerBindingProps = any,
  Assets extends WorkerAssetsConfig | undefined =
    | WorkerAssetsConfig
    | undefined,
> extends PlatformProps {
  /**
   * Worker name override. If omitted, Alchemy derives a deterministic physical
   * name from the stack, stage, and logical ID.
   */
  name?: string;
  /**
   * Deploy this Worker into a Workers for Platforms dispatch namespace as a
   * "user worker" — a customer Worker that a platform Worker dispatches to at
   * runtime via a dynamic-dispatch binding — instead of as a regular
   * account-level Worker.
   *
   * Accepts the namespace name or a {@link DispatchNamespace} resource. The
   * Worker's put/read/delete switch from the account-level
   * `/workers/scripts` endpoints to the dispatch-namespace
   * `/workers/dispatch/namespaces/:namespace/scripts` endpoints.
   *
   * User workers are not directly routable: they have no `workers.dev`
   * subdomain, custom domains, or cron triggers, so {@link url},
   * {@link domain}, and {@link crons} are ignored when this is set. Changing
   * the namespace (or moving a Worker in or out of one) replaces the Worker,
   * since an account-level script and a dispatch-namespace script are
   * distinct cloud resources.
   *
   * @see https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
   */
  namespace?: string | DispatchNamespace;
  /**
   * Whether to enable a workers.dev URL for this worker
   * @default true
   */
  url?: boolean;
  /**
   * Static assets to serve. Can be:
   * - A string path to the assets directory
   * - An AssetsProps object with directory and config
   * - An object with path and hash (e.g., from a Build resource)
   */
  assets?: Assets;
  subdomain?: {
    enabled?: boolean;
    previewsEnabled?: boolean;
  };
  /** @internal used by Cloudflare.Website.Vite resource */
  vite?: ViteOptions;
  logpush?: boolean;
  /**
   * Cloudflare Workers Observability settings. Controls Workers Logs
   * (`logs`) and Workers Traces (`traces`), each with their own
   * `enabled`, `headSamplingRate`, and `persist` toggles.
   *
   * If omitted, defaults to `{ enabled: true, logs: { enabled: true,
   * invocationLogs: true } }`. Traces are off by default — opt in via
   * `traces: { enabled: true, ... }`.
   */
  observability?: WorkerObservability;
  /**
   * Workers Cache settings. When `enabled` is `true`, Cloudflare checks a
   * regionally tiered cache in front of the Worker on every HTTP request —
   * cache hits are served from the edge without invoking the Worker at all.
   * The Worker controls what gets cached via standard response headers
   * (`Cache-Control`, `Cache-Tag`, `Vary`), including
   * `stale-while-revalidate`.
   *
   * Set `crossVersionCache: true` to share cached responses across Worker
   * versions (by default the cache is scoped to a single version, so every
   * deploy starts cold).
   *
   * If omitted, Workers Cache is disabled — unless the Worker's init phase
   * enables it via `yield* Cloudflare.cache()`, which is the preferred way
   * for Effect-native Workers (and also returns the runtime purge client).
   * When both are set, this prop takes precedence.
   *
   * @see https://blog.cloudflare.com/workers-cache/
   */
  cache?: WorkerCache;
  tags?: string[];
  /**
   * Path to the Worker's entry module. Bundled with rolldown before
   * upload. Mutually exclusive with {@link script} — provide exactly one.
   *
   * A `.py` entry deploys a Python Worker instead: no bundling runs — the
   * entry plus every sibling `.py` file upload as Python modules, the
   * `python_workers` compatibility flag is added, and dependencies from
   * `pyproject.toml` (or a prebuilt `python_modules/` directory) are
   * vendored alongside. See the Python Workers section above.
   */
  main?: string;
  /**
   * Raw module source for the Worker. When provided, bundling is bypassed
   * entirely and this string is uploaded as a single ESM module
   * (`main.js`). Useful for tiny inline workers (tests, fixtures,
   * one-offs) and any case where you've already produced the final
   * bundle elsewhere. Mutually exclusive with {@link main}.
   */
  script?: string;
  compatibility?: {
    date?: string;
    flags?: ("nodejs_compat" | "nodejs_als" | (string & {}))[];
  };
  limits?: WorkerLimits;
  placement?: WorkerPlacement;
  /**
   * Tracks Durable Object and Workflow exports for Effect-native Workers only.
   * Populated automatically from bindings; do not set manually.
   * @internal
   */
  exports?: Record<string, DurableObjectExport | WorkflowExport>;
  /**
   * Environment variables and native Cloudflare Bindings to bind to
   * the Worker. Accepts:
   *
   * - Resource references (R2 bucket, KV namespace, D1 database,
   *   another Worker, Durable Object, etc.) — emitted as the
   *   corresponding native binding.
   * - `effect/Config` values (`Config.redacted`, `Config.string`,
   *   `Config.number`, …) — resolved at deploy time and bound as
   *   `secret_text` on Cloudflare regardless of the `Config`
   *   constructor used. See
   *   [Secrets & env](/cloudflare/security/secrets-env).
   * - Literal values — routed by shape: `Redacted<string>` →
   *   `secret_text`, `string` → `plain_text`, anything else → `json`.
   *
   * In Effect-native Workers you can alternatively `yield*` a
   * `Config` in the Init phase to register the binding implicitly;
   * `env` is the only option for async (non-Effect) Workers.
   */
  env?: Bindings;
  /**
   * Cron expressions that trigger the Worker's scheduled handler.
   *
   * This is how async (non-Effect) Workers configure Cron Triggers — the
   * entry module exports its own `scheduled` handler and this prop attaches
   * the schedules at deploy time. Effect-native Workers usually skip this
   * prop and call `Cloudflare.Workers.cron(expression, handler)` in the Init
   * phase instead, which attaches the expression and registers the runtime
   * listener in one step.
   *
   * Pass an empty array to remove all Cron Triggers.
   */
  crons?: string[];
  /**
   * One or more custom hostnames (e.g. `"app.example.com"`) to bind to this
   * Worker. The Cloudflare Zone is inferred from the hostname — the zone must
   * already exist in the account.
   */
  domain?: string | string[];
  /**
   * Zone routes that map URL patterns to this Worker. Equivalent to Wrangler's
   * `routes` array — provide `zoneName` or `zoneId` (or `zone`) alongside each
   * `pattern`. When the zone is omitted, it is inferred from the pattern's
   * hostname.
   */
  routes?: WorkerRouteConfig[];
  /**
   * Extra bundler options applied on top of the standard rolldown
   * input/output options used to build this Worker. Includes the generic
   * bundle extras (pure-annotation packages, bundle analyzer) plus an
   * `output` field of rolldown output overrides (e.g. `codeSplitting`
   * groups) merged over Alchemy's defaults. See {@link WorkerBuildOptions}.
   */
  build?: WorkerBuildOptions;
  /**
   * Whether to bundle {@link main} with rolldown before upload.
   *
   * Set to `false` when `main` already points at a complete,
   * runtime-ready ESM Worker produced by an external tool (OpenNext,
   * a separate rolldown/esbuild pipeline, etc.). The entry and every
   * file around it matching {@link rules} are uploaded byte-for-byte —
   * no bundling, no minification, no transformation. Module names are
   * the files' POSIX paths relative to the entry's directory, matching
   * Wrangler's `no_bundle` contract.
   *
   * Re-bundling such artifacts is unsafe: dynamic `import()` calls the
   * upstream tool relies on can be rewritten in ways that break runtime
   * behavior.
   *
   * Durable Object and Workflow classes must be exported by the prebuilt
   * entry itself — {@link exports} is not applied when `bundle` is
   * `false`.
   *
   * @default true
   */
  bundle?: boolean;
  /**
   * Module rules selecting which files in the directory containing
   * {@link main} are uploaded as additional modules when {@link bundle}
   * is `false`. Each rule's globs are matched against POSIX-style paths
   * relative to that directory, mirroring Wrangler's `rules`
   * configuration. When provided, these rules replace
   * {@link defaultModuleRules}.
   *
   * @default defaultModuleRules — ESModule (`**\/*.js`, `**\/*.mjs`), CompiledWasm (`**\/*.wasm`), Text (`**\/*.txt`, `**\/*.html`, `**\/*.sql`), Data (`**\/*.bin`)
   */
  rules?: ModuleRule[];
  /**
   * Options for the local dev server that runs this Worker under `alchemy dev`.
   * Each Worker is served on its own port.
   *
   * Use `{ mode: "external" }` to skip starting a local Worker entirely —
   * useful when an external dev server (e.g. one spawned via `Command.Dev`)
   * is serving the content this Worker would otherwise host.
   */
  dev?:
    | {
        /**
         * Run this Worker in `workerd` locally (the default).
         * @default "worker"
         */
        mode?: "worker";
        /**
         * Host the local dev server binds to.
         * @default "localhost"
         */
        host?: string;
        /**
         * Port the local dev server listens on. If the port is unavailable,
         * the next free port is used unless {@link strictPort} is `true`.
         * @default 1337
         */
        port?: number;
        /**
         * When `true`, fail instead of falling back to another port if
         * {@link port} is already in use.
         * @default false
         */
        strictPort?: boolean;
      }
    | {
        /**
         * Don't start a local Worker; an external dev server is running instead.
         */
        mode: "external";
        /**
         * URL the external dev server is reachable at, if applicable.
         * This will be returned as the `url` attribute of the Worker resource.
         */
        url?: string;
      };
}

export interface ViteOptions {
  /**
   * Overrides the module that becomes the deployed Worker entry, forwarded
   * to the Cloudflare Vite plugin's `main` option. Relative paths resolve
   * from the Vite root (`rootDir`).
   *
   * By default the entry environment's own entry (the server bundle the
   * framework produces) is deployed. Point `main` at a custom module when
   * the deployed Worker must export more than the framework's fetch
   * handler — e.g. Durable Object classes or additional handlers wrapping
   * the framework handler.
   *
   * @example
   * ```typescript
   * vite: { main: "worker/index.ts" }
   * ```
   */
  main?: string;
  /**
   * Root directory passed to Vite's `root` option.
   * Defaults to the current working directory (`process.cwd()`).
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether a rebuild is needed.
   * By default every non-gitignored file in `cwd` is hashed, plus the nearest
   * lockfile. Provide explicit globs to narrow the scope.
   *
   * @see {@link MemoOptions}
   */
  memo?: MemoOptions & {
    /**
     * Configure additional workspaces to hash.
     * By default, auto-detects workspaces during Vite build, then hashes all
     * non-gitignored files in the workspace plus the nearest lockfile.
     * @default "auto"
     */
    workspaces?:
      | "auto"
      | Array<
          MemoOptions & {
            /**
             * The working directory to hash, relative to the Vite root.
             */
            cwd: string;
          }
        >;
  };
  /**
   * Selects which Vite environments make up the deployed Worker, for
   * frameworks that build more than one (e.g. React Server Components).
   *
   * A single-environment SSR build needs no configuration. For a
   * multi-environment build, point `entry` at the environment that
   * produces the server entry chunk and list the remaining server-side
   * environments in `children` so their chunks are bundled alongside it.
   * The `client` environment is always treated as static assets.
   *
   * @example React Router / React Server Components
   * ```typescript
   * viteEnvironments: { entry: "rsc", children: ["ssr"] }
   * ```
   *
   * @default { entry: "ssr", children: [] }
   */
  viteEnvironments?: {
    entry?: string;
    children?: string[];
  };
}

export type Worker<Bindings extends WorkerBindings = any> = Resource<
  WorkerTypeId,
  WorkerProps<Bindings>,
  {
    workerId: string;
    workerName: string;
    /**
     * The Workers for Platforms dispatch namespace this Worker was deployed
     * into, or `undefined` for a regular account-level Worker.
     */
    namespace: string | undefined;
    logpush: boolean | undefined;
    url: string | undefined;
    tags: string[] | undefined;
    durableObjectNamespaces: Record<string, string>;
    accountId: string;
    domains: string[];
    routes: { id: string; pattern: string; zoneId: string }[];
    crons: string[];
    hash?: {
      assets: string | undefined;
      bundle: string | undefined;
      input: string | undefined;
      additionalWorkspaces: string[] | undefined;
      // Hash of the deploy-time metadata surface (compatibility, env,
      // bindings, asset config, limits, observability, ...) so metadata-only
      // edits trigger an update (#745). Optional: state written before this
      // field existed has no `metadata`, which reads as a one-time update on
      // the first diff after upgrading (the apply backfills it).
      metadata?: string | undefined;
    };
  },
  {
    bindings?: WorkerBinding[];
    /**
     * Workers Cache settings contributed by `yield* Cloudflare.cache()`.
     * Merged into the upload metadata's `cache_options`; an explicit
     * `WorkerProps.cache` takes precedence.
     */
    cache?: WorkerCache;
    containers?: { className: string; dev: DevContainerImage | undefined }[];
    crons?: string[];
    hyperdrives?: Record<string, Required<DevOrigin>>;
  },
  Providers
>;

/**
 * A Cloudflare Worker host with deploy-time binding support and runtime export
 * collection.
 *
 * A Worker follows a two-phase pattern. The outer `Effect.gen` runs at
 * deploy time to bind resources (KV, R2, Durable Objects, etc.). It returns
 * an object whose properties are the Worker's runtime handlers — `fetch` for
 * HTTP requests and any additional RPC methods.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   // Phase 1: bind resources (runs at deploy time)
 *   const kv = yield* Cloudflare.KV.ReadWriteNamespace(MyKV);
 *
 *   return {
 *     // Phase 2: runtime handlers (runs on each request)
 *     fetch: Effect.gen(function* () {
 *       const value = yield* kv.get("key");
 *       return HttpServerResponse.text(value ?? "not found");
 *     }),
 *   };
 * })
 * ```
 *
 * There are three ways to define a Worker, from simplest to most
 * flexible. See the [Functions & Servers](/infrastructure-as-effects/functions-and-servers)
 * page for the full explanation.
 *
 * - **Async** — plain `async fetch` handler, no Effect runtime in the bundle.
 * - **Effect** — Effect implementation passed directly, single file.
 * - **Layer** — class and `.make()` in a single file; Rolldown tree-shakes `.make()` from consumers.
 * @resource
 * @product Workers
 * @category Workers & Compute
 * @section Async Workers
 * You don't have to use Effect for your runtime code. If you create
 * a Worker resource with `main` pointing at a file but provide no
 * `Effect.gen` implementation, Alchemy bundles and deploys that file
 * as-is. Your handler is a plain `async fetch` — no Effect runtime
 * is included in the bundle.
 *
 * Use the `env` prop to declare which resources, `Config` values,
 * and literal env vars are available at runtime, and
 * `Cloudflare.InferEnv` to extract a fully typed `env` object from
 * them.
 *
 * See the [Workers guide](/cloudflare/compute/workers)
 * for a comprehensive walkthrough of all binding types (R2, D1,
 * Durable Objects, Assets, and more).
 *
 * @example Defining an async Worker in your stack
 * ```typescript
 * // alchemy.run.ts
 * const db = yield* Cloudflare.D1.Database("DB");
 * const bucket = yield* Cloudflare.R2.Bucket("Bucket");
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { db, bucket },
 * });
 * ```
 *
 * @example Writing the async handler
 * ```typescript
 * // src/worker.ts
 * import type { WorkerEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv) {
 *     if (request.method === "GET") {
 *       const object = await env.bucket.get("key");
 *       return new Response(object?.body ?? null);
 *     }
 *     return new Response("Not Found", { status: 404 });
 *   },
 * };
 * ```
 *
 * @section Python Workers
 * Point `main` at a `.py` file to deploy a
 * [Python Worker](https://developers.cloudflare.com/workers/languages/python/)
 * (open beta). There is no bundling step — the entry and every sibling
 * `.py` module upload as-is and are interpreted by Pyodide, and the
 * `python_workers` compatibility flag is added automatically. Like async
 * Workers, Python Workers take no inline Effect implementation; declare
 * bindings with the `env` prop and read them from `self.env` in Python.
 *
 * Dependencies come from `pyproject.toml` next to the entry: Alchemy
 * vendors `[project.dependencies]` with [uv](https://docs.astral.sh/uv/)
 * against the Pyodide wheel index and uploads them under
 * `python_modules/`. If a `python_modules/` directory already exists
 * (e.g. produced by `pywrangler sync`), it is uploaded as-is and uv is
 * not invoked.
 *
 * See the [Python Workers guide](/cloudflare/compute/python-workers)
 * for the full walkthrough.
 *
 * @example Defining a Python Worker in your stack
 * ```typescript
 * // alchemy.run.ts
 * const kv = yield* Cloudflare.KV.Namespace("Cache");
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.py",
 *   env: { CACHE: kv },
 * });
 * ```
 *
 * @example Writing the Python handler
 * ```python
 * # src/worker.py
 * from workers import Response, WorkerEntrypoint
 *
 * class Default(WorkerEntrypoint):
 *     async def fetch(self, request):
 *         cached = await self.env.CACHE.get("greeting")
 *         return Response(cached or "Hello from Python!")
 * ```
 *
 * @example Vendoring dependencies with pyproject.toml
 * ```toml
 * # src/pyproject.toml — vendored with uv on deploy
 * [project]
 * name = "my-worker"
 * version = "0.1.0"
 * requires-python = ">=3.13"
 * dependencies = ["humanize"]
 * ```
 *
 * @section Effect Workers
 * Pass the Effect implementation as the third argument. This is the
 * simplest Effect-based approach — everything lives in one file.
 * Convenient for standalone Workers that don't need to be referenced
 * by other Workers.
 *
 * @example Worker Effect
 * ```typescript
 * export default class MyWorker extends Cloudflare.Worker<MyWorker>()(
 *   "MyWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const kv = yield* Cloudflare.KV.ReadWriteNamespace(MyKV);
 *
 *     return {
 *       // runtime: use them
 *       fetch: Effect.gen(function* () {
 *         const value = yield* kv.get("key");
 *         return HttpServerResponse.text(value ?? "not found");
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @section Worker Layer
 * When two Workers need to reference each other (e.g. WorkerA calls
 * WorkerB and vice versa), or you simply want optimal tree-shaking,
 * define the Worker class separately from its `.make()` call. The
 * class is a lightweight identifier; `.make()` provides the runtime
 * implementation as an `export default`. Rolldown treats `.make()`
 * as pure, so any Worker that imports the class to bind it will not
 * pull in the `.make()` dependencies — the bundler tree-shakes
 * them away entirely.
 *
 * The class and `.make()` can live in the same file. This is the
 * same pattern used by `Container` and `DurableObject`,
 * and is recommended for any cross-Worker or cross-DO bindings.
 *
 * @example Worker Layer (class + .make() in one file)
 * ```typescript
 * // src/WorkerB.ts — the tag carries the name + RPC shape; props live
 * // on `.make()`.
 * export class WorkerB extends Cloudflare.Worker<
 *   WorkerB,
 *   { greet: (name: string) => Effect.Effect<string> }
 * >()("WorkerB") {}
 *
 * export default WorkerB.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const kv = yield* Cloudflare.KV.ReadWriteNamespace(MyKV);
 *
 *     return {
 *       // runtime: use them
 *       greet: (name: string) =>
 *         Effect.gen(function* () {
 *           yield* kv.put("last-greeted", name);
 *           return `Hello ${name}`;
 *         }),
 *     };
 *   }),
 * );
 * ```
 *
 * @example Binding a Worker Layer from another Worker
 * ```typescript
 * // src/WorkerA.ts — imports WorkerB; bundler tree-shakes .make()
 * import WorkerB from "./WorkerB.ts";
 *
 * export default class WorkerA extends Cloudflare.Worker<WorkerA>()(
 *   "WorkerA",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const b = yield* Cloudflare.Workers.bindWorker(WorkerB);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* b.greet("world");
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @section Configuration
 * The props object controls compatibility flags, static assets, and
 * build options. These are evaluated at deploy time.
 *
 * @example Enabling Node.js compatibility
 * ```typescript
 * {
 *   main: import.meta.url,
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *     date: "2026-03-17",
 *   },
 * }
 * ```
 *
 * @example Serving static assets
 * ```typescript
 * {
 *   main: import.meta.url,
 *   assets: "./public",
 * }
 * ```
 *
 * @example Zone routes
 * ```typescript
 * {
 *   main: import.meta.filename,
 *   routes: [
 *     { pattern: "api.example.com/*", zoneName: "example.com" },
 *     { pattern: "example.com/api/*", zoneId: "<YOUR_ZONE_ID>" },
 *   ],
 * }
 * ```
 *
 * @example Deploying a prebuilt Worker without bundling
 * When `main` already points at a complete, runtime-ready ESM bundle
 * produced by an external tool (e.g. OpenNext), set `bundle: false` to
 * upload it byte-for-byte. The entry's directory is walked recursively
 * and every file matching the module rules (by default `.js`, `.mjs`,
 * `.wasm`, `.txt`, `.html`, `.sql`, and `.bin`) is uploaded as an
 * additional module named by its path relative to that directory.
 * ```typescript
 * {
 *   main: "./.open-next/worker.js",
 *   bundle: false,
 *   assets: "./.open-next/assets",
 * }
 * ```
 *
 * @section Observability
 * Cloudflare Workers Observability is on by default — `logs.enabled` and
 * `logs.invocationLogs` are turned on if you don't pass an `observability`
 * prop. Pass the prop yourself to tune sampling, enable persistence, or
 * turn on the new `traces` channel (the same toggle the dashboard's
 * Observability tab writes).
 *
 * Field names match the Cloudflare API (camelCased): `headSamplingRate`,
 * `invocationLogs`, etc.
 *
 * @example Enabling logs and traces
 * ```typescript
 * {
 *   main: import.meta.url,
 *   observability: {
 *     enabled: true,
 *     headSamplingRate: 1,
 *     logs: {
 *       enabled: true,
 *       invocationLogs: true,
 *       headSamplingRate: 1,
 *       persist: true,
 *     },
 *     traces: {
 *       enabled: true,
 *       headSamplingRate: 1,
 *       persist: true,
 *     },
 *   },
 * }
 * ```
 *
 * @section Workers Cache
 * Workers Cache puts a regionally tiered cache in front of the Worker —
 * cache hits are served from the edge without invoking the Worker (and
 * without billing CPU time). In an Effect-native Worker, enable it by
 * yielding `Cloudflare.cache()` in the init phase, which also returns the
 * runtime purge client; async Workers use the `cache` prop instead. Control
 * what gets cached from your handlers via standard response headers:
 * `Cache-Control` (including `stale-while-revalidate`), `Cache-Tag` for
 * tag-based purging, and `Vary` for content negotiation.
 *
 * The cache is scoped to a single Worker version by default, so every
 * deploy starts cold. Set `crossVersionCache: true` to share cached
 * responses across versions.
 *
 * @example Enabling and purging the cache in an Effect Worker
 * ```typescript
 * Effect.gen(function* () {
 *   // init: enable Workers Cache on this Worker
 *   const { purge } = yield* Cloudflare.cache({ crossVersionCache: true });
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const request = yield* HttpServerRequest;
 *       if (request.url.startsWith("/invalidate")) {
 *         yield* purge({ tags: ["products"] });
 *         return HttpServerResponse.text("purged");
 *       }
 *       return HttpServerResponse.text("hello", {
 *         headers: {
 *           "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
 *           "Cache-Tag": "products,product:123",
 *         },
 *       });
 *     }),
 *   };
 * })
 * ```
 *
 * @example Enabling Workers Cache on an async Worker
 * ```typescript
 * {
 *   main: "./src/worker.ts",
 *   cache: {
 *     enabled: true,
 *     crossVersionCache: true,
 *   },
 * }
 * ```
 *
 * @section Background Work & Scopes
 * Each incoming event (fetch, RPC call, scheduled run) gets its own Effect
 * `Scope`. When the handler finishes, the bridge closes that scope and
 * registers the close promise with workerd's `ctx.waitUntil` — so
 * finalizers added with `Effect.addFinalizer` inside a handler run *after*
 * the response is sent, without blocking it, and the Worker stays alive
 * until they settle. Streaming responses transfer the scope to the stream,
 * so those finalizers run when the stream completes instead.
 *
 * For ad-hoc background work, `WorkerExecutionContext.waitUntil(effect)`
 * forks an Effect with the caller's full context and keeps the invocation
 * alive until it settles. The context can be yielded once in the init
 * closure and used from any handler; its methods are `RuntimeContext`-
 * colored, so they can only run inside a handler.
 *
 * The init closure is evaluated once per isolate: the bridge builds the
 * Worker's layer stack on the first event and every later event reuses the
 * built services. Resolve services, bind resources, build handlers there —
 * one-shot I/O that caches a plain value (e.g. fetching a secret for a
 * client) is fine, but nothing disposable: the build scope is never closed
 * (workerd has no isolate-teardown hook), so a finalizer added in the init
 * closure never runs, and I/O-backed objects (sockets, response bodies) are
 * pinned to the request that created them. Anything that needs cleanup
 * belongs in a handler, where `Effect.addFinalizer` attaches to the
 * per-event scope.
 *
 * @example Post-response cleanup with a scope finalizer
 * ```typescript
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runs after this response is sent, kept alive by waitUntil
 *     yield* Effect.addFinalizer(() => flushMetrics().pipe(Effect.ignore));
 *     return HttpServerResponse.text("ok");
 *   }),
 * };
 * ```
 *
 * @example Background work with waitUntil
 * ```typescript
 * // init
 * const exec = yield* Cloudflare.WorkerExecutionContext;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // respond now; the audit write completes in the background
 *     yield* exec.waitUntil(writeAuditLog(event));
 *     return HttpServerResponse.text("accepted", { status: 202 });
 *   }),
 * };
 * ```
 *
 * @section R2 Bucket
 * Bind an R2 bucket in the init phase with `Cloudflare.R2.ReadWriteBucket`.
 * The returned handle exposes `get`, `put`, `delete`, and `list`
 * methods you can call in your runtime handlers.
 *
 * @example Binding and using R2
 * ```typescript
 * // init
 * const bucket = yield* Cloudflare.R2.ReadWriteBucket(MyBucket);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *     const key = request.url.split("/").pop()!;
 *
 *     if (request.method === "GET") {
 *       const object = yield* bucket.get(key);
 *       return object
 *         ? HttpServerResponse.text(yield* object.text())
 *         : HttpServerResponse.empty({ status: 404 });
 *     }
 *
 *     yield* bucket.put(key, request.stream);
 *     return HttpServerResponse.empty({ status: 201 });
 *   }),
 * };
 * ```
 *
 * @section KV Namespace
 * Bind a KV namespace with `Cloudflare.KV.ReadWriteNamespace`. KV provides
 * eventually-consistent, low-latency key-value reads replicated
 * globally across Cloudflare's edge.
 *
 * @example Binding and using KV
 * ```typescript
 * // init
 * const kv = yield* Cloudflare.KV.ReadWriteNamespace(MyKV);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const value = yield* kv.get("my-key");
 *     return HttpServerResponse.text(value ?? "not found");
 *   }),
 * };
 * ```
 *
 * @section D1 Database
 * Bind a D1 database with `Cloudflare.D1.QueryDatabase`. D1 is a
 * serverless SQLite database — use `prepare` to build parameterized
 * queries and `all`, `first`, or `run` to execute them.
 *
 * @example Binding and querying D1
 * ```typescript
 * // init
 * const db = yield* Cloudflare.D1.QueryDatabase(MyDatabase);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const results = yield* db
 *       .prepare("SELECT * FROM users WHERE id = ?")
 *       .bind(userId)
 *       .all();
 *     return yield* HttpServerResponse.json(results);
 *   }),
 * };
 * ```
 *
 * @section Durable Objects
 * Yield a `DurableObject` class in the init phase to get a
 * namespace handle. Call `getByName` or `getById` to get a typed RPC
 * stub, then call its methods from your runtime handlers.
 *
 * @example Using a Durable Object
 * ```typescript
 * // init
 * const counters = yield* Counter;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const counter = counters.getByName("user-123");
 *     const value = yield* counter.increment();
 *     return HttpServerResponse.text(String(value));
 *   }),
 * };
 * ```
 *
 * @section Containers
 * Containers run long-lived processes alongside Durable Objects.
 * Provide `Cloudflare.Containers.layer(Sandbox, …)` on a DO's init to
 * bind, start, and monitor the container; then `yield* Sandbox`
 * resolves the **running** instance. Call its typed methods or use
 * `getTcpPort` to make HTTP requests to its exposed ports.
 *
 * @example Running a Container from a Durable Object
 * ```typescript
 * export default class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agents",
 *   Effect.gen(function* () {
 *     const sandbox = yield* Sandbox;
 *
 *     return Effect.gen(function* () {
 *       return {
 *         exec: (cmd: string) => sandbox.exec(cmd),
 *         health: () =>
 *           Effect.gen(function* () {
 *             const { fetch } = yield* sandbox.getTcpPort(3000);
 *             const res = yield* fetch(
 *               HttpClientRequest.get("http://container/health"),
 *             );
 *             return yield* res.text;
 *           }),
 *       };
 *     });
 *   }).pipe(
 *     Effect.provide(
 *       Cloudflare.Containers.layer(Sandbox, { enableInternet: true }),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @section Dynamic Workers
 * `WorkerLoader` lets you spin up ephemeral Workers at runtime
 * from inline JavaScript modules. This is useful for sandboxing
 * user-provided code or running untrusted scripts in isolation.
 *
 * @example Loading a dynamic Worker
 * ```typescript
 * // init
 * const loader = yield* Cloudflare.WorkerLoader("Loader");
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const worker = yield* loader.load({
 *       compatibilityDate: "2026-01-28",
 *       mainModule: "worker.js",
 *       modules: {
 *         "worker.js": `export default {
 *           async fetch(req) { return new Response("sandboxed"); }
 *         }`,
 *       },
 *     });
 *
 *     const res = yield* worker.fetch(
 *       HttpClientRequest.get("https://worker/"),
 *     );
 *     return HttpServerResponse.fromClientResponse(res);
 *   }),
 * };
 * ```
 */
export const Worker: ResourceClassLike<Worker> &
  Effect.Effect<
    Worker & WorkerRuntimeContext & RuntimeContext,
    never,
    Worker
  > & {
    <Self, Shape extends WorkerShape, Deps = never>(): {
      <const Id extends string>(
        id: Id,
      ): Effect.Effect<
        Worker & Rpc<Self> & Dependencies<Deps>,
        never,
        Self | Extract<Deps, Container.Application<any>> | Providers
      > &
        Named<Id> & {
          new (_: never): MakeShape<Shape, WorkerShape> & Named<Id> & Tag;
          of(shape: Shape & WorkerShape): MakeShape<Shape, WorkerShape>;
          make<PropsReq = never, InitReq = never>(
            props:
              | InputProps<WorkerProps>
              | Effect.Effect<InputProps<WorkerProps>, ConfigError, PropsReq>,
            impl: Effect.Effect<Shape, ConfigError, InitReq>,
          ): Layer.Layer<
            Self,
            never,
            | Extract<Deps, Container.Application<any>>
            | Providers
            | Exclude<InitReq, Self | WorkerServices>
          >;
        };
    };
    <Self>(): {
      <
        const Id extends string,
        Shape extends WorkerShape,
        Req extends
          | WorkerServices
          | Container.Application<any>
          | PlatformServices
          | Tag,
      >(
        id: Id,
        props: InputProps<WorkerProps>,
        impl: Effect.Effect<Shape, ConfigError, Req>,
      ): Effect.Effect<
        Worker & Rpc<Self>,
        never,
        Extract<Req, Container.Application<any>> | Providers
      > &
        Named<Id> & {
          new (): MakeShape<Shape, WorkerShape> & Named<Id> & Tag;
        };
    };
    <
      const Bindings extends WorkerBindingProps = {},
      const Assets extends WorkerAssetsConfig | undefined = undefined,
      Req = never,
    >(
      id: string,
      props:
        | InputProps<WorkerProps<Bindings, Assets>>
        | Effect.Effect<
            InputProps<WorkerProps<Bindings, Assets>>,
            ConfigError,
            Req
          >,
    ): Effect.Effect<
      Worker<{
        [binding in keyof NormalizedBindings<
          Bindings,
          Assets
        >]: NormalizedBindings<Bindings, Assets>[binding];
      }> &
        Rpc<{}>,
      never,
      Req | Providers
    >;
    <
      const Id extends string,
      Shape extends WorkerShape,
      Req extends
        | WorkerServices
        | Container.Application<any>
        | PlatformServices,
    >(
      id: string,
      props: InputProps<WorkerProps>,
      impl: Effect.Effect<Shape, ConfigError, Req>,
    ): Effect.Effect<
      Worker & Rpc<Shape>,
      never,
      Extract<Req, Container.Application<any>> | Providers
    > &
      Named<Id>;
  } = Platform(WorkerTypeId, {
  // Both hooks are wrapped in arrows so the imported references are resolved
  // at call time rather than at module-load time. Worker.ts forms import
  // cycles with both WorkerAsyncBindings.ts (which imports `isWorker` here)
  // and WorkerRuntimeContext.ts (which imports `WorkerTypeId`/`WorkerEnvironment`
  // here). Reading either binding eagerly here hits TDZ when Bun loads the
  // package from node_modules in a different module-init order than the local
  // workspace.
  onCreate: (resource, props) =>
    bindWorkerAsyncBindings(resource as Worker, props),
  createRuntimeContext: (id) => makeWorkerRuntimeContext(id),
});
