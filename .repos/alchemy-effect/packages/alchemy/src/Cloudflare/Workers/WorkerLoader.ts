import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ALCHEMY_PHASE } from "../../Phase.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { taggedFunction } from "../../Util/effect.ts";
import { asEffect } from "../../Util/index.ts";
import { fromCloudflareFetcher, type Fetcher } from "../Fetcher.ts";
import { makeRpcStub } from "./Rpc.ts";
import { Worker, WorkerEnvironment } from "./Worker.ts";

import type { WorkerLoader as _WorkerLoader } from "@cloudflare/workers-types";

type WorkerLoaderTypeId = "Cloudflare.DynamicWorker";
const WorkerLoaderTypeId: WorkerLoaderTypeId = "Cloudflare.DynamicWorker";

export interface WorkerLoaderWorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  allowExperimental?: boolean;
  limits?: workerdResourceLimits;
  mainModule: string;
  modules: Record<string, WorkerLoaderModule | string>;
  env?: any;
  globalOutbound?: Fetcher | null;
  tails?: Fetcher[];
  streamingTails?: Fetcher[];
}

export type WorkerEntrypoint<Shape = unknown> = Fetcher & {
  [K in keyof Shape]: Shape[K];
};

export interface WorkerStub extends Fetcher {
  getEntrypoint<Shape = unknown>(name?: string): WorkerEntrypoint<Shape>;
}

export type WorkerLoader = {
  Type: WorkerLoaderTypeId;
  name: string;
  get<Err = never, Req = never>(
    name: string | null,
    getCode: () =>
      | WorkerLoaderWorkerCode
      | Effect.Effect<WorkerLoaderWorkerCode, Err, Req>,
  ): Effect.Effect<WorkerStub, Err, Req>;
  load(
    code: WorkerLoaderWorkerCode,
  ): Effect.Effect<WorkerStub, never, RuntimeContext>;
};

/**
 * Effect returned by `WorkerLoader(name)`.
 *
 * It is a real `Effect` — `yield* WorkerLoader(name)` inside a Worker init
 * attaches the binding and resolves the runtime handle — but it also carries
 * the `~alchemy/Kind` marker statically, so when it is declared on a Worker's
 * `env` the binding machinery recognises it as a `worker_loader` binding
 * (`isWorkerLoader`) instead of running it. Every env-resolution site that
 * branches on "is this a runnable Effect?" therefore checks `~alchemy/Kind`
 * (via `isWorkerLoader` or `isYieldableEffectLike`) before `Effect.isEffect`.
 */
export interface WorkerLoaderEffect extends Effect.Effect<
  WorkerLoader,
  never,
  WorkerEnvironment | Worker
> {
  "~alchemy/Kind": WorkerLoaderTypeId;
  "~alchemy/Name": string;
  name: string;
}

export const isWorkerLoader = (value: unknown): value is WorkerLoader =>
  typeof value === "object" &&
  value !== null &&
  "~alchemy/Kind" in value &&
  (value as WorkerLoaderEffect)["~alchemy/Kind"] === WorkerLoaderTypeId;

export interface WorkerLoaderClass extends Context.Service<
  WorkerLoader,
  WorkerLoader
> {
  (name?: string): WorkerLoaderEffect;
  layer(loader: WorkerLoader): Layer.Layer<WorkerLoader>;
  layer(id: string): Layer.Layer<WorkerLoader>;
}

/**
 * Load and run ephemeral Workers at runtime from inline JavaScript
 * modules.
 *
 * `WorkerLoader` registers a `worker_loader` binding on the
 * parent Worker at deploy time. At runtime you call `.load()` with
 * inline module source code and get back a fully typed Worker
 * instance you can `fetch` or call RPC methods on. Each loaded
 * Worker runs in its own isolate with full sandboxing.
 *
 * This is useful for evaluating user-provided code, running
 * untrusted plugins, or dynamically generating Workers from
 * templates.
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 *
 * @section Creating a Loader
 * Yield `Cloudflare.WorkerLoader(name)` in your Worker's init
 * phase to register the binding and get back a runtime handle. The
 * string argument becomes the binding name on the deployed Worker.
 *
 * @example Registering a loader (effect-native Worker)
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 * import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
 *
 * export default class EvalWorker extends Cloudflare.Worker<EvalWorker>()(
 *   "EvalWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Registers the `worker_loader` binding on this Worker
 *     const loader = yield* Cloudflare.WorkerLoader("LOADER");
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const code = yield* request.text;
 *
 *         // Spin up an isolated, sandboxed Worker from inline source.
 *         const worker = yield* loader.load({
 *           compatibilityDate: "2026-01-28",
 *           mainModule: "worker.js",
 *           modules: {
 *             "worker.js": `export default {
 *               async fetch(req) {
 *                 const result = (0, eval)(await req.text());
 *                 return new Response(String(result));
 *               }
 *             }`,
 *           },
 *           globalOutbound: null, // block outbound network access
 *         });
 *
 *         // Call the loaded Worker over Effect-native HTTP.
 *         const response = yield* worker.fetch(
 *           HttpClientRequest.post("https://worker/").pipe(
 *             HttpClientRequest.bodyText(code),
 *           ),
 *         );
 *         return HttpServerResponse.fromClientResponse(response);
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @example Declaring on env (async Worker)
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { LOADER: Cloudflare.WorkerLoader() },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 *
 * // worker.ts
 * export default {
 *   async fetch(req: Request, env: WorkerEnv) {
 *     const worker = env.LOADER.load({
 *       compatibilityDate: "2026-01-28",
 *       mainModule: "worker.js",
 *       modules: { "worker.js": "export default { fetch: () => new Response('ok') }" },
 *     });
 *     return worker.getEntrypoint().fetch(req);
 *   },
 * };
 * ```
 *
 * @section Loading a Worker
 * Call `loader.load()` with a compatibility date, a main module
 * name, and a map of module names to source code strings. The
 * returned instance exposes `.fetch()` for HTTP and RPC methods
 * for named entrypoints.
 *
 * @example Loading and calling a dynamic Worker
 * ```typescript
 * const worker = loader.load({
 *   compatibilityDate: "2026-01-28",
 *   mainModule: "worker.js",
 *   modules: {
 *     "worker.js": `export default {
 *       async fetch(request) {
 *         return new Response("Hello from dynamic worker!");
 *       }
 *     }`,
 *   },
 * });
 *
 * const response = yield* worker.fetch(
 *   HttpClientRequest.get("https://worker/"),
 * );
 * ```
 *
 * @section Sandboxing
 * Set `globalOutbound` to `null` to block all outbound network
 * access from the dynamic Worker, or pass an RPC stub to intercept
 * and proxy outbound requests.
 *
 * @example Blocking outbound access
 * ```typescript
 * const worker = loader.load({
 *   compatibilityDate: "2026-01-28",
 *   mainModule: "worker.js",
 *   modules: {
 *     "worker.js": `export default {
 *       async fetch(req) {
 *         // fetch() calls from here will fail
 *         return new Response("sandboxed");
 *       }
 *     }`,
 *   },
 *   globalOutbound: null,
 * });
 * ```
 *
 * @section Named Entrypoints
 * If the dynamic Worker exports named entrypoints, use
 * `.getEntrypoint(name)` to get a typed stub for calling its
 * methods.
 *
 * @example Calling a named entrypoint
 * ```typescript
 * const worker = loader.load({ ... });
 * const api = worker.getEntrypoint<{ greet: (name: string) => Effect.Effect<string> }>("api");
 * const greeting = yield* api.greet("world");
 * ```
 */
