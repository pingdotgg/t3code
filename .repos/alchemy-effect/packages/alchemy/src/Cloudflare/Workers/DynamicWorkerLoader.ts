import * as Effect from "effect/Effect";
import { SingleShotGen } from "effect/Utils";
import { ALCHEMY_PHASE } from "../../Phase.ts";
import { fromCloudflareFetcher, type Fetcher } from "../Fetcher.ts";
import { makeRpcStub } from "./Rpc.ts";
import { Worker, WorkerEnvironment } from "./Worker.ts";

type DynamicWorkerTypeId = "Cloudflare.DynamicWorker";
const DynamicWorkerTypeId: DynamicWorkerTypeId = "Cloudflare.DynamicWorker";

/**
 * Options for loading a dynamic worker at runtime.
 */
export interface DynamicWorkerLoadOptions {
  /**
   * Compatibility date for the dynamic worker runtime.
   */
  compatibilityDate: string;
  /**
   * Name of the main module entry point (must match a key in `modules`).
   */
  mainModule: string;
  /**
   * Map of module names to source code strings.
   */
  modules: Record<string, string>;
  /**
   * Environment bindings to pass to the dynamic worker.
   */
  env?: Record<string, unknown>;
  /**
   * Controls outbound network access. Set to `null` to block all outbound
   * fetch/connect calls. Pass an RPC stub to intercept them.
   */
  globalOutbound?: null | unknown;
}

/**
 * An entrypoint stub on a loaded dynamic worker.
 * Extends `Fetcher` for Effect-native HTTP, and proxies arbitrary
 * RPC method calls as Effects.
 */
export type DynamicWorkerEntrypoint<Shape = unknown> = Fetcher & {
  [K in keyof Shape]: Shape[K];
};

/**
 * A loaded dynamic worker instance. Extends `Fetcher` for Effect-native
 * HTTP on the default entrypoint, plus `.getEntrypoint()` for named ones.
 */
export interface DynamicWorkerInstance extends Fetcher {
  /**
   * Get a named entrypoint (or the default entrypoint if no name is given).
   * Returns a Fetcher + RPC stub where every method call yields an Effect.
   */
  getEntrypoint<Shape = unknown>(name?: string): DynamicWorkerEntrypoint<Shape>;
}

/**
 * The runtime handle obtained by `yield* Cloudflare.DynamicWorkerLoader(name)`.
 * Provides a `.load()` method for spinning up isolated dynamic workers.
 */
export interface DynamicWorkerLoaderHandle {
  Type: DynamicWorkerTypeId;
  name: string;
  /**
   * Load a dynamic worker with the given options. The returned instance
   * exposes `.getEntrypoint()` and `.fetch()` for calling into the worker.
   */
  load(options: DynamicWorkerLoadOptions): DynamicWorkerInstance;
}

/**
 * The native `worker_loader` runtime binding shape, as seen by an async
 * (non-Effect) Worker that declares the loader through `env`. `InferEnv` maps
 * a `DynamicWorkerLoader` marker in `env` to this type.
 */
export interface DynamicWorkerLoaderBinding {
  load(options: DynamicWorkerLoadOptions): {
    getEntrypoint(name?: string): {
      fetch(request: Request): Promise<Response>;
      [method: string]: unknown;
    };
  };
}

/**
 * The Effect yielded when a `DynamicWorkerLoader` marker is used inside a
 * Worker init phase: it registers the `worker_loader` binding on the
 * surrounding Worker and resolves to a {@link DynamicWorkerLoaderHandle}.
 */
type BindEffect = ReturnType<typeof bindLoader>;

/**
 * Marker for a Cloudflare Worker Loader binding.
 *
 * It is a plain data structure (so it can be declared directly on a Worker's
 * `env`) that is **also** yieldable inside an Effect-native Worker. Yielding it
 * (`yield* Cloudflare.DynamicWorkerLoader(name)`) registers the binding on the
 * surrounding Worker and returns a {@link DynamicWorkerLoaderHandle} with
 * `.load()` — no separate `.bind(...)` step required.
 *
 * The divergence is achieved via `[Symbol.iterator]`: the object is not an
 * `Effect` (so `InferEnv` resolves it to the native
 * {@link DynamicWorkerLoaderBinding} in the `env` position), but it is iterable
 * as one when `yield*`-ed.
 */
export interface DynamicWorkerLoader {
  kind: DynamicWorkerTypeId;
  name: string;
  asEffect(): BindEffect;
  [Symbol.iterator](): SingleShotGen<BindEffect, DynamicWorkerLoaderHandle>;
}

export const isDynamicWorkerLoader = (
  value: unknown,
): value is DynamicWorkerLoader =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as DynamicWorkerLoader).kind === DynamicWorkerTypeId;

/**
 * Load and run ephemeral Workers at runtime from inline JavaScript
 * modules.
 *
 * `DynamicWorkerLoader` registers a `worker_loader` binding on the
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
 *
 * @section Creating a Loader
 * Yield `Cloudflare.DynamicWorkerLoader(name)` in your Worker's init
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
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     // Registers the `worker_loader` binding on this Worker and returns the
 *     // runtime handle in one step — no separate `.bind(...)`.
 *     const loader = yield* Cloudflare.DynamicWorkerLoader("LOADER");
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const code = yield* request.text;
 *
 *         // Spin up an isolated, sandboxed Worker from inline source.
 *         const worker = loader.load({
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
 *   env: { LOADER: Cloudflare.DynamicWorkerLoader() },
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
export const DynamicWorkerLoader = (name = "LOADER"): DynamicWorkerLoader => {
  const self: DynamicWorkerLoader = {
    kind: DynamicWorkerTypeId,
    name,
    asEffect: () => bindLoader(name),
    [Symbol.iterator]: () => new SingleShotGen(bindLoader(name)),
  };
  return self;
};

const bindLoader = Effect.fnUntraced(function* (name: string) {
  const worker = yield* Worker;

  yield* worker.bind`${name}`({
    bindings: [{ type: "worker_loader", name } as any],
  });

  const binding = yield* Effect.all([WorkerEnvironment, ALCHEMY_PHASE]).pipe(
    Effect.flatMap(([env, phase]) => {
      if (env === undefined || phase === "plan") {
        return Effect.succeed(undefined as any);
      }
      const loader = env[name];
      if (!loader) {
        return Effect.die(
          new Error(`DynamicWorker '${name}' not found in env`),
        );
      }
      return Effect.succeed(loader);
    }),
  );

  const handle: DynamicWorkerLoaderHandle = {
    Type: DynamicWorkerTypeId,
    name,
    load: (options: DynamicWorkerLoadOptions): DynamicWorkerInstance =>
      wrapLoadedWorker(binding.load(options)),
  };

  return handle;
});

const wrapEntrypoint = <Shape>(raw: any): DynamicWorkerEntrypoint<Shape> =>
  Object.assign(makeRpcStub<any>(raw), fromCloudflareFetcher(raw));

const wrapLoadedWorker = (raw: any): DynamicWorkerInstance => {
  const defaultEntrypoint = fromCloudflareFetcher(raw.getEntrypoint());
  return {
    ...defaultEntrypoint,
    getEntrypoint: <Shape>(name?: string) =>
      wrapEntrypoint<Shape>(
        name ? raw.getEntrypoint(name) : raw.getEntrypoint(),
      ),
  };
};
