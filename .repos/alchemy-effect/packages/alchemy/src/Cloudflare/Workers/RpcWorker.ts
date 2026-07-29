import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  type Rpc,
  RpcClient,
  type RpcGroup,
  RpcSerialization,
} from "effect/unstable/rpc";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type { Dependencies } from "../../Dependencies.ts";
import type { HttpEffect } from "../../Http.ts";
import type { InputProps } from "../../Input.ts";
import type { Rpc as RpcShape } from "../../Rpc.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import type { Worker, WorkerProps } from "./Worker.ts";
import { Worker as WorkerCtor, WorkerEnvironment } from "./Worker.ts";

/**
 * Props for {@link RpcWorker}. Same shape as {@link WorkerProps} with
 * an additional `schema` field carrying the rpc group definition.
 */
export type RpcWorkerProps<Rpcs extends Rpc.Any> = {
  /**
   * The {@link RpcGroup.RpcGroup} served on this worker's `fetch`
   * handler. The same value should be importable by any consumer of
   * the worker (other workers or scripts using `RpcClient.make`).
   */
  readonly schema: RpcGroup.RpcGroup<Rpcs>;
};

// Context tag carrying the surrounding `RpcWorker` value, so
// `yield* RpcWorker` inside the impl resolves to the worker itself
// (mirrors `yield* Worker` semantics inside `Cloudflare.Worker`).
// Documented as part of the main `RpcWorker` JSDoc below.
export class RpcWorkerScope extends Context.Service<RpcWorkerScope, Worker>()(
  "Cloudflare.RpcWorker",
) {}

// Symbol used internally to stash the rpc `RpcGroup` schema on the
// `effectClass` that `RpcWorker(...)` returns, so `RpcWorker.bind`
// can recover it when handed the class later.
const SchemaSymbol = Symbol.for("alchemy.RpcWorker.schema");

// Phantom carrier — `RpcWorker.bind` uses `Rpcs` to type the returned
// rpc client. We don't tie it to a specific `Effect.R` since the
// requirements come from the underlying `Cloudflare.Worker` factory
// and shouldn't leak into the Stack-side service signature.
//
// `Deps` mirrors `Cloudflare.Worker<Self, Bindings, Deps>` — declares
// the DOs / Workers this script publishes for cross-script binding so
// `Counter.from(WorkerA)` type-checks from another script.
export interface RpcWorkerYieldable<
  Self,
  Rpcs extends Rpc.Any,
  Deps = never,
> extends Effect.Effect<
  Worker<{}> & RpcShape<Self> & Dependencies<Deps>,
  never,
  any
> {
  /** @internal */
  readonly [SchemaSymbol]: RpcGroup.RpcGroup<Rpcs>;
}

/**
 * Type of the {@link RpcWorker} constructor. Mirrors the class-form
 * signature of {@link Worker} so `class X extends RpcWorker<X>()(...)`
 * works identically and the resulting worker is `Rpc<Self>`-typed for
 * binding consumers.
 */
export interface RpcWorkerClass extends Effect.Effect<
  Worker,
  never,
  RpcWorkerScope
