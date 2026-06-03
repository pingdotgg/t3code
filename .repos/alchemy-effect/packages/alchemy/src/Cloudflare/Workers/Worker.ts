import type * as cf from "@cloudflare/workers-types";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as crypto from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Artifacts from "../../Artifacts.ts";
import { hashDirectory, type MemoOptions } from "../../Build/Memo.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import type { InputProps } from "../../Input.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { HyperdriveDevOrigin } from "../Hyperdrive/Hyperdrive.ts";
import { CloudflareLogs } from "../Logs.ts";
import type { Providers } from "../Providers.ts";
import {
  readAssets,
  uploadAssets,
  type Assets,
  type AssetsConfig,
  type AssetsProps,
} from "./Assets.ts";
import { getCompatibility } from "./Compatibility.ts";
import { isDurableObjectExport } from "./DurableObjectNamespace.ts";
import {
  LocalWorkerProvider,
  localRuntimeServices,
} from "./LocalWorkerProvider.ts";
import { Request } from "./Request.ts";
import * as Vite from "./Vite.ts";
import {
  bindWorkerAsyncBindings,
  getCronBindings,
} from "./WorkerAsyncBindings.ts";
import type {
  WorkerBinding,
  WorkerBindingResource,
  WorkerBindings,
  WorkerSettingsBinding,
} from "./WorkerBinding.ts";
import { WorkerBundle } from "./WorkerBundle.ts";
import { createWorkerName } from "./WorkerName.ts";
import {
  makeWorkerRuntimeContext,
  type WorkerRuntimeContext,
} from "./WorkerRuntimeContext.ts";

export const WorkerTypeId = "Cloudflare.Worker";
export type WorkerTypeId = typeof WorkerTypeId;

export const isWorker = <T>(value: T): value is T & Worker =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === WorkerTypeId;

export class WorkerEnvironment extends Context.Service<
  WorkerEnvironment,
  Record<string, any>
>()("Cloudflare.Workers.WorkerEnvironment") {}

export class WorkerExecutionContext extends Context.Service<
  WorkerExecutionContext,
  cf.ExecutionContext
>()("Cloudflare.Workers.WorkerExecutionContext") {}

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
export interface AssetsWithHash {
  /**
   * Path to the assets directory.
   */
  path: string;
  /**
   * Pre-computed hash of the assets. When provided, this hash is used for diffing
   * to determine if the worker needs to be redeployed.
   */
  hash: string;
  /**
   * Optional assets configuration.
   */
  config?: AssetsConfig;
}

export interface WorkerObservability extends Exclude<
  workers.PutScriptRequest["metadata"]["observability"],
  undefined
> {}

export interface WorkerLimits extends Exclude<
  workers.PutScriptRequest["metadata"]["limits"],
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
  | WorkerEnvironment;

export type WorkerShape = Main<WorkerServices>;

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

type NormalizedBindings<
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
  /** @internal used by Cloudflare.Vite resource */
  vite?: {
    rootDir?: string;
    memo?: MemoOptions;
  };
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
  tags?: string[];
  /**
   * Path to the Worker's entry module. Bundled with rolldown before
   * upload. Mutually exclusive with {@link script} — provide exactly one.
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
  exports?: string[];
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
   *   {@link https://v2.alchemy.run/concepts/secrets | Concepts › Secrets and Variables}.
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
   * Extra bundler options applied on top of the standard rolldown input/output
   * options used to build this Worker. See {@link Bundle.BundleExtraOptions}.
   */
  build?: Bundle.BundleExtraOptions;
  /**
   * Options for the local dev server that runs this Worker under `alchemy dev`.
   * Each Worker is served on its own port.
   */
  dev?: {
    /**
     * Host the local dev server binds to.
     * @default "localhost"
     */
    host?: string;
    /**
     * Port the local dev server listens on. If the port is unavailable, the
     * next free port is used unless {@link strictPort} is `true`.
     * @default 1337
     */
    port?: number;
    /**
     * When `true`, fail instead of falling back to another port if {@link port}
     * is already in use.
     * @default false
     */
    strictPort?: boolean;
  };
}