export const WorkerLoader: WorkerLoaderClass = Object.assign(
  taggedFunction(
    Context.Service()("Cloudflare.WorkerLoader"),
    (name = "LOADER") =>
      Object.assign(
        Effect.gen(function* () {
          yield* (yield* Worker).bind`${name}`({
            bindings: [{ type: "worker_loader", name }],
          });

          const loader: _WorkerLoader = yield* Effect.all([
            WorkerEnvironment,
            ALCHEMY_PHASE,
          ]).pipe(
            Effect.flatMap(([env, phase]) => {
              if (env === undefined || phase === "plan") {
                return Effect.succeed(undefined as any);
              }
              const loader = env[name];
              if (!loader) {
                return Effect.die(
                  new Error(`WorkerLoader '${name}' not found in env`),
                );
              }
              return Effect.succeed(loader);
            }),
          );

          return {
            Type: WorkerLoaderTypeId,
            name,
            load: (options) =>
              Effect.sync(() =>
                wrapWorkerStub(loader.load(unwrapWorkerLoader(options))),
              ),
            get: <Req = never, Err = never>(
              name: string,
              getCode: () => Effect.Effect<WorkerLoaderWorkerCode, Err, Req>,
            ) =>
              Effect.flatMap(Effect.context<Req>(), (context) =>
                Effect.sync(() =>
                  wrapWorkerEntrypoint(
                    loader.get(name, () =>
                      asEffect(getCode()).pipe(
                        Effect.provide(context),
                        Effect.map(unwrapWorkerLoader),
                        Effect.runPromise,
                      ),
                    ),
                  ),
                ),
              ),
          } satisfies WorkerLoader;
        }),
        {
          "~alchemy/Name": name,
          "~alchemy/Kind": WorkerLoaderTypeId,
          name,
        },
      ),
  ),
  {
    layer: (loader: WorkerLoader) =>
      Layer.succeed(Context.Service()("Cloudflare.WorkerLoader"), loader),
  },
) as any;

/**
 * Convert the Effect-level worker code into the shape the native
 * `env.LOADER.get()` API expects, unwrapping wrapped `Fetcher`s to their raw
 * Cloudflare fetchers. `globalOutbound: null` (disable network access for the
 * dynamic worker) must survive as `null` — `?.raw` alone would coerce it to
 * `undefined`, which the runtime treats as "default outbound", silently
 * re-enabling network access for workers meant to be sandboxed (#746).
 */
const unwrapWorkerLoader = (loader: WorkerLoaderWorkerCode) => ({
  ...loader,
  globalOutbound:
    loader.globalOutbound === null ? null : loader.globalOutbound?.raw,
  tails: loader.tails?.map((t) => t.raw),
  streamingTails: loader.streamingTails?.map((t) => t.raw),
});

const wrapWorkerEntrypoint = <Shape>(raw: any): WorkerEntrypoint<Shape> =>
  Object.assign(makeRpcStub<any>(raw), fromCloudflareFetcher(raw));

const wrapWorkerStub = (raw: any): WorkerStub => {
  const defaultEntrypoint = fromCloudflareFetcher(raw.getEntrypoint());
  return {
    ...defaultEntrypoint,
    getEntrypoint: <Shape>(name?: string) =>
      wrapWorkerEntrypoint<Shape>(
        name ? raw.getEntrypoint(name) : raw.getEntrypoint(),
      ),
  };
};