> {
  /**
   * Class-based form: `class X extends RpcWorker<X>()(name, props, impl)`.
   *
   * The optional second type argument `Deps` mirrors
   * `Cloudflare.Worker<Self, Bindings, Deps>` — it declares the DOs
   * this Worker publishes for cross-script binding so consumers can
   * write `Counter.from(WorkerA)` and have it type-check. `Rpcs` is
   * always inferred from `props.schema`.
   *
   * Yielding the class in a Stack returns the {@link Worker} resource
   * (so `worker.url`, `worker.workerName`, etc. work as usual). To get
   * a typed `RpcClient` for *this* worker's rpc group from inside
   * another worker's init, call {@link RpcWorker.bind}.
   */
  <Self, Deps = never>(): {
    /**
     * Modular form (no impl). Mirrors `Cloudflare.Worker<Self>()(id, props)`.
     * Use `WorkerClass.make(impl)` to provide the runtime as a
     * `Layer.Layer<Self>` so consumers that don't host the worker can
     * import the class without pulling its runtime into their bundle.
     */
    <Rpcs extends Rpc.Any>(
      id: string,
      props: RpcWorkerProps<Rpcs>,
    ): RpcWorkerYieldable<Self, Rpcs, Deps> & {
      new (_: never): {};
      make<InnerR = never, InitReq = never>(
        props: InputProps<WorkerProps>,
        impl: Effect.Effect<
          Effect.Effect<HttpEffect<InnerR>, never, InnerR>,
          ConfigError,
          InitReq
        >,
      ): Layer.Layer<Self, never, Exclude<InitReq | InnerR, never>>;
    };
    /** Inline-impl form. */
    <Rpcs extends Rpc.Any, InnerR = never, InitReq = never>(
      id: string,
      props: RpcWorkerProps<Rpcs> & InputProps<WorkerProps>,
      impl: Effect.Effect<
        Effect.Effect<HttpEffect<InnerR>, never, InnerR>,
        ConfigError,
        InitReq
      >,
    ): RpcWorkerYieldable<Self, Rpcs, Deps> & {
      // Phantom — `class X extends RpcWorker<X>()(...)` carries `X`
      // through the result type via `Rpc<Self>` on the binding side;
      // the instance shape itself is empty (no methods exposed on
      // `new X(...)` — everything goes through `fetch`).
      new (_: never): {};
    };
  };

  /**
   * Bind a typed Effect rpc client to a worker resource, using the
   * worker's declared rpc {@link RpcGroup.RpcGroup} schema. Mirrors
   * `Cloudflare.R2.ReadWriteBucket(MyBucket)` and friends.
   *
   * Yield once at **init** — the result is a normal `RpcClient` you
   * can call directly from any per-request handler. Internally each
   * method invocation builds a fresh underlying `RpcClient` (through
   * a Proxy) because Cloudflare rejects I/O objects created on a
   * previous request; this is hidden from the consumer.
   *
   * Pair with {@link RpcWorker} on the server side; both ends share
   * the same schema so values round-trip through one `Schema` codec.
   *
   * @example
   * ```ts
   * // INIT: register the binding once and get the typed client
   * const tasks = yield* Cloudflare.RpcWorker.bind(TaskWorker);
   *
   * // PER-REQUEST: call methods directly
   * proxyGetTask: ({ id }) => tasks.getTask({ id }),
   * ```
   */
  readonly bind: <Self, Rpcs extends Rpc.Any>(
    workerEff: RpcWorkerYieldable<Self, Rpcs>,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> & RpcShape<Self>,
    never,
    Worker
  >;
}

/** @internal helper — exposed as `RpcWorker.bind` below. */
const bind = <Self, Rpcs extends Rpc.Any>(
  workerEff: RpcWorkerYieldable<Self, Rpcs>,
): Effect.Effect<
  RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> & RpcShape<Self>,
  never,
  Worker
> =>
  Effect.gen(function* () {
    const schema = (workerEff as unknown as Record<symbol, unknown>)[
      SchemaSymbol
    ] as RpcGroup.RpcGroup<Rpcs> | undefined;
    if (!schema) {
      return yield* Effect.die(
        new Error(
          "RpcWorker.bind: passed value isn't an RpcWorker class — no schema attached.",
        ),
      );
    }
    const worker = (yield* workerEff) as Worker;
    // Register the service binding on the surrounding worker at INIT.
    // Mirrors `Cloudflare.Workers.bindWorker` — yielding the class is *not*
    // enough; we need an explicit `self.bind\`${worker}\`(...)` so
    // workerd surfaces the stub on `env` at request time.
    const self = yield* WorkerCtor;
    yield* self.bind`${worker}`({
      bindings: [
        {
          type: "service",
          name: worker.LogicalId,
          service: worker.workerName,
        },
      ],
    });

    // Build a per-call factory that wraps the Cloudflare service-
    // binding stub (Promise-based fetch) into an Effect `HttpClient`,
    // then `RpcClient.make` over that transport. Each call gets its
    // own `RpcClient` because Cloudflare rejects I/O objects (the
    // stub.fetch body) that were created on a previous request.
    const makeFreshClient = Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      const stub = (env as Record<string, { fetch: typeof fetch }>)[
        worker.LogicalId
      ];
      const httpClient = HttpClient.make((req) =>
        Effect.promise((signal) =>
          stub.fetch(
            new Request(req.url, {
              method: req.method,
              headers: new Headers(req.headers as any),
              body: (req.body as any)?.body ?? undefined,
              signal,
            }),
          ),
        ).pipe(Effect.map((res) => HttpClientResponse.fromWeb(req, res))),
      );
      const protocol = RpcClient.layerProtocolHttp({
        url: "http://alchemy-rpc-worker/",
      }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
      );
      return yield* RpcClient.make(schema).pipe(Effect.provide(protocol));
    });

    // Return a Proxy that LOOKS like an `RpcClient<Rpcs>` but defers
    // the actual `RpcClient` construction to call time. Mirrors
    // `makeRpcStub` from `./Rpc.ts`: each method invocation builds a
    // fresh client, runs the call inside `Effect.scoped`, and tears
    // the client's scope down with the call. From the consumer's
    // perspective this is a normal `RpcClient`:
    //
    //   const tasks = yield* Cloudflare.RpcWorker.bind(TaskWorker);
    //   yield* tasks.getTask({ id: "abc" });
    return new Proxy(
      {},
      {
        get: (_target, method) => {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) =>
            Effect.gen(function* () {
              const client = yield* makeFreshClient;
              const fn = (
                client as unknown as Record<
                  string,
                  (...a: unknown[]) => Effect.Effect<unknown, unknown, unknown>
                >
              )[method];
              return yield* fn(...args);
            }).pipe(Effect.scoped);
        },
      },
    ) as RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> &
      RpcShape<Self>;
  });