export type Worker<Bindings extends WorkerBindings = any> = Resource<
  WorkerTypeId,
  WorkerProps<Bindings>,
  {
    workerId: string;
    workerName: string;
    logpush: boolean | undefined;
    url: string | undefined;
    tags: string[] | undefined;
    durableObjectNamespaces: Record<string, string>;
    accountId: string;
    domains: string[];
    crons: string[];
    hash?: {
      assets: string | undefined;
      bundle: string | undefined;
      input: string | undefined;
    };
  },
  {
    bindings?: WorkerBinding[];
    containers?: { className: string }[];
    crons?: string[];
    hyperdrives?: Record<string, Required<HyperdriveDevOrigin>>;
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
 *   const kv = yield* Cloudflare.KVNamespace.bind(MyKV);
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
 * flexible. See the {@link https://alchemy.run/concepts/platform | Platform concept}
 * page for the full explanation.
 *
 * - **Async** — plain `async fetch` handler, no Effect runtime in the bundle.
 * - **Effect** — Effect implementation passed directly, single file.
 * - **Layer** — class and `.make()` in a single file; Rolldown tree-shakes `.make()` from consumers.
 *
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
 * See the {@link https://alchemy.run/guides/async-worker | Async Workers Guide}
 * for a comprehensive walkthrough of all binding types (R2, D1,
 * Durable Objects, Assets, and more).
 *
 * @example Defining an async Worker in your stack
 * ```typescript
 * // alchemy.run.ts
 * const db = yield* Cloudflare.D1Database("DB");
 * const bucket = yield* Cloudflare.R2Bucket("Bucket");
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
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const kv = yield* Cloudflare.KVNamespace.bind(MyKV);
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
 * same pattern used by `Container` and `DurableObjectNamespace`,
 * and is recommended for any cross-Worker or cross-DO bindings.
 *
 * @example Worker Layer (class + .make() in one file)
 * ```typescript
 * // src/WorkerB.ts
 * export default class WorkerB extends Cloudflare.Worker<WorkerB>()(
 *   "WorkerB",
 *   { main: import.meta.filename },
 * ) {}
 *
 * export default WorkerB.make(
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const kv = yield* Cloudflare.KVNamespace.bind(MyKV);
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
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const b = yield* Cloudflare.Worker.bind(WorkerB);
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
 *   main: import.meta.filename,
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
 *   main: import.meta.filename,
 *   assets: "./public",
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
 *   main: import.meta.filename,
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
 * @section R2 Bucket
 * Bind an R2 bucket in the init phase with `Cloudflare.R2Bucket.bind`.
 * The returned handle exposes `get`, `put`, `delete`, and `list`
 * methods you can call in your runtime handlers.
 *
 * @example Binding and using R2
 * ```typescript
 * // init
 * const bucket = yield* Cloudflare.R2Bucket.bind(MyBucket);
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
 * Bind a KV namespace with `Cloudflare.KVNamespace.bind`. KV provides
 * eventually-consistent, low-latency key-value reads replicated
 * globally across Cloudflare's edge.
 *
 * @example Binding and using KV
 * ```typescript
 * // init
 * const kv = yield* Cloudflare.KVNamespace.bind(MyKV);
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
 * Bind a D1 database with `Cloudflare.D1Connection.bind`. D1 is a
 * serverless SQLite database — use `prepare` to build parameterized
 * queries and `all`, `first`, or `run` to execute them.
 *
 * @example Binding and querying D1
 * ```typescript
 * // init
 * const db = yield* Cloudflare.D1Connection.bind(MyDB);
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
 * Yield a `DurableObjectNamespace` class in the init phase to get a
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
 * Containers run long-lived processes alongside Durable Objects. Bind
 * one with `Cloudflare.Container.bind` and start it with
 * `Cloudflare.start`. You can call typed methods on the running
 * container or make HTTP requests to its exposed ports.
 *
 * @example Binding and starting a Container
 * ```typescript
 * // init (inside a DurableObjectNamespace)
 * const sandbox = yield* Cloudflare.Container.bind(Sandbox);
 *
 * return Effect.gen(function* () {
 *   const container = yield* Cloudflare.start(sandbox, { enableInternet: true });
 *
 *   return {
 *     exec: (cmd: string) => container.exec(cmd),
 *     fetch: Effect.gen(function* () {
 *       const { fetch } = yield* container.getTcpPort(3000);
 *       const res = yield* fetch(HttpClientRequest.get("http://container/"));
 *       return HttpServerResponse.fromClientResponse(res);
 *     }),
 *   };
 * });
 * ```
 *
 * @section Dynamic Workers
 * `DynamicWorkerLoader` lets you spin up ephemeral Workers at runtime
 * from inline JavaScript modules. This is useful for sandboxing
 * user-provided code or running untrusted scripts in isolation.
 *
 * @example Loading a dynamic Worker
 * ```typescript
 * // init
 * const loader = yield* Cloudflare.DynamicWorkerLoader("Loader");
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const worker = loader.load({
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
export const Worker: Platform<
  Worker,
  WorkerServices,
  WorkerShape,
  WorkerRuntimeContext
> & {
  <
    const Bindings extends WorkerBindingProps = {},
    const Assets extends WorkerAssetsConfig | undefined = undefined,
    Req = never,
  >(
    id: string,
    props:
      | InputProps<WorkerProps<Bindings, Assets>>
      | Effect.Effect<InputProps<WorkerProps<Bindings, Assets>>, never, Req>,
  ): Effect.Effect<
    Worker<{
      [binding in keyof NormalizedBindings<
        Bindings,
        Assets
      >]: NormalizedBindings<Bindings, Assets>[binding];
    }>,
    never,
    Req | Providers
  >;
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

class MissingDurableObjectNamespaces extends Data.TaggedError(
  "MissingDurableObjectNamespaces",
)<{
  scriptName: string;
  expected: string[];
}> {}

const selectLayer = <
  LayerLive extends Layer.Layer<any, any, any>,
  LayerDev extends Layer.Layer<any, any, any>,
>(input: {
  live: () => LayerLive;
  dev: () => LayerDev;
}): Layer.Layer<
  Layer.Success<LayerLive | LayerDev>,
  Layer.Error<LayerLive | LayerDev>,
  Layer.Services<LayerLive | LayerDev> | AlchemyContext
> =>
  Layer.unwrap(
    AlchemyContext.useSync((context) =>
      context.dev ? input.dev() : input.live(),
    ),
  );

export const WorkerProvider = () =>
  selectLayer({
    live: LiveWorkerProvider,
    dev: () => Layer.provide(LocalWorkerProvider(), localRuntimeServices()),
  });

export const LiveWorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { accountId } = yield* CloudflareEnvironment;
      const bundler = yield* WorkerBundle;
      const stack = yield* Stack;

      const createScriptSubdomain = yield* workers.createScriptSubdomain;
      const deleteScript = yield* workers.deleteScript;
      const getScriptSubdomain = yield* workers.getScriptSubdomain;
      const getScriptSchedule = yield* workers.getScriptSchedule;
      const getScriptSettings = yield* workers.getScriptScriptAndVersionSetting;
      const getSubdomain = yield* workers.getSubdomain;
      const putScript = yield* workers.putScript;
      const putScriptSchedule = yield* workers.putScriptSchedule;
      const putDomain = yield* workers.putDomain;
      const listDomains = yield* workers.listDomains;
      const deleteDomain = yield* workers.deleteDomain;
      const listZones = yield* zones.listZones;
      const telemetry = yield* CloudflareLogs;

      const getAccountSubdomain = (accountId: string) =>
        getSubdomain({
          accountId,
        }).pipe(Effect.map((result) => result.subdomain));

      // Toggle the workers.dev subdomain via `POST /subdomain` with
      // `enabled: true | false`. Mirrors the upstream Alchemy
      // implementation in `.vendor/alchemy/.../worker-subdomain.ts`.
      // When enabling we also set `previewsEnabled: true` so the
      // script is reachable both at its stable workers.dev URL and at
      // version-preview URLs; on disable we send just `enabled: false`.
      const setWorkerSubdomain = (name: string, enabled: boolean) =>
        createScriptSubdomain({
          accountId,
          scriptName: name,
          enabled,
          previewsEnabled: enabled ? true : undefined,
        });

      // Convert non-ASCII hostnames (emoji, IDN, etc.) to punycode so the
      // Cloudflare API receives the form it stores domains in. `new URL(...)`
      // does IDNA via WHATWG URL parsing — `📦.alchemy.run` → `xn--5z8h.alchemy.run`.
      const toPunycode = (hostname: string): string => {
        try {
          return new URL(`https://${hostname}`).hostname;
        } catch {
          return hostname;
        }
      };

      const normalizeDomains = (
        domain: string | string[] | undefined,
      ): string[] =>
        domain === undefined
          ? []
          : Array.from(
              new Set(
                (Array.isArray(domain) ? domain : [domain]).map(toPunycode),
              ),
            );

      const normalizeCrons = (crons: string[] | undefined): string[] =>
        Array.from(new Set(crons ?? []));

      const getWorkerCrons = (scriptName: string) =>
        getScriptSchedule({
          accountId,
          scriptName,
        }).pipe(
          Effect.map((response) =>
            normalizeCrons(response.schedules.map((schedule) => schedule.cron)),
          ),
          Effect.catchTag("WorkerNotFound", () => Effect.succeed([])),
        );

      const reconcileCrons = (
        scriptName: string,
        desired: string[],
        previous: string[],
        session: ScopedPlanStatusSession,
      ) =>
        Effect.gen(function* () {
          const live = yield* getWorkerCrons(scriptName);
          const desiredSorted = [...desired].sort();
          const liveSorted = [...live].sort();
          const changed =
            desiredSorted.length !== liveSorted.length ||
            desiredSorted.some((cron, index) => cron !== liveSorted[index]);

          if (!changed) return live;

          if (desired.length > 0 || previous.length > 0 || live.length > 0) {
            yield* session.note(
              `Reconciling Cron Triggers (${desired.length}) ...`,
            );
          }

          const result = yield* putScriptSchedule({
            accountId,
            scriptName,
            body: desired.map((cron) => ({ cron })),
          }).pipe(
            Effect.retry({
              while: (error: { _tag?: string }) =>
                error?._tag === "WorkerNotFound",
              schedule: Schedule.exponential(200).pipe(
                Schedule.both(Schedule.recurs(15)),
              ),
            }),
          );
          return normalizeCrons(
            result.schedules.map((schedule) => schedule.cron),
          );
        });

      /**
       * Infer the Cloudflare Zone ID for a given hostname by listing the
       * account's zones and matching the hostname against each zone's name —
       * walking up the DNS label hierarchy until a match is found.
       */
      const inferZoneIdForHostname = (
        hostname: string,
        zoneCache: Map<string, string>,
      ) =>
        Effect.gen(function* () {
          const cached = zoneCache.get(hostname);
          if (cached) return cached;

          const zoneList = yield* listZones({}).pipe(
            Effect.map((response) => response.result ?? []),
          );
          for (const zone of zoneList) {
            zoneCache.set(zone.name, zone.id);
          }

          const parts = hostname.split(".");
          for (let i = 0; i < parts.length - 1; i++) {
            const candidate = parts.slice(i).join(".");
            const match = zoneList.find((z) => z.name === candidate);
            if (match) {
              zoneCache.set(hostname, match.id);
              return match.id;
            }
          }
          return yield* Effect.die(
            `Could not infer Cloudflare Zone for hostname "${hostname}". ` +
              "Ensure the parent zone exists in this account.",
          );
        });

      const reconcileDomains = (scriptName: string, desired: string[]) =>
        Effect.gen(function* () {
          // Always query the live state of domains attached to *this*
          // Worker rather than trusting `_previous` from local state.
          // State may have been wiped, populated by another machine, or
          // simply be out of date. Without this we PUT domains that are
          // already registered to this same Worker and Cloudflare
          // returns a confusing "hostname already in use" error.
          const liveAll = yield* listDomains({
            accountId,
            service: scriptName,
          }).pipe(
            Effect.map((r) =>
              (r.result ?? []).flatMap((d) =>
                d.id && d.hostname && d.zoneId
                  ? [
                      {
                        id: d.id,
                        hostname: d.hostname,
                        zoneId: d.zoneId,
                        service: d.service ?? undefined,
                      },
                    ]
                  : [],
              ),
            ),
            Effect.catch(() => Effect.succeed([])),
          );

          const desiredSet = new Set(desired);
          const liveByHostname = new Map(liveAll.map((d) => [d.hostname, d]));

          // Detach what's no longer wanted. Use the live list so we
          // don't try to delete domains we no longer track.
          const toRemove = liveAll.filter((d) => !desiredSet.has(d.hostname));
          yield* Effect.all(
            toRemove.map((d) =>
              deleteDomain({ accountId, domainId: d.id }).pipe(
                Effect.catchTag("DomainNotFound", () => Effect.void),
              ),
            ),
            { concurrency: "unbounded" },
          );

          if (desired.length === 0) return [];

          const zoneCache = new Map<string, string>();

          // Attach `hostname` to this Worker. Skip the PUT entirely if
          // the hostname is already attached to *this* Worker — that's a
          // no-op for Cloudflare and avoids the "already in use" 409.
          // If it's attached to a *different* Worker, refuse with a
          // clear message rather than silently re-routing traffic.
          const attachDomain = Effect.fnUntraced(function* (hostname: string) {
            const live = liveByHostname.get(hostname);
            if (live) {
              return {
                hostname: live.hostname,
                id: live.id,
                zoneId: live.zoneId,
              };
            }

            // Not attached to this Worker — but it could still belong
            // to another Worker. Check before we try to PUT so we can
            // emit a helpful error instead of the raw 409.
            const otherOwner = yield* listDomains({
              accountId,
              hostname,
            }).pipe(
              Effect.map((r) =>
                (r.result ?? []).find(
                  (d) => d.hostname === hostname && d.service !== scriptName,
                ),
              ),
              Effect.catch(() => Effect.succeed(undefined)),
            );
            if (otherOwner?.id) {
              return yield* Effect.die(
                new Error(
                  `Cannot attach hostname '${hostname}' to Worker '${scriptName}': ` +
                    `it is already attached to Worker '${otherOwner.service ?? "<unknown>"}'. ` +
                    `Detach it from that Worker first, or pick a different hostname.`,
                ),
              );
            }

            const zoneId = yield* inferZoneIdForHostname(hostname, zoneCache);
            // Same eventual-consistency window as `setWorkerSubdomain`:
            // PUT /accounts/.../workers/domains right after `putScript`
            // can return `WorkerNotFound` until Cloudflare's script
            // registry has propagated. Retry on that specific tag.
            const res = yield* putDomain({
              accountId,
              hostname,
              service: scriptName,
              zoneId,
            }).pipe(
              Effect.retry({
                while: (error: { _tag?: string }) =>
                  error?._tag === "WorkerNotFound",
                schedule: Schedule.exponential(200).pipe(
                  Schedule.both(Schedule.recurs(15)),
                ),
              }),
            );
            return {
              hostname,
              id: res.id ?? "",
              zoneId: res.zoneId ?? zoneId,
            };
          });

          const applied = yield* Effect.all(desired.map(attachDomain), {
            concurrency: "unbounded",
          });
          return applied;
        });

      const createAlchemyWorkerTags = (id: string) => [
        `alchemy:stack:${stack.name}`,
        `alchemy:stage:${stack.stage}`,
        `alchemy:id:${id}`,
      ];

      const hasAlchemyWorkerTags = (
        id: string,
        tags: readonly string[] | undefined,
      ) => {
        const actualTags = new Set(tags ?? []);
        return createAlchemyWorkerTags(id).every((tag) => actualTags.has(tag));
      };

      const getDurableObjectNamespaces = (
        bindings: readonly WorkerSettingsBinding[] | null | undefined,
      ) => {
        const namespaces = Object.fromEntries(
          (bindings ?? []).flatMap((binding) =>
            binding.type === "durable_object_namespace" &&
            binding.className &&
            binding.namespaceId
              ? [[binding.className, binding.namespaceId]]
              : [],
          ),
        );
        return namespaces;
      };

      const getExpectedDurableObjectClassNames = (
        bindings: readonly WorkerBinding[] | undefined,
        workerName: string,
      ) =>
        Array.from(
          new Set(
            bindings?.flatMap((binding) =>
              binding.type === "durable_object_namespace" &&
              binding.className &&
              (binding.scriptName === undefined ||
                binding.scriptName === workerName)
                ? [binding.className]
                : [],
            ) ?? [],
          ),
        );

      const getWorkerSettingsWithDurableObjects = Effect.fnUntraced(function* (
        scriptName: string,
        expectedClassNames: readonly string[],
      ) {
        return yield* getScriptSettings({
          accountId,
          scriptName,
        }).pipe(
          Effect.map((settings) => {
            const namespaces = getDurableObjectNamespaces(settings.bindings);
            const missing = expectedClassNames.filter(
              (className) => !namespaces[className],
            );
            if (missing.length > 0) {
              return Effect.fail(
                new MissingDurableObjectNamespaces({
                  scriptName,
                  expected: missing,
                }),
              );
            }
            return Effect.succeed({
              settings,
              durableObjectNamespaces: namespaces,
            });
          }),
          Effect.flatten,
          Effect.retry({
            while: (error) => error._tag === "MissingDurableObjectNamespaces",
            schedule: Schedule.exponential(100).pipe(
              Schedule.both(Schedule.recurs(20)),
            ),
          }),
        );
      });

      const prepareAssets = Effect.fnUntraced(function* (
        assets: WorkerProps["assets"],
      ) {
        if (!assets) {
          return undefined;
        }

        if (
          typeof assets === "object" &&
          "path" in assets &&
          "hash" in assets
        ) {
          return yield* readAssets({
            directory: assets.path as string,
            config: assets.config,
          });
        }

        // Handle string path or AssetsProps
        return yield* readAssets(
          typeof assets === "string" ? { directory: assets } : assets,
        );
      });

      const prepareBundle = (id: string, props: WorkerProps) =>
        bundler
          .build({
            id,
            main: props.main!,
            compatibility: getCompatibility(props),
            entry: props.isExternal
              ? {
                  kind: "external",
                }
              : {
                  kind: "effect",
                  exports: (props.exports ?? {}) as any,
                },
            stack: { name: stack.name, stage: stack.stage },
            extraOptions: props.build,
          })
          .pipe(Artifacts.cached("build"));

      const hashScript = (script: string) =>
        Effect.sync(() =>
          crypto.createHash("sha256").update(script).digest("hex"),
        );

      const viteBuild = Effect.fnUntraced(function* (props: WorkerProps) {
        const compatibility = getCompatibility(props);
        const { assetsDirectory, serverBundle } = yield* Vite.viteBuild(
          props.vite?.rootDir,
          Object.fromEntries(
            (yield* Effect.all(
              Object.entries(props.env ?? {}).map(
                Effect.fnUntraced(function* ([key, value]) {
                  return [
                    key,
                    typeof value === "string"
                      ? value
                      : Redacted.isRedacted(value) &&
                          typeof Redacted.value(value) === "string"
                        ? Redacted.value(value)
                        : Config.isConfig(value) || Effect.isEffect(value)
                          ? yield* value
                          : undefined,
                  ];
                }),
              ),
            )).filter(([_, value]) => value !== undefined),
          ),
          {
            compatibilityDate: compatibility.date,
            compatibilityFlags: compatibility.flags,
          },
        );

        if (!assetsDirectory && !serverBundle) {
          return yield* Effect.die(
            new Error("Vite build produced neither server nor client output"),
          );
        }
        const [assets, bundle] = yield* Effect.all(
          [
            assetsDirectory
              ? readAssets({
                  directory: assetsDirectory,
                  config:
                    typeof props.assets === "object" && "config" in props.assets
                      ? props.assets.config
                      : undefined,
                })
              : Effect.succeed(undefined),
            serverBundle
              ? Bundle.bundleOutputFromRolldownOutputBundle(serverBundle)
              : Effect.succeed(undefined),
          ],
          { concurrency: "unbounded" },
        );
        return { assets, bundle };
      });

      const prepareAssetsAndBundle = (
        id: string,
        props: WorkerProps,
        opts: { skipAssetsRead?: boolean } = {},
      ) =>
        Effect.gen(function* () {
          if (props.script !== undefined) {
            const [assets, bundleHash] = yield* Effect.all(
              [
                opts.skipAssetsRead
                  ? Effect.succeed(undefined)
                  : prepareAssets(props.assets),
                hashScript(props.script),
              ],
              { concurrency: "unbounded" },
            );
            return {
              assets,
              bundle: {
                files: [{ path: "main.js", content: props.script }],
                hash: bundleHash,
              },
            };
          }
          if (props.vite) {
            const [{ assets, bundle }, input] = yield* Effect.all(
              [
                viteBuild(props),
                // hashDirectory expects `{ cwd, memo }`. The vite props
                // store the project root under `rootDir`, so map it
                // here. Without this, `cwd` falls back to
                // `process.cwd()` and the input hash is computed over
                // the wrong directory tree (often the entire monorepo
                // root), making it both slow and unable to detect
                // changes scoped to the actual Vite project.
                hashDirectory({
                  cwd: props.vite.rootDir,
                  memo: props.vite.memo,
                }),
              ],
              { concurrency: "unbounded" },
            );
            return { assets, bundle, input };
          }
          const [assets, bundle] = yield* Effect.all(
            [
              opts.skipAssetsRead
                ? Effect.succeed(undefined)
                : prepareAssets(props.assets),
              prepareBundle(id, props),
            ],
            { concurrency: "unbounded" },
          );
          return { assets, bundle };
        }).pipe(
          Effect.map(({ assets, bundle, input }) => ({
            assets,
            bundle: {
              main: bundle?.files[0].path,
              files: bundle?.files.map(
                (file) =>
                  new File([file.content as BlobPart], file.path, {
                    type: contentTypeFromExtension(path.extname(file.path)),
                  }),
              ),
            },
            hash: {
              assets: assets?.hash,
              bundle: bundle?.hash,
              input,
            } satisfies Worker["Attributes"]["hash"],
          })),
        );

      const putWorker = Effect.fnUntraced(function* (
        id: string,
        news: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
        olds: WorkerProps | undefined,
        output: Worker["Attributes"] | undefined,
        session: ScopedPlanStatusSession,
        existingSettings?: workers.GetScriptScriptAndVersionSettingResponse,
      ) {
        const name = yield* createWorkerName(id, news.name);
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: preparing bundle for ${name}`,
        );
        // If the caller handed us a precomputed asset hash that matches
        // what we previously stored, we can skip walking the directory
        // entirely and tell Cloudflare to keep the assets it already
        // has bound to this script. The disk read is the expensive
        // part; the script PUT happens either way.
        const previousAssetsHash = output?.hash?.assets;
        const precomputedAssetsHash =
          news.assets &&
          typeof news.assets === "object" &&
          "path" in news.assets &&
          "hash" in news.assets
            ? (news.assets.hash as string)
            : undefined;
        const assetsConfigFromProps =
          news.assets &&
          typeof news.assets === "object" &&
          "config" in news.assets
            ? news.assets.config
            : undefined;
        const skipAssetsRead =
          precomputedAssetsHash !== undefined &&
          precomputedAssetsHash === previousAssetsHash;
        const {
          assets,
          bundle,
          hash: preparedHash,
        } = yield* prepareAssetsAndBundle(id, news, { skipAssetsRead });
        // When the caller supplied a precomputed hash (e.g. via
        // `Build.Command`), store *that* hash in output state so the
        // next diff can short-circuit by comparing it directly. The
        // hash that `readAssets` produces is the manifest-derived
        // hash, which is shaped differently from any upstream
        // build-input hash and will never match it on the next pass.
        const hash = {
          ...preparedHash,
          assets: precomputedAssetsHash ?? preparedHash.assets,
        } satisfies Worker["Attributes"]["hash"];
        const metadataBindings = bindings.flatMap((b) => b.data.bindings ?? []);
        const expectedDurableObjectClassNames =
          getExpectedDurableObjectClassNames(metadataBindings, name);
        let metadataAssets:
          | workers.PutScriptRequest["metadata"]["assets"]
          | undefined;
        let keepAssets = false;
        if (skipAssetsRead) {
          // Hash matched what's already on Cloudflare: keep the
          // existing asset manifest and skip the upload session.
          yield* Effect.logInfo(
            `Cloudflare Worker update: assets unchanged for ${name}, keeping existing`,
          );
          keepAssets = true;
          metadataAssets = assetsConfigFromProps
            ? { config: assetsConfigFromProps }
            : undefined;
          metadataBindings.push({
            type: "assets",
            name: "ASSETS",
          });
        } else if (assets) {
          // We had to read the directory. Even after the read, the
          // computed hash may match what's already deployed (e.g.
          // legacy `string` / `AssetsProps` shapes that don't carry a
          // precomputed hash, or a precomputed hash that disagreed with
          // disk). In that case still keep the existing manifest and
          // skip the upload session — Cloudflare's content-addressed
          // session would no-op on every byte anyway.
          if (assets.hash === previousAssetsHash) {
            yield* Effect.logInfo(
              `Cloudflare Worker update: assets unchanged for ${name}, keeping existing`,
            );
            keepAssets = true;
            metadataAssets = { config: assets.config };
          } else {
            yield* Effect.logInfo(
              `Cloudflare Worker ${olds ? "update" : "create"}: uploading assets for ${name}`,
            );
            const { jwt } = yield* uploadAssets(
              accountId,
              name,
              assets,
              session,
            );
            metadataAssets = {
              jwt,
              config: assets.config,
            };
          }
          metadataBindings.push({
            type: "assets",
            name: "ASSETS",
          });
        }
        metadataBindings.push(
          {
            type: "plain_text",
            name: "ALCHEMY_PHASE",
            text: "runtime",
          },
          {
            type: "plain_text",
            name: "ALCHEMY_STACK_NAME",
            text: stack.name,
          },
          {
            type: "plain_text",
            name: "ALCHEMY_STAGE",
            text: stack.stage,
          },
        );
        // Add environment variables as metadata bindings
        if (news.env) {
          for (const [key, value] of Object.entries(news.env)) {
            if (value === undefined) continue;
            if (metadataBindings.some((b) => b.name === key)) continue;
            if (Redacted.isRedacted(value)) {
              const unredacted = Redacted.value(value);
              metadataBindings.push({
                type: "secret_text",
                name: key,
                text:
                  typeof unredacted === "string"
                    ? unredacted
                    : JSON.stringify(unredacted),
              });
            } else if (typeof value === "string") {
              metadataBindings.push({
                type: "plain_text",
                name: key,
                text: value,
              });
            } else {
              metadataBindings.push({
                type: "json",
                name: key,
                json: value,
              });
            }
          }
        }
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: uploading script for ${name}`,
        );
        const size =
          bundle.files
            ?.filter((file) => !file.name.endsWith(".map"))
            .reduce((acc, file) => acc + file.size, 0) ?? 0;
        const sizeKB = size / 1024;
        const sizeMB = sizeKB / 1024;
        const bundleSize = `${sizeKB > 1024 ? `${sizeMB.toFixed(2)} MB` : `${sizeKB.toFixed(2)} KB`}`;
        yield* session.note(`Uploading worker (${bundleSize}) ...`);

        // Read existing worker settings for migration tracking
        const oldSettings =
          existingSettings ??
          (yield* getScriptSettings({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.map((s) => s as typeof s | undefined),
            Effect.catch(() => Effect.succeed(undefined)),
          ));

        const oldTags = Array.from(new Set(oldSettings?.tags ?? []));
        const oldBindings = oldSettings?.bindings ?? [];

        // Parse alchemy:do:{logicalId}:{className} tags
        const oldDoClassNameByLogicalId = getDurableObjectTagMap(oldTags);
        const currentDoBindings = getDurableObjectBindings(bindings, name);
        const currentDoClassNameByLogicalId = Object.fromEntries(
          currentDoBindings.map((binding) => [
            binding.logicalId,
            binding.className,
          ]),
        );

        // Parse alchemy:migration-tag:{version}
        const oldMigrationTag = oldTags.flatMap((tag) =>
          tag.startsWith("alchemy:migration-tag:")
            ? [tag.slice("alchemy:migration-tag:".length)]
            : [],
        )[0];
        const newMigrationTag = bumpMigrationTagVersion(oldMigrationTag);

        // Compute deleted classes
        const deletedClasses: string[] = [];
        for (const [logicalId, className] of Object.entries(
          oldDoClassNameByLogicalId,
        )) {
          if (!currentDoClassNameByLogicalId[logicalId]) {
            deletedClasses.push(className);
          }
        }

        // Backward compatibility for old workers that have DO bindings but no
        // alchemy:do tags yet. Cross-script bindings (`scriptName` set to
        // anything other than this worker) are NEVER candidates for
        // delete-class migrations — the class lives on the foreign script
        // and we don't own its lifecycle.
        if (Object.keys(oldDoClassNameByLogicalId).length === 0) {
          for (const oldBinding of oldBindings) {
            const ownedLocally =
              !("scriptName" in oldBinding) || oldBinding.scriptName === name;
            if (
              oldBinding.type === "durable_object_namespace" &&
              "className" in oldBinding &&
              oldBinding.className &&
              ownedLocally &&
              !currentDoBindings.some(
                (binding) => binding.bindingName === oldBinding.name,
              )
            ) {
              deletedClasses.push(oldBinding.className);
            }
          }
        }

        // Collect container-backed class names so we can send container metadata
        const containerClassNames = new Set(
          bindings.flatMap((b) =>
            (b.data.containers ?? []).map((c) => c.className),
          ),
        );

        // Compute new and renamed classes
        const newClasses: string[] = [];
        const newSqliteClasses: string[] = [];
        const renamedClasses: { from: string; to: string }[] = [];
        for (const binding of currentDoBindings) {
          const previousClassName =
            oldDoClassNameByLogicalId[binding.logicalId];
          if (!previousClassName) {
            // Default all new Durable Object classes to SQLite. Cloudflare
            // recommends SQLite for new namespaces, and container-backed
            // Durable Objects require it.
            newSqliteClasses.push(binding.className);
          } else if (previousClassName !== binding.className) {
            renamedClasses.push({
              from: previousClassName,
              to: binding.className,
            });
          }
        }

        yield* Effect.logInfo(
          `Cloudflare Worker put: durable object reconciliation ${JSON.stringify(
            {
              oldDoClassNameByLogicalId,
              currentDoClassNameByLogicalId,
              deletedClasses,
              renamedClasses,
              newSqliteClasses,
            },
          )}`,
        );

        // Build alchemy:do:{logicalId}:{className} tags for each DO binding
        const alchemyDoTags: string[] = [];
        for (const binding of currentDoBindings) {
          alchemyDoTags.push(
            `alchemy:do:${binding.logicalId}:${binding.className}`,
          );
        }

        const metadataTags = Array.from(
          new Set([
            ...createAlchemyWorkerTags(id),
            ...alchemyDoTags,
            ...(newMigrationTag
              ? [`alchemy:migration-tag:${newMigrationTag}`]
              : []),
            ...(news.tags ?? []),
          ]),
        );

        const migrations = {
          oldTag: oldMigrationTag,
          newTag: newMigrationTag,
          newClasses,
          deletedClasses,
          renamedClasses,
          transferredClasses: [] as { from: string; to: string }[],
          newSqliteClasses,
        };

        const metadataContainers = [...containerClassNames].map(
          (className) => ({
            className,
          }),
        );

        const compatibility = getCompatibility(news);
        const metadata: workers.PutScriptRequest["metadata"] = {
          assets: metadataAssets,
          bindings: metadataBindings,
          bodyPart: undefined,
          compatibilityDate: compatibility.date,
          compatibilityFlags: compatibility.flags,
          containers:
            metadataContainers.length > 0 ? metadataContainers : undefined,
          keepAssets,
          keepBindings: undefined,
          limits: news.limits,
          logpush: news.logpush,
          mainModule: bundle.main,
          migrations,
          observability: news.observability ?? {
            enabled: true,
            logs: {
              enabled: true,
              invocationLogs: true,
            },
          },
          placement: news.placement,
          tags: metadataTags,
          tailConsumers: undefined,
          usageModel: undefined,
        };
        const worker = yield* putScript({
          accountId,
          scriptName: name,
          metadata,
          files: bundle.files,
        }).pipe(
          Effect.catch((err) => {
            // When adopting a Worker managed by Wrangler (or after a previous
            // deploy with mismatched migrations), the old_tag precondition
            // fails. The only way to discover the actual tag is through the
            // error message — getScriptSettings is meant to return it but
            // doesn't at runtime.
            const msg = String(
              typeof err === "object" && err !== null && "message" in err
                ? err.message
                : err,
            );
            const expectedTag = msg.match(
              /when expected tag is ['"]?([^'"]+)['"]?/,
            )?.[1];
            if (expectedTag) {
              return putScript({
                accountId,
                scriptName: name,
                metadata: {
                  ...metadata,
                  migrations: {
                    ...migrations,
                    oldTag: expectedTag,
                    newTag: bumpMigrationTagVersion(expectedTag),
                  },
                },
                files: bundle.files,
              });
            }
            return Effect.fail(err as any);
          }),
        );
        const { settings, durableObjectNamespaces } =
          yield* getWorkerSettingsWithDurableObjects(
            name,
            expectedDurableObjectClassNames,
          );
        // Reconcile workers.dev subdomain against observed cloud state.
        // We can't diff `news.url` against `olds.url` here because both
        // default to `undefined` (meaning "enable") — that comparison
        // would skip the API call on every deploy where the user never
        // explicitly set `url`, leaving the subdomain in whatever state
        // Cloudflare currently has it (disabled by default, or whatever
        // a previous failed/external action left it as).
        const desiredSubdomainEnabled = news.url !== false;
        const observedSubdomain = yield* getScriptSubdomain({
          accountId,
          scriptName: name,
        }).pipe(
          Effect.orElseSucceed<workers.GetScriptSubdomainResponse>(() => ({
            enabled: false,
            previewsEnabled: false,
          })),
        );
        if (
          desiredSubdomainEnabled !== observedSubdomain.enabled ||
          desiredSubdomainEnabled !== observedSubdomain.previewsEnabled
        ) {
          yield* session.note(
            `${desiredSubdomainEnabled ? "Enabling" : "Disabling"} workers.dev subdomain...`,
          );
          // Cloudflare's script registry is eventually consistent — for the
          // first few hundred ms after `putScript` returns, POST /subdomain
          // can still get back `WorkerNotFound` (a generic "unknown error"
          // body), or a bare 500 surfaced as `InternalServerError` /
          // `UnknownCloudflareError` (code 10013). Bigger uploads race harder.
          // Retry the subdomain toggle on those transient tags with a short
          // exponential backoff; same pattern we use elsewhere in this
          // provider for DO-namespace propagation and for `putScript` itself.
          yield* setWorkerSubdomain(name, desiredSubdomainEnabled).pipe(
            Effect.retry({
              while: (error: { _tag?: string }) =>
                error?._tag === "WorkerNotFound" ||
                error?._tag === "InternalServerError" ||
                error?._tag === "UnknownCloudflareError",
              schedule: Schedule.exponential(200).pipe(
                Schedule.both(Schedule.recurs(15)),
              ),
            }),
          );
        }
        const desiredDomains = normalizeDomains(news.domain);
        const previousDomains = output?.domains ?? [];
        if (desiredDomains.length > 0 || previousDomains.length > 0) {
          yield* session.note(
            `Reconciling custom domains (${desiredDomains.length}) ...`,
          );
        }
        const reconciled = yield* reconcileDomains(name, desiredDomains);
        const workersDevUrl =
          news.url !== false
            ? `https://${name}.${yield* getAccountSubdomain(accountId)}.workers.dev`
            : undefined;
        const domains = [
          ...reconciled.map((d) => `https://${d.hostname}`),
          ...(workersDevUrl ? [workersDevUrl] : []),
        ];
        const crons = yield* reconcileCrons(
          name,
          normalizeCrons([...getCronBindings(bindings), ...(news.crons ?? [])]),
          output?.crons ?? [],
          session,
        );
        return {
          workerId: worker.id ?? name,
          workerName: name,
          logpush: worker.logpush ?? undefined,
          url: domains[0],
          tags: settings.tags ?? metadata.tags,
          durableObjectNamespaces,
          accountId,
          domains,
          crons,
          hash,
        } satisfies Worker["Attributes"];
      });

      const hasChanged = Effect.fnUntraced(function* (
        id: string,
        props: WorkerProps,
        output: Worker["Attributes"],
      ) {
        if (props.script !== undefined) {
          const scriptHash = yield* hashScript(props.script);
          if (scriptHash !== output.hash?.bundle) {
            return true;
          }
          if (!props.assets) {
            return false;
          }
          const assetsHash =
            typeof props.assets === "object" &&
            "path" in props.assets &&
            "hash" in props.assets
              ? (props.assets.hash as string)
              : undefined;
          if (assetsHash === undefined) {
            return true;
          }
          return assetsHash !== output.hash?.assets;
        }
        if (props.vite) {
          const input = yield* hashDirectory({
            cwd: props.vite.rootDir,
            memo: props.vite.memo,
          });
          return input !== output.hash?.input;
        }
        const bundleHash = yield* prepareBundle(id, props).pipe(
          Effect.map((b) => b.hash),
        );
        if (bundleHash !== output.hash?.bundle) {
          return true;
        }
        if (!props.assets) {
          return false;
        }
        // We deliberately don't read the assets directory during diff.
        // For `AssetsWithHash` (the documented contract) the upstream
        // `Build.Command` already gave us an authoritative hash — we
        // just compare strings. Reading the directory here would
        // (a) hash the same tree twice per apply (`putWorker` reads
        // again when an upload is actually required), and (b) crash
        // when the prior state was written on a different machine
        // and `path` doesn't exist locally — blocking any local
        // reapply even though the precomputed hash is right there
        // in props.
        //
        // For the legacy `string` / `AssetsProps` shapes there's no
        // hash in props to compare against, so we conservatively
        // assume the assets changed; `putWorker` will read once,
        // hash, and use `keepAssets` if it turns out nothing actually
        // changed.
        const assetsHash =
          typeof props.assets === "object" &&
          "path" in props.assets &&
          "hash" in props.assets
            ? (props.assets.hash as string)
            : undefined;
        if (assetsHash === undefined) {
          return true;
        }
        return assetsHash !== output.hash?.assets;
      });

      return Worker.Provider.of({
        stables: ["workerId", "workerName"],
        diff: Effect.fnUntraced(function* ({
          id,
          news,
          olds,
          output,
          newBindings,
        }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" };
          }
          const workerName = yield* createWorkerName(id, news.name);
          const oldWorkerName = output?.workerName
            ? output.workerName
            : yield* createWorkerName(id, olds?.name);
          if (workerName !== oldWorkerName) {
            return { action: "replace" };
          }
          if (!output) {
            return;
          }
          const newDomains = normalizeDomains(news.domain)
            .map((h) => `https://${h}`)
            .sort();
          const oldDomains = (output?.domains ?? [])
            .filter((u) => !u.endsWith(".workers.dev"))
            .sort();
          const domainsChanged =
            newDomains.length !== oldDomains.length ||
            newDomains.some((d, i) => d !== oldDomains[i]);
          const newCrons = normalizeCrons([
            ...(Array.isArray(newBindings)
              ? getCronBindings(
                  newBindings as ResourceBinding<Worker["Binding"]>[],
                )
              : []),
            ...(news.crons ?? []),
          ]).sort();
          const oldCrons = [...(output?.crons ?? [])].sort();
          const cronsChanged =
            newCrons.length !== oldCrons.length ||
            newCrons.some((cron, index) => cron !== oldCrons[index]);
          if (
            domainsChanged ||
            cronsChanged ||
            (yield* hasChanged(id, news, output))
          ) {
            return {
              action: "update",
              stables:
                oldWorkerName === workerName ? ["workerName"] : undefined,
            };
          }
        }),
        precreate: Effect.fnUntraced(function* ({ id, news, session }) {
          const name = yield* createWorkerName(id, news.name);
          const exportMap = (news.exports ?? {}) as Record<string, unknown>;
          const durableObjects = Object.keys(exportMap)
            .filter((logicalId) => isDurableObjectExport(exportMap[logicalId]))
            .map((logicalId) => ({
              logicalId,
              className: logicalId,
            }));
          const doClasses = durableObjects.map((binding) => binding.className);
          const containers = doClasses.map((className) => ({ className }));
          const alchemyDoTags = durableObjects.map(
            ({ logicalId, className }) =>
              `alchemy:do:${logicalId}:${className}`,
          );
          const tags = Array.from(
            new Set([
              ...createAlchemyWorkerTags(id),
              ...alchemyDoTags,
              ...(news.tags ?? []),
            ]),
          );
          yield* Effect.logInfo(
            `Cloudflare Worker precreate: starting ${name}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker precreate: durable objects ${JSON.stringify(
              durableObjects,
            )}`,
          );
          const existingSettings = yield* getScriptSettings({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
          );
          let durableObjectNamespaces = getDurableObjectNamespaces(
            existingSettings?.bindings,
          );

          if (existingSettings) {
            // Engine has already cleared this resource for write via
            // `read` + AdoptPolicy. Either we own it (matching tags) or
            // the user opted in to a takeover (`--adopt` / `adopt(true)`).
            yield* Effect.logInfo(
              `Cloudflare Worker precreate: reusing existing ${name}`,
            );
          } else {
            yield* session.note("Pre-creating worker...");
            const mainModule = "main.js";
            const placeholderScript = `${doClasses.length > 0 ? 'import { DurableObject } from "cloudflare:workers";\n\n' : ""}export default { fetch() { return new Response("Alchemy worker is being deployed...") } };\n${doClasses
              .map(
                (className) =>
                  `export class ${className} extends DurableObject {}`,
              )
              .join("\n")}`;
            yield* putScript({
              accountId,
              scriptName: name,
              metadata: {
                mainModule,
                bindings:
                  doClasses.length > 0
                    ? doClasses.map((className) => ({
                        type: "durable_object_namespace" as const,
                        name: className,
                        className,
                      }))
                    : undefined,
                ...getCompatibility(news),
                containers,
                migrations:
                  doClasses.length > 0
                    ? {
                        oldTag: undefined,
                        newTag: undefined,
                        newClasses: [],
                        deletedClasses: [],
                        renamedClasses: [],
                        transferredClasses: [],
                        newSqliteClasses: doClasses,
                      }
                    : undefined,
                observability: news.observability ?? {
                  enabled: true,
                  logs: {
                    enabled: true,
                    invocationLogs: true,
                  },
                },
                tags,
              },
              files: [
                new File([placeholderScript], mainModule, {
                  type: "application/javascript+module",
                }),
              ],
            }).pipe(
              // Cloudflare's PUT /workers/scripts/{name} intermittently
              // returns code 10002 / "An unknown error has occurred" on the
              // first put for a fresh worker name. Surfaced as the shared
              // `InternalServerError` upstream (alchemy-run/distilled#290).
              // Also match `UnknownCloudflareError` for older
              // @distilled.cloud/cloudflare versions that haven't picked
              // up the patch yet.
              Effect.retry({
                while: (e: any) =>
                  e._tag === "InternalServerError" ||
                  e._tag === "UnknownCloudflareError",
                schedule: Schedule.exponential(1000).pipe(
                  Schedule.both(Schedule.recurs(5)),
                ),
              }),
            );
            if (doClasses.length > 0) {
              ({ durableObjectNamespaces } =
                yield* getWorkerSettingsWithDurableObjects(name, doClasses));
            }
          }

          if (existingSettings && doClasses.length > 0) {
            ({ durableObjectNamespaces } =
              yield* getWorkerSettingsWithDurableObjects(name, doClasses));
          }

          return {
            workerId: name,
            workerName: name,
            logpush: existingSettings?.logpush ?? undefined,
            url: undefined,
            tags: existingSettings?.tags ?? tags,
            durableObjectNamespaces,
            accountId,
            domains: [],
            crons: [],
          } satisfies Worker["Attributes"];
        }),
        read: Effect.fnUntraced(
          function* ({ id, output, olds }) {
            const workerName =
              output?.workerName ?? (yield* createWorkerName(id, olds?.name));
            yield* Effect.logInfo(
              `Cloudflare Worker read: checking ${workerName}`,
            );
            // We deliberately don't call `listScripts({ accountId })` here:
            // it pulls every Worker on the account back through a strict
            // schema decode, and a single existing Worker the schema doesn't
            // know about (e.g. `placement_mode: "targeted"`) breaks the
            // entire read. `getScriptSettings` already fails with
            // `WorkerNotFound` if the script doesn't exist, which the
            // surrounding `Effect.catchTag` turns into `undefined` — that's
            // all the existence check we need.
            const [subdomain, settings, domainsList] = yield* Effect.all([
              getScriptSubdomain({
                accountId,
                scriptName: workerName,
              }),
              getScriptSettings({
                accountId,
                scriptName: workerName,
              }),
              listDomains({
                accountId,
                service: workerName,
              }).pipe(Effect.map((r) => r.result ?? [])),
            ]);
            // Preserve the order the user provided in `olds.domain`. The
            // Cloudflare API returns domains in non-deterministic order,
            // which would cause downstream `worker.domains[0]` reads to flip
            // between deploys. Drift (domains we don't know about) is
            // appended after the user-ordered ones.
            const userOrder = normalizeDomains(olds?.domain);
            const orderedHostnames = [
              ...userOrder.flatMap(
                (h) =>
                  domainsList.find((d) => d.hostname === h)?.hostname ?? [],
              ),
              ...domainsList.flatMap((d) =>
                d.hostname && !userOrder.includes(d.hostname)
                  ? [d.hostname]
                  : [],
              ),
            ];
            const workersDevUrl = subdomain.enabled
              ? `https://${workerName}.${yield* getAccountSubdomain(accountId)}.workers.dev`
              : undefined;
            const domains = [
              ...orderedHostnames.map((h) => `https://${h}`),
              ...(workersDevUrl ? [workersDevUrl] : []),
            ];
            const crons = yield* getWorkerCrons(workerName);
            yield* Effect.logInfo(
              `Cloudflare Worker read: found ${workerName}`,
            );
            const attrs = {
              accountId,
              workerId: workerName,
              workerName,
              logpush: settings.logpush ?? undefined,
              url: domains[0],
              tags: settings.tags ?? undefined,
              durableObjectNamespaces: getDurableObjectNamespaces(
                settings.bindings,
              ),
              domains,
              crons,
            } satisfies Worker["Attributes"];

            // Centralized ownership decision: the engine routes `read`'s
            // return value based on `AdoptPolicy`. We hand it the attrs
            // either as-is (owned: alchemy tags identify this stack/stage/id,
            // safe to silently adopt even without `--adopt`) or branded with
            // `Unowned` (caller must opt in via `--adopt` or the engine
            // raises `OwnedBySomeoneElse`).
            return hasAlchemyWorkerTags(id, settings.tags ?? [])
              ? attrs
              : Unowned(attrs);
          },
          (effect) =>
            effect.pipe(
              Effect.catchTag("WorkerNotFound", () =>
                Effect.succeed(undefined),
              ),
            ),
        ),
        reconcile: Effect.fnUntraced(function* ({
          id,
          news,
          olds,
          bindings,
          output,
          session,
        }) {
          const name =
            output?.workerName ?? (yield* createWorkerName(id, news.name));
          const durableObjects = getDurableObjectBindings(bindings, name).map(
            ({ logicalId, className }) => ({
              logicalId,
              className,
            }),
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: starting ${name}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: durable objects ${JSON.stringify(
              durableObjects,
            )}`,
          );

          // Observe — fetch the script's current settings if it already exists.
          // `putWorker` is a true upsert against the Cloudflare API; the
          // existing settings inform asset/migration decisions and let the
          // reconciler converge whether the worker is brand-new, adopted, or
          // an in-place update.
          const existingSettings = yield* getScriptSettings({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: existing durable object tags ${JSON.stringify(
              (existingSettings?.tags ?? []).filter((tag) =>
                tag.startsWith("alchemy:do:"),
              ),
            )}`,
          );
          yield* Effect.logInfo(
            `Cloudflare Worker reconcile: previous durable object tags ${JSON.stringify(
              (output?.tags ?? []).filter((tag) =>
                tag.startsWith("alchemy:do:"),
              ),
            )}`,
          );
          return yield* putWorker(
            id,
            news,
            bindings,
            olds,
            output,
            session,
            existingSettings,
          );
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* Effect.logInfo(
            `Cloudflare Worker delete: deleting ${output.workerName}`,
          );
          // Look up live domain IDs rather than trusting persisted state.
          // We no longer track `{ id, zoneId }` on the output; fetching
          // straight from Cloudflare handles both the normal case and
          // adopted workers whose domains we never recorded.
          const liveDomains = yield* listDomains({
            accountId: output.accountId,
            service: output.workerName,
          }).pipe(
            Effect.map((r) => r.result ?? []),
            Effect.catch(() => Effect.succeed([])),
          );
          if (liveDomains.length) {
            yield* Effect.all(
              liveDomains.flatMap((d) =>
                d.id
                  ? [
                      deleteDomain({
                        accountId: output.accountId,
                        domainId: d.id,
                      }).pipe(
                        Effect.catchTag("DomainNotFound", () => Effect.void),
                      ),
                    ]
                  : [],
              ),
              { concurrency: "unbounded" },
            );
          }
          yield* deleteScript({
            accountId: output.accountId,
            scriptName: output.workerName,
            // Force teardown of queue consumers, durable object classes, and
            // service bindings hanging off this worker. Without `force`, those
            // conditions raise QueueConsumerConflict / ServiceBindingConflict
            // and leave the script in CF. Alchemy is the source of truth for
            // the worker, so we want a hard delete on teardown.
            force: true,
          }).pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
        }),
        tail: ({ output }) =>
          telemetry.tailScript({
            accountId: output.accountId,
            scriptName: output.workerName,
          }),
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: [
              {
                key: "$workers.scriptName",
                operation: "eq",
                type: "string",
                value: output.workerName,
              },
            ],
            options,
          }),
      });
    }),
  );

const contentTypeFromExtension = (extension: string) => {
  switch (extension) {
    case ".wasm":
      return "application/wasm";
    case ".txt":
    case ".html":
    case ".sql":
    case ".custom":
      return "text/plain";
    case ".bin":
      return "application/octet-stream";
    case ".mjs":
    case ".js":
      return "application/javascript+module";
    case ".cjs":
      return "application/javascript";
    case ".map":
      return "application/source-map";
    default:
      return "application/octet-stream";
  }
};

function bumpMigrationTagVersion(
  oldTag: string | undefined,
): string | undefined {
  if (!oldTag) return undefined;
  const version = oldTag.match(/^(alchemy:)?v(\d+)$/)?.[2];
  if (!version) return "alchemy:v1";
  return `alchemy:v${parseInt(version, 10) + 1}`;
}

function getDurableObjectBindings(
  bindings: ReadonlyArray<ResourceBinding>,
  workerName: string,
) {
  // Resource authors (and the `make`/`yield* Tag`/plan-vs-apply machinery)
  // can register the same DO binding multiple times under the same logical
  // id — `binding()` is a plain `worker.bind` and intentionally has no
  // dedup. Collapse duplicates here so each `(logicalId, bindingName,
  // className)` tuple appears at most once. We also exclude cross-script
  // references: a `scriptName` pointing to *another* worker means this
  // worker just references a foreign class — ship the binding to
  // Cloudflare, but don't drive class migrations for it.
  const seen = new Set<string>();
  return bindings.flatMap((binding) =>
    (binding.data.bindings ?? []).flatMap((item: WorkerBinding) => {
      if (
        item.type !== "durable_object_namespace" ||
        !("className" in item) ||
        !item.className
      ) {
        return [];
      }
      if (item.scriptName !== undefined && item.scriptName !== workerName) {
        return [];
      }
      const dedupKey = `${binding.sid}::${item.name}::${item.className}`;
      if (seen.has(dedupKey)) return [];
      seen.add(dedupKey);
      return [
        {
          logicalId: binding.sid,
          bindingName: item.name,
          className: item.className,
        },
      ];
    }),
  );
}

function getDurableObjectTagMap(tags: ReadonlyArray<string>) {
  return Object.fromEntries(
    tags.flatMap((tag) => {
      if (!tag.startsWith("alchemy:do:")) {
        return [];
      }
      const parts = tag.split(":");
      const logicalId = parts[2];
      const className = parts.slice(3).join(":");
      return logicalId && className ? [[logicalId, className]] : [];
    }),
  );
}