/**
 * `RpcWorker` is a thin sugar over {@link Worker} for the common case
 * where a worker's entire `fetch` surface is a typed Effect `RpcGroup`.
 * It takes the rpc `schema` directly in props alongside `main`, and
 * accepts an init Effect that returns the already-piped
 * `RpcServer.toHttpEffect(...)`-producing Effect (no `{ fetch }`
 * wrapper) — the wrapper plugs it into the worker's `fetch` for you.
 *
 * Functionally identical to writing `Cloudflare.Worker(...)` with
 * `return { fetch: RpcServer.toHttpEffect(schema).pipe(...) }`; use
 * whichever style you prefer.
 *
 * The class form (`class X extends Cloudflare.RpcWorker<X>()(...)`)
 * carries `Self` through the result type as `Rpc<Self>`, so other
 * workers binding to this one see the rpc shape pinned to `Self`.
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 *
 * @section Defining the rpc group
 * @example Pure schema description
 * The rpc group and its schemas live outside any worker so both the
 * server (`RpcWorker`) and any consumers (`RpcClient.make` /
 * `RpcDurableObject`) import the same value.
 * ```typescript
 * import * as Schema from "effect/Schema";
 * import { Rpc, RpcGroup } from "effect/unstable/rpc";
 *
 * export class TaskNotFound extends Schema.TaggedClass<TaskNotFound>()(
 *   "TaskNotFound",
 *   { id: Schema.String },
 * ) {}
 *
 * const getTask = Rpc.make("getTask", {
 *   payload: { id: Schema.String },
 *   success: Schema.String,
 *   error: TaskNotFound,
 * });
 *
 * export class TaskRpcs extends RpcGroup.make(getTask) {}
 * ```
 *
 * @section Implementing the worker
 * @example Class form (recommended)
 * Mirrors `Cloudflare.Worker<Self>()(...)` — `class X extends ...`
 * works the same. The init Effect builds a handlers `Layer` from the
 * group and returns the `RpcServer.toHttpEffect(schema)`-piped Effect
 * directly.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
 * import { TaskRpcs } from "./rpcs.ts";
 *
 * export default class Worker extends Cloudflare.RpcWorker<Worker>()(
 *   "Worker",
 *   { main: import.meta.url, schema: TaskRpcs },
 *   Effect.gen(function* () {
 *     const handlers = TaskRpcs.toLayer({
 *       getTask: ({ id }) => Effect.succeed(`task-${id}`),
 *     });
 *     return RpcServer.toHttpEffect(TaskRpcs).pipe(
 *       Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
 *     );
 *   }),
 * ) {}
 * ```
 *
 * @example NDJSON for streaming rpcs
 * If any rpc in the group is a streaming rpc, the wire serialization
 * must be `RpcSerialization.layerNdjson` — streaming rpcs need
 * newline framing on the wire.
 * ```typescript
 * return RpcServer.toHttpEffect(ChatRpcs).pipe(
 *   Effect.provide(handlers),
 *   Effect.provide(RpcSerialization.layerNdjson),
 * );
 * ```
 *
 * @section Modular form: separate the class from its runtime
 * @example Class declaration with no impl + `static make(impl)`
 * The inline class form above bundles the runtime into the class
 * declaration. The two-arg form `(id, props)` declares the class
 * as a pure tagged identifier; provide the runtime separately via
 * `WorkerClass.make(impl)` so consumers can import the class for
 * binding without pulling the host's runtime into their bundle.
 * ```typescript
 * export class TaskWorker extends Cloudflare.RpcWorker<TaskWorker>()(
 *   "TaskWorker",
 *   { main: import.meta.url, schema: TaskRpcs },
 * ) {}
 *
 * // Only the host script imports this default export; consumers
 * // import the class above for `RpcWorker.bind(TaskWorker)`.
 * export default TaskWorker.make(
 *   Effect.gen(function* () {
 *     const handlers = TaskRpcs.toLayer({
 *       getTask: ({ id }) => Effect.succeed(`task-${id}`),
 *     });
 *     return RpcServer.toHttpEffect(TaskRpcs).pipe(
 *       Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
 *     );
 *   }),
 * );
 * ```
 *
 * @section Hosting a Durable Object for cross-script binding
 * @example `RpcWorker<Self, Deps>()` declares published DOs
 * The optional second type argument `Deps` mirrors
 * `Cloudflare.Worker<Self, Bindings, Deps>` — it declares the DOs
 * this Worker publishes for cross-script binding. With `Counter`
 * named in `Deps`, any other Worker can write
 * `Counter.from(TaskWorker)` and have it type-check.
 * ```typescript
 * import { Counter } from "./counter.ts";
 *
 * export class TaskWorker extends Cloudflare.RpcWorker<TaskWorker, Counter>()(
 *   "TaskWorker",
 *   { main: import.meta.url, schema: TaskRpcs },
 * ) {}
 * ```
 * See {@link RpcDurableObject} for the consumer side
 * (`Counter.from(TaskWorker)`).
 *
 * @section Binding it from another worker
 * @example `Cloudflare.RpcWorker.bind(WorkerClass)`
 * Inside another worker's init, `RpcWorker.bind(WorkerClass)`
 * registers the service binding on the surrounding worker and returns
 * a typed `RpcClient` you can call directly from any per-request
 * handler. Internally each method invocation builds a fresh underlying
 * client (because Cloudflare rejects cross-request reuse of the
 * stub I/O), but that's hidden behind a Proxy so the consumer sees a
 * normal `RpcClient`.
 * ```typescript
 * import TaskWorker from "./task-worker.ts";
 *
 * export default class Caller extends Cloudflare.RpcWorker<Caller>()(
 *   "Caller",
 *   { main: import.meta.url, schema: CallerRpcs },
 *   Effect.gen(function* () {
 *     // INIT: register binding, get the typed client
 *     const tasks = yield* Cloudflare.RpcWorker.bind(TaskWorker);
 *
 *     const handlers = CallerRpcs.toLayer({
 *       // PER-REQUEST: just call methods directly
 *       proxyGetTask: ({ id }) => tasks.getTask({ id }),
 *     });
 *     return RpcServer.toHttpEffect(CallerRpcs).pipe(
 *       Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
 *     );
 *   }),
 * ) {}
 * ```
 *
 * @section Driving it from a test
 * @example `Test.make` + `RpcClient.make`
 * The same `RpcGroup` drives a typed client. `Test.make` deploys the
 * stack once for the file; each test yields the deploy handle for its
 * URL and calls procedures directly.
 * ```typescript
 * import { expect } from "alchemy-test";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Test from "alchemy/Test/Alchemy";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import * as Schedule from "effect/Schedule";
 * import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
 * import * as RpcClient from "effect/unstable/rpc/RpcClient";
 * import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
 * import Stack from "../alchemy.run.ts";
 * import { TaskRpcs } from "../src/rpcs.ts";
 *
 * const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
 *   providers: Cloudflare.providers(),
 * });
 * const stack = beforeAll(deploy(Stack));
 * afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));
 *
 * const layer = (url: string) =>
 *   RpcClient.layerProtocolHttp({ url }).pipe(
 *     Layer.provide(FetchHttpClient.layer),
 *     Layer.provide(
 *       Layer.succeed(RpcSerialization.RpcSerialization, RpcSerialization.json),
 *     ),
 *   );
 *
 * test(
 *   "getTask",
 *   Effect.gen(function* () {
 *     const { url } = yield* stack;
 *     yield* Effect.gen(function* () {
 *       const client = yield* RpcClient.make(TaskRpcs);
 *       const result = yield* client
 *         .getTask({ id: "abc" })
 *         .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 5 }));
 *       expect(result).toBe("task-abc");
 *     }).pipe(Effect.scoped, Effect.provide(layer(url)));
 *   }),
 * );
 * ```
 *
 * @section Yielding the surrounding worker from inside the impl
 * @example `yield* RpcWorker` inside the init effect
 * Mirrors `yield* DurableObject` — yield the tag to access
 * the surrounding worker.
 * ```typescript
 * Effect.gen(function* () {
 *   const self = yield* Cloudflare.RpcWorker;
 * });
 * ```
 */
export const RpcWorker: RpcWorkerClass = (() => {
  const fn = (...args: any[]) => {
    // Class-form: zero args returns the inner builder. Inner-arg arity
    // distinguishes modular (`(id, props)`, no impl — `static make(impl)`
    // provides the runtime) from inline-impl (`(id, props, impl)`).
    if (args.length === 0) {
      return (...inner: any[]) => {
        if (inner.length === 2) {
          const [id, props] = inner as [string, RpcWorkerProps<any>];
          return buildModular(id, props);
        }
        const [id, props, impl] = inner as [
          string,
          RpcWorkerProps<any>,
          Effect.Effect<Effect.Effect<HttpEffect<any>>>,
        ];
        return build(id, props, impl);
      };
    }
    // Bare form: `(name, props, impl)`.
    const [id, props, impl] = args as [
      string,
      RpcWorkerProps<any>,
      Effect.Effect<Effect.Effect<HttpEffect<any>>>,
    ];
    return build(id, props, impl);
  };

  const tagged = taggedFunction(RpcWorkerScope, fn as any) as any;
  tagged.bind = bind;
  return tagged;
})() as any;

const wrapImpl = (impl: Effect.Effect<Effect.Effect<HttpEffect<any>>>) =>
  // The user's inner Effect resolves to `HttpEffect`; the underlying
  // `Cloudflare.Worker` expects `{ fetch: HttpEffect }`. Box it.
  Effect.map(
    impl,
    (fetch) => ({ fetch }) as unknown as { fetch: HttpEffect<any> },
  );

const buildModular = (id: string, props: RpcWorkerProps<any>) => {
  const { schema } = props;
  // Delegate to `Cloudflare.Worker<Self>()(id, props)` (modular form)
  // so we inherit its `static make(impl)` plumbing for free. We just
  // wrap the user's HttpEffect-returning impl into the `{ fetch }`
  // shape `Cloudflare.Worker` expects, and stash the rpc schema on
  // the class so `RpcWorker.bind(WorkerClass)` can recover it.
  const Underlying: any = (WorkerCtor as any)()(id);
  // `Underlying` is itself an Effect (the no-impl Worker class), so hand it
  // straight to `effectClass` rather than reaching for a removed `.asEffect()`.
  const klass = class extends effectClass(Underlying as Effect.Effect<Worker>) {
    static make = (
      props: InputProps<WorkerProps>,
      impl: Effect.Effect<Effect.Effect<HttpEffect<any>>>,
    ): Layer.Layer<any, never, any> => Underlying.make(props, wrapImpl(impl));
  } as unknown as Record<symbol | string, unknown>;
  klass[SchemaSymbol] = schema;
  return klass;
};

const build = (
  id: string,
  props: RpcWorkerProps<any>,
  impl: Effect.Effect<Effect.Effect<HttpEffect<any>>>,
) => {
  const { schema, ...workerProps } = props;

  // Wrap the user's HttpEffect-returning Effect into the `{ fetch }`
  // shape `Cloudflare.Worker` expects.
  const wrappedImpl = Effect.map(
    impl,
    (fetch) => ({ fetch }) as unknown as { fetch: HttpEffect<any> },
  );

  // Delegate registration / binding metadata to the underlying
  // `Cloudflare.Worker`. The returned `effectClass`, when yielded,
  // produces the standard `Worker` resource (so `worker.url`,
  // `worker.workerName`, etc. all work as usual).
  const underlying = (WorkerCtor as any)()(id, workerProps, wrappedImpl);

  // Re-wrap as our own `effectClass` so we can stash the rpc schema
  // on the class for `RpcWorker.bind` to recover later. (Re-using
  // `effectClass` here means `class X extends RpcWorker<X>()(...)`
  // still works.) `underlying` is already an Effect, so pass it directly.
  const klass = effectClass(
    underlying as Effect.Effect<Worker>,
  ) as unknown as Record<symbol, unknown>;
  klass[SchemaSymbol] = schema;
  return klass;
};
