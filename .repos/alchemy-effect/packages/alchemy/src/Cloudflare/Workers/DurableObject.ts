import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Dependencies } from "../../Dependencies.ts";
import type { HttpEffect } from "../../Http.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { ALCHEMY_PHASE } from "../../Phase.ts";
import type { MainRpc, PlatformServices } from "../../Platform.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import { asEffect } from "../../Util/types.ts";
import type { Container } from "../Containers/Container.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { makeRpcStub } from "./Rpc.ts";
import { type WebSocket } from "./WebSocket.ts";
import {
  isWorker,
  Worker,
  WorkerEnvironment,
  type WorkerServices,
} from "./Worker.ts";

export interface DurableObjectExport {
  readonly kind: "durableObject";
  readonly constructor: Effect.Effect<
    Effect.Effect<DurableObjectShape, never, RuntimeContext>,
    never,
    DurableObjectState
  >;
  readonly services: Context.Context<never>;
}

export const isDurableObjectExport = (
  value: unknown,
): value is DurableObjectExport =>
  typeof value === "object" && (value as any)?.kind === "durableObject";

export type DurableObjectId = cf.DurableObjectId;
export type DurableObjectJurisdiction = cf.DurableObjectJurisdiction;
export type DurableObjectGetDurableObjectOptions =
  cf.DurableObjectNamespaceGetDurableObjectOptions;
/**
 * The regions a Durable Object can be *hinted* toward at creation —
 * `"wnam"`, `"enam"`, `"sam"`, `"weur"`, `"eeur"`, `"apac"`, `"oc"`, … See
 * the "Placing a Durable Object in a Region" section on {@link DurableObject}.
 */
export type DurableObjectLocationHint = cf.DurableObjectLocationHint;

export type AlarmInvocationInfo = cf.AlarmInvocationInfo;

type TypeId = "Cloudflare.DurableObject";
const TypeId = "Cloudflare.DurableObject";

export const isDurableObjectLike = (
  value: unknown,
): value is DurableObjectLike =>
  typeof value === "object" && (value as any)?.kind === TypeId;

export interface DurableObjectLike<Shape = any> {
  kind: TypeId;
  name: string;
  /** @internal phantom */
  className?: string;
  /** @internal phantom */
  scriptName?: Input<string>;
  /** @internal phantom */
  transferredFrom?: DurableObjectTransferSource | DurableObjectTransferSource[];
  /** @internal phantom */
  Shape?: Shape;
}

export interface DurableObject<
  Shape = unknown,
> extends DurableObjectLike<Shape> {
  Type: TypeId;
  name: string;
  namespaceId: Output.Output<string>;
  getByName: (
    name: string,
    options?: DurableObjectGetDurableObjectOptions,
  ) => DurableObjectStub<Shape>;
  newUniqueId: () => DurableObjectId;
  idFromName: (name: string) => DurableObjectId;
  idFromString: (id: string) => DurableObjectId;
  get: (
    id: DurableObjectId,
    options?: DurableObjectGetDurableObjectOptions,
  ) => DurableObjectStub<Shape>;
  jurisdiction: (
    jurisdiction: DurableObjectJurisdiction,
  ) => DurableObject<Shape>;
}

export interface DurableObjectShape {
  fetch?: HttpEffect<DurableObjectState | RuntimeContext>;
  alarm?: (
    alarmInfo?: AlarmInvocationInfo,
  ) => Effect.Effect<void, never, never>;
  webSocketMessage?: (
    socket: WebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void>;
  webSocketClose?: (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void>;
}

export type DurableObjectServices =
  | DurableObject
  | DurableObjectState
  | WorkerServices
  | WorkerEnvironment
  | PlatformServices;

/**
 * A reference to the Worker that previously hosted a Durable Object class,
 * accepted by {@link DurableObjectProps.transferredFrom}:
 *
 * - the Worker's **logical id** (same stack + stage) or **physical script
 *   name** (cross-stack) as a string
 * - the Worker **resource** (`const b = yield* Cloudflare.Worker(...)`)
 * - the Worker **class** (`transferredFrom: WorkerA`)
 * - a **thunk** of any of the above (`() => WorkerA`) — use this for
 *   forward references and import cycles; it is evaluated lazily at plan
 *   time, after all modules have loaded
 * - a string `Output` (e.g. a cross-stack `stackRef`'s worker name)
 *
 * Every form is normalized at plan time to a plain identifier: a Worker
 * reference contributes its logical id, and a same-stack `workerName`
 * Output contributes its source resource's logical id rather than the
 * Output itself. Keeping the former host's *value* out of the binding data
 * matters — consuming its Output would add a dependency edge from the new
 * host onto the former host, inverting the deploy order the transfer
 * requires (the new host must upload first).
 */
export type DurableObjectTransferSource =
  | Input<string>
  | Worker
  | Effect.Effect<Worker, any, any>
  | (() => DurableObjectTransferSource);

const resolveTransferSourceRef = (
  source: DurableObjectTransferSource,
  depth = 0,
): Input<string> => {
  if (typeof source === "string") {
    return source;
  }
  // A Worker resource — contribute its logical id.
  if (isWorker(source)) {
    return source.LogicalId;
  }
  // A Worker platform class — carries its logical id statically. (On an
  // Output proxy this property access yields another Output, never a
  // string, so the check cannot misfire there.)
  const logicalId = (source as { LogicalId?: unknown }).LogicalId;
  if (typeof logicalId === "string") {
    return logicalId;
  }
  // A same-stack Output on a Worker (e.g. `b.workerName`): take the
  // identity from its provenance, not the value.
  if (Output.isPropExpr(source)) {
    const expr = (source as Output.PropExpr<any, any>).expr;
    if (Output.isResourceExpr(expr) && isWorker(expr.src)) {
      return expr.src.LogicalId;
    }
  }
  if (Output.isResourceExpr(source) && isWorker(source.src)) {
    return source.src.LogicalId;
  }
  if (Output.isOutput(source)) {
    // No local resource to take identity from (e.g. a cross-stack
    // `stackRef`) — the engine resolves the string at deploy time.
    return source as Input<string>;
  }
  if (typeof source === "function" && depth < 8) {
    return resolveTransferSourceRef(
      (source as () => DurableObjectTransferSource)(),
      depth + 1,
    );
  }
  throw new Error(
    "Invalid transferredFrom entry: pass the former host's logical id or script name, its Worker class or resource, a thunk of one of those, or a string Output.",
  );
};

/**
 * Normalize a `transferredFrom` declaration to plain host identifiers at
 * plan time. See {@link DurableObjectTransferSource} for the accepted forms
 * and why Worker references reduce to logical ids instead of Outputs.
 *
 * @internal
 */
export const normalizeTransferredFrom = (
  value:
    | DurableObjectTransferSource
    | readonly DurableObjectTransferSource[]
    | undefined,
): Input<string>[] | undefined =>
  value === undefined
    ? undefined
    : (Array.isArray(value)
        ? (value as readonly DurableObjectTransferSource[])
        : [value as DurableObjectTransferSource]
      ).map((source) => resolveTransferSourceRef(source));

export interface DurableObjectProps {
  /**
   * Name of the exported `DurableObject` class.
   *
   * @default name
   */
  className?: string;
  /**
   * Worker script that hosts the Durable Object class. Omit this when the
   * namespace is hosted by the Worker that declares the binding.
   */
  scriptName?: Input<string> | undefined;
  /**
   * The Worker(s) that previously hosted this Durable Object class. When one
   * of them still holds the namespace, the deploy performs Cloudflare's
   * data-preserving `transferred_classes` migration, moving the namespace —
   * including all stored objects — from that script to this Worker.
   *
   * Each entry names a former host — see
   * {@link DurableObjectTransferSource} for the accepted forms: a string
   * (Worker logical id in this stack + stage, or physical script name for
   * cross-stack moves), the Worker class or resource itself, or a thunk
   * (`() => WorkerA`) for forward references. Moving a class is always
   * declared this way — there is no inference. A list is a host *history*:
   * as the class moves again, append the previous host so stages that lag
   * behind (or skipped an intermediate release) still transfer from
   * wherever their namespace currently lives.
   *
   * When no listed host holds the namespace — a fresh stage, or every
   * transfer already completed — the property is inert and the class is
   * created fresh (or left as-is), so it is safe to leave in place
   * indefinitely.
   */
  transferredFrom?:
    | DurableObjectTransferSource
    | DurableObjectTransferSource[]
    | undefined;
  // environment?: string | undefined;
  // sqlite?: boolean | undefined;
  // namespaceId?: string | undefined;
}

export interface DurableObjectClass extends Effect.Effect<
  DurableObject,
  never,
  DurableObject
> {
  <Self, Shape>(): {
    <Name extends string>(
      name: Name,
      props?: Pick<DurableObjectProps, "transferredFrom">,
    ): Effect.Effect<DurableObject<Self>, never, Worker | Self> & {
      new (_: never): Shape & {
        /** @internal */
        "~alchemy/name": Name;
      };
      from(
        scriptName: Input<string>,
      ): Effect.Effect<DurableObject<Self>, never, Worker>;
      from<Req = never>(
        worker:
          | Dependencies<Self>
          | Effect.Effect<Dependencies<Self>, never, Req>,
      ): Effect.Effect<DurableObject<Self>, never, Worker | Req>;
      make<Req = never>(
        impl: Effect.Effect<
          Effect.Effect<
            Shape,
            never,
            RuntimeContext | DurableObjectState | Scope
          >,
          never,
          DurableObjectServices | Req
        >,
      ): Layer.Layer<Self, never, Worker | Req>;
    };
  };
  <Self>(): {
    <
      Shape extends MainRpc<DurableObjectState>,
      Req extends DurableObjectServices | Container.Application<any> = never,
    >(
      name: string,
      impl: Effect.Effect<
        Effect.Effect<
          Shape,
          never,
          RuntimeContext | DurableObjectState | Scope
        >,
        never,
        Req
      >,
    ): Effect.Effect<
      DurableObject<Self>,
      never,
      Worker | Extract<Req, Container.Application<any>>
    > & {
      new (_: never): Shape;
    };
  };
  <Shape>(name: string, props?: DurableObjectProps): DurableObjectLike<Shape>;
  <Shape, InitReq = never>(
    name: string,
    impl: Effect.Effect<Shape, never, DurableObjectServices | InitReq>,
  ): Effect.Effect<
    DurableObject<Shape>,
    never,
    Worker | Exclude<InitReq, DurableObjectServices>
  >;
}

export class DurableObjectScope extends Context.Service<
  DurableObjectScope,
  DurableObject
>()("Cloudflare.DurableObject") {}

/**
 * A Cloudflare Durable Object namespace that manages globally unique, stateful
 * instances with WebSocket hibernation support.
 *
 * A Durable Object uses a two-phase pattern with two nested `Effect.gen`
 * blocks. The outer Effect resolves shared dependencies (other DOs,
 * containers, etc.) and the instance state *reference*
 * (`Cloudflare.DurableObjectState`). The inner Effect returns the
 * object's public methods and WebSocket handlers — and is the only
 * place the state's `RuntimeContext`-colored methods (`storage.get`,
 * `storage.put`, …) can actually run.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   // Phase 1: resolve shared dependencies + the instance state ref
 *   const db = yield* Cloudflare.D1.QueryDatabase(MyDatabase);
 *   const state = yield* Cloudflare.DurableObjectState;
 *
 *   return Effect.gen(function* () {
 *     // Phase 2: per-instance setup and public API. `state`'s methods
 *     // (storage.get/put, …) are RuntimeContext-colored, so the actual
 *     // I/O happens here, in the runtime closure.
 *     return {
 *       save: (data: string) => db.exec("INSERT ..."),
 *       fetch: Effect.gen(function* () { ... }),
 *       webSocketMessage: Effect.fn(function* (ws, msg) { ... }),
 *     };
 *   });
 * })
 * ```
 *
 * There are two ways to define a Durable Object. See the
 * [Functions & Servers](/infrastructure-as-effects/functions-and-servers) page
 * for the full explanation.
 *
 * - **Inline** — Effect implementation passed directly, single file.
 * - **Modular** — class and implementation in separate files for tree-shaking.
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 *
 * @section Inline Durable Objects
 * Pass the Effect implementation as the second argument. This is the
 * simplest approach — everything lives in one file. Convenient when
 * the DO doesn't need to be referenced by other Workers or DOs that
 * would pull in its runtime dependencies.
 *
 * @example Inline Durable Object
 * ```typescript
 * export default class Counter extends Cloudflare.DurableObject<Counter>()(
 *   "Counter",
 *   Effect.gen(function* () {
 *     // init: bind resources + resolve the instance state ref
 *     const db = yield* Cloudflare.D1.QueryDatabase(MyDatabase);
 *     const state = yield* Cloudflare.DurableObjectState;
 *
 *     return Effect.gen(function* () {
 *       // runtime: state's storage methods are RuntimeContext-colored,
 *       // so the reads/writes live here
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *
 *       return {
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const next = count + 1;
 *             yield* state.storage.put("count", next);
 *             return next;
 *           }),
 *         get: () => Effect.succeed(count),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @section Modular Durable Objects
 * When a Worker and a DO reference each other, or multiple Workers
 * bind the same DO, define the class separately from its `.make()`
 * call. The class is a lightweight identifier; `.make()` provides
 * the runtime implementation as an `export default`. Rolldown treats
 * `.make()` as pure, so the bundler tree-shakes it and all its
 * runtime dependencies out of any consumer's bundle.
 *
 * The class and `.make()` can live in the same file. This is the
 * same pattern used by `Worker` and `Container`.
 *
 * @example Modular Durable Object (class + .make() in one file)
 * ```typescript
 * // src/Counter.ts
 * export class Counter extends Cloudflare.DurableObject<Counter>()(
 *   "Counter",
 * ) {}
 *
 * export default Counter.make(
 *   Effect.gen(function* () {
 *     // init: bind resources + resolve the instance state ref
 *     const db = yield* Cloudflare.D1.QueryDatabase(MyDatabase);
 *     const state = yield* Cloudflare.DurableObjectState;
 *
 *     return Effect.gen(function* () {
 *       // runtime: state's storage methods are RuntimeContext-colored,
 *       // so the reads/writes live here
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *
 *       return {
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const next = count + 1;
 *             yield* state.storage.put("count", next);
 *             yield* db.prepare("INSERT INTO logs (count) VALUES (?)").bind(next).run();
 *             return next;
 *           }),
 *         get: () => Effect.succeed(count),
 *       };
 *     });
 *   }),
 * );
 * ```
 *
 * @example Binding a modular DO from a Worker
 * ```typescript
 * // imports Counter; bundler tree-shakes .make()
 * import Counter from "./Counter.ts";
 *
 * // init
 * const counters = yield* Counter;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const counter = counters.getByName("user-123");
 *     return HttpServerResponse.text(String(yield* counter.get()));
 *   }),
 * };
 * ```
 *
 * @section Cross-Worker Binding
 * A Durable Object is _hosted_ by exactly one Worker, but any
 * number of other Workers can bind to the same DO. This is how
 * you share state across Workers: one Worker hosts the DO, every
 * other Worker addresses it by `scriptName` and gets a typed stub.
 *
 * To make this type-safe, the **host Worker** must declare the DO
 * as part of its public contract via the third type argument to
 * `Cloudflare.Worker<Self, Bindings, Deps>()`. `Deps` is the set
 * of DO classes (or other Workers) the script exposes for other
 * scripts to bind to.
 *
 * @example Host Worker declares the DO in its contract
 * ```typescript
 * // workerA.ts — hosts Counter
 * import { Counter, CounterLive } from "./object.ts";
 *
 * //                                       ^^^^^^^ declared as part of WorkerA's public contract
 * export class WorkerA extends Cloudflare.Worker<WorkerA, {}, Counter>()(
 *   "WorkerA",
 *   { main: import.meta.url },
 * ) {}
 *
 * // WorkerA's Layer also provides the DO's Live implementation.
 * export default WorkerA.make(
 *   Effect.gen(function* () {
 *     const counter = yield* Counter;
 *     return { fetch: Effect.gen(function* () { ... }) };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 *
 * @example Consumer Worker binds the DO via `Counter.from(WorkerA)`
 * ```typescript
 * // workerB.ts — binds to the same Counter, hosted by WorkerA
 * import { Counter } from "./object.ts";
 * import { WorkerA } from "./workerA.ts";
 *
 * export default class WorkerB extends Cloudflare.Worker<WorkerB>()(
 *   "WorkerB",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     //              ^^^^^^^^^^^^ scriptName-bound stub of WorkerA's Counter
 *     const counter = yield* Counter.from(WorkerA);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = yield* counter.getByName("shared").get();
 *         return HttpServerResponse.text(String(value));
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * :::tip
 * The `, Counter` in `Worker<WorkerA, {}, Counter>` is what makes
 * `Counter.from(WorkerA)` type-check. You can still bind across
 * scripts without it (the runtime works either way), but consumers
 * will get a TypeScript error because `WorkerA` doesn't declare
 * `Counter` as part of its public contract.
 * :::
 *
 * Only the host Worker's Stack provides `CounterLive` — the
 * consumer Worker just imports the `Counter` class as a typed
 * identifier. Rolldown tree-shakes `CounterLive` (and its
 * dependencies) out of WorkerB's bundle.
 *
 * @section Using `.from(Self)` Inside the Host
 * Inside the host Worker, `yield* Counter` and
 * `yield* Counter.from(Self)` resolve to the same local namespace.
 * The `.from(Self)` form is preferred — especially in code that
 * may be extracted into a reusable Layer — because it makes the
 * scriptName explicit and lets the same Layer shape work whether
 * the consumer is the host or another script.
 *
 * @example `Counter.from(WorkerA)` inside WorkerA itself
 * ```typescript
 * // workerA.ts — host uses `.from(Self)` instead of bare `yield* Counter`
 * export default WorkerA.make(
 *   Effect.gen(function* () {
 *     const counter = yield* Counter.from(WorkerA); // same as `yield* Counter`
 *     return { fetch: Effect.gen(function* () { ... }) };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 *
 * A Worker can also host its **own isolated** namespace this way.
 * If a second host Worker declares `Counter` in its contract and
 * provides `CounterLive`, the DO instances under that script are
 * separate from the original host's — same class, two namespaces.
 *
 * @example Two hosts, two isolated namespaces
 * ```typescript
 * // workerC.ts — another host of Counter, isolated from WorkerA
 * export class WorkerC extends Cloudflare.Worker<WorkerC, {}, Counter>()(
 *   "WorkerC",
 *   { main: import.meta.url },
 * ) {}
 *
 * export default WorkerC.make(
 *   Effect.gen(function* () {
 *     // .from(WorkerC) binds to WorkerC's own Counter namespace —
 *     // writes here are NOT visible from WorkerA's Counter.
 *     const counter = yield* Counter.from(WorkerC);
 *     return { fetch: Effect.gen(function* () { ... }) };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 *
 * @section RPC Methods
 * Any function you return from the inner Effect becomes an RPC method
 * that Workers can call through a stub. Methods must return an `Effect`.
 * The caller gets a fully typed stub — if your DO returns `increment`
 * and `get`, the stub exposes `counter.increment()` and `counter.get()`.
 *
 * @example Defining RPC methods
 * ```typescript
 * return {
 *   increment: () => Effect.succeed(++count),
 *   get: () => Effect.succeed(count),
 *   reset: () => Effect.sync(() => { count = 0; }),
 * };
 * ```
 *
 * @section Returning Streams from RPC
 * RPC methods can return an Effect `Stream` and the caller will see
 * the chunks as they're produced. Combine with `Stream.schedule` to
 * pace emission, or with `Stream.fromQueue` to bridge an inbound
 * subscription.
 *
 * @example Streaming sequential numbers
 * ```typescript
 * import * as Schedule from "effect/Schedule";
 * import * as Stream from "effect/Stream";
 *
 * return {
 *   tick: (n: number) =>
 *     Stream.iterate(0, (i) => i + 1).pipe(
 *       Stream.take(n),
 *       Stream.schedule(Schedule.spaced("100 millis")),
 *     ),
 * };
 * ```
 *
 * @example Forwarding the stream as a chunked HTTP response
 * ```typescript
 * // in a Worker fetch handler
 * const counter = counters.getByName("tick");
 * const stream = counter.tick(5).pipe(
 *   Stream.map((i) => `${i}\n`),
 *   Stream.encodeText,
 * );
 * return HttpServerResponse.stream(stream, {
 *   headers: { "content-type": "text/plain" },
 * });
 * ```
 *
 * @section Worker → DO HTTP forwarding
 * In addition to RPC methods, the typed stub exposes a `fetch`
 * method that forwards an `HttpServerRequest` straight to the DO.
 * The DO's own `fetch` Effect produces the response — useful for
 * WebSocket upgrades and other request-shaped interactions.
 *
 * @example Forwarding an HTTP request to a DO
 * ```typescript
 * const room = rooms.getByName(roomId);
 * return yield* room.fetch(request);
 * ```
 *
 * @section Placing a Durable Object in a Region
 * A Durable Object is created wherever its *first-ever* request
 * came from, and it stays there for life. That default is right for
 * an instance whose traffic all comes from the user who created it,
 * and wrong for one whose name is derived from something other than
 * geography (a shard index, a hash, a fixed roster) — a Sydney user
 * routed onto an instance that some Frankfurt request happened to
 * create first pays a cross-planet round trip on every call.
 *
 * Pass a `locationHint` to place the instance near the traffic you
 * expect instead. It only applies to *creation*: an instance that
 * already exists is unaffected, so a hint can't move a live DO.
 *
 * @example Sharding instances by region
 * ```typescript
 * // Both the name and the hint derive from the caller's region, so
 * // each shard is created in the region whose users address it.
 * const region = hintFor(request.cf?.continent); // "apac", "weur", …
 * const shard = shards.getByName(`pool:${region}:${index}`, {
 *   locationHint: region,
 * });
 * ```
 *
 * :::caution
 * A hint is a hint: Cloudflare places the instance in the nearest
 * location it *can*, which may not be the hinted one, and only the
 * first request to a given name has any say. Derive the name from
 * the same region you hint with — otherwise two regions race to
 * create one shared instance and the loser is stuck with it.
 * :::
 *
 * @section Accessing Instance State
 * Each Durable Object instance has its own transactional key-value
 * storage via `Cloudflare.DurableObjectState`. Resolve the `state`
 * *reference* in the outer (init) Effect, but call its methods —
 * `storage.get`, `storage.put`, … — only from the inner (runtime)
 * Effect: those methods are `RuntimeContext`-colored, so the type
 * system only allows them inside the runtime closure.
 *
 * @example Reading and writing durable storage
 * ```typescript
 * // inner (runtime) Effect — `state` was resolved in the outer Effect
 * yield* state.storage.put("counter", 42);
 * const value = yield* state.storage.get("counter");
 * ```
 *
 * @section Background Work & Scopes
 * Every RPC call and fetch into a Durable Object gets its own Effect
 * `Scope`. When the method finishes, the bridge closes that scope and
 * registers the close promise with workerd's `state.waitUntil` — so
 * finalizers added with `Effect.addFinalizer` inside a method run *after*
 * the result is returned to the caller, without blocking it, and the
 * object stays alive until they settle.
 *
 * For ad-hoc background work, `state.waitUntil(effect)` forks an Effect
 * with the caller's full context and keeps the object alive until it
 * settles.
 *
 * Attach cleanup to method scopes, not the constructor (init) closure —
 * the constructor runs once per in-memory instance under
 * `blockConcurrencyWhile`, and its scope is not tied to any call.
 *
 * @example Responding before finishing the work
 * ```typescript
 * return {
 *   record: Effect.fn(function* (entry: string) {
 *     // runs after `record` returns; the DO stays alive until it settles
 *     yield* Effect.addFinalizer(() =>
 *       state.storage.put(`audit:${entry}`, Date.now()).pipe(Effect.ignore),
 *     );
 *     return "accepted" as const;
 *   }),
 *
 *   refresh: Effect.fn(function* () {
 *     // same idea, explicit form
 *     yield* state.waitUntil(recomputeExpensiveView());
 *     return "scheduled" as const;
 *   }),
 * };
 * ```
 *
 * @section WebSocket Hibernation
 * Durable Objects support WebSocket hibernation — the runtime can
 * evict the object from memory while keeping connections open. Use
 * `Cloudflare.upgrade()` to accept a connection, and return
 * `webSocketMessage` / `webSocketClose` handlers to process events
 * when the object wakes back up.
 *
 * @example Accepting a WebSocket connection
 * ```typescript
 * return {
 *   fetch: Effect.gen(function* () {
 *     const [response, socket] = yield* Cloudflare.upgrade();
 *     socket.serializeAttachment({ id: crypto.randomUUID() });
 *     return response;
 *   }),
 * };
 * ```
 *
 * @example Handling messages and close events
 * ```typescript
 * return {
 *   webSocketMessage: Effect.fn(function* (
 *     socket: Cloudflare.WebSocket,
 *     message: string | Uint8Array,
 *   ) {
 *     const text = typeof message === "string"
 *       ? message
 *       : new TextDecoder().decode(message);
 *     // process the message
 *   }),
 *   webSocketClose: Effect.fn(function* (
 *     ws: Cloudflare.WebSocket,
 *     code: number,
 *     reason: string,
 *   ) {
 *     yield* ws.close(code, reason);
 *   }),
 * };
 * ```
 *
 * @example Recovering sessions after hibernation
 * Resolve the `state` reference in the outer Effect, but place the
 * rehydration loop (`state.getWebSockets()` is `RuntimeContext`-colored)
 * **inside the inner `Effect.gen`** so it runs every time the DO
 * instance is reconstructed (including after Cloudflare wakes the DO
 * from hibernation).
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const state = yield* Cloudflare.DurableObjectState;
 *
 *   return Effect.gen(function* () {
 *     const sessions = new Map<string, Cloudflare.WebSocket>();
 *
 *     // Rehydrate the in-memory session map after hibernation.
 *     for (const socket of yield* state.getWebSockets()) {
 *       const data = socket.deserializeAttachment<{ id: string }>();
 *       if (data) sessions.set(data.id, socket);
 *     }
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const [response, socket] = yield* Cloudflare.upgrade();
 *         const id = crypto.randomUUID();
 *         socket.serializeAttachment({ id });
 *         sessions.set(id, socket);
 *         return response;
 *       }),
 *       webSocketMessage: Effect.fn(function* (socket, message) {
 *         const text =
 *           typeof message === "string" ? message : new TextDecoder().decode(message);
 *         for (const peer of sessions.values()) {
 *           yield* peer.send(text);
 *         }
 *       }),
 *     };
 *   });
 * });
 * ```
 *
 * @section Scheduled Alarms
 * Each Durable Object can have a single alarm timestamp. Alchemy
 * layers a small SQLite-backed scheduler on top via
 * `Cloudflare.Workers.scheduleEvent` and `Cloudflare.Workers.processScheduledEvents`,
 * so you can register many named events with arbitrary payloads and
 * fire them from a single `alarm` handler.
 *
 * @example Scheduling and processing events
 * ```typescript
 * // schedule from a request or message handler
 * yield* Cloudflare.Workers.scheduleEvent(
 *   "reminder-1",
 *   new Date(Date.now() + 60_000),
 *   { message: "your meeting starts in a minute" },
 * );
 *
 * return {
 *   alarm: () =>
 *     Effect.gen(function* () {
 *       const fired = yield* Cloudflare.Workers.processScheduledEvents;
 *       for (const event of fired) {
 *         const payload = event.payload as { message: string };
 *         // dispatch / broadcast / persist...
 *       }
 *     }),
 * };
 * ```
 *
 * @section Using from a Worker
 * Yield the DO class in your Worker's init phase to get a namespace
 * handle. Call `getByName` or `getById` to get a typed stub, then
 * call any RPC method or forward an HTTP request with `fetch`.
 *
 * @example Calling RPC methods
 * ```typescript
 * // init
 * const counters = yield* Counter;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const counter = counters.getByName("user-123");
 *     yield* counter.increment();
 *     const value = yield* counter.get();
 *     return HttpServerResponse.text(String(value));
 *   }),
 * };
 * ```
 *
 * @example Forwarding an HTTP request
 * ```typescript
 * // init
 * const rooms = yield* Room;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *     const room = rooms.getByName(roomId);
 *     return yield* room.fetch(request);
 *   }),
 * };
 * ```
 *
 * @section Binding in an Async Worker
 * When using an Async Worker (plain `async fetch` handler, no Effect
 * runtime), declare Durable Objects in the `bindings` prop of the
 * Worker resource. Pass a `DurableObject` reference with a
 * `className` matching the exported `DurableObject` subclass in your
 * worker source file. If `className` is omitted, it defaults to the
 * namespace name. Use `Cloudflare.InferEnv` to get a fully typed
 * `env` object that includes the namespace.
 *
 * @example Declaring a DO binding in the stack
 * ```typescript
 * // alchemy.run.ts
 * import type { Counter } from "./src/worker.ts";
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   bindings: {
 *     Counter: Cloudflare.DurableObject<Counter>("Counter"),
 *   },
 * });
 * ```
 *
 * @example Using the DO from a plain async handler
 * ```typescript
 * // src/worker.ts
 * import { DurableObject } from "cloudflare:workers";
 * import type { WorkerEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv) {
 *     const counter = env.Counter.getByName("my-counter");
 *     const count = await counter.increment();
 *     return new Response(JSON.stringify({ count }));
 *   },
 * };
 *
 * export class Counter extends DurableObject {
 *   private counter = 0;
 *   async increment() {
 *     return ++this.counter;
 *   }
 * }
 * ```
 *
 * @section Cross-Script Binding in an Async Worker
 * Async Workers can also bind to a Durable Object hosted by another
 * Worker script. The host Worker declares and exports the DO class. The
 * consumer Worker declares a `DurableObject` with `scriptName`
 * set to the host Worker's script name.
 *
 * Cross-script async bindings are references only: the consumer uploads
 * the binding metadata, but Alchemy does not drive class migrations for
 * the foreign class. Deploy the host first so Cloudflare can verify that
 * the target script exports the requested class.
 *
 * @example Host Worker owns the Durable Object class
 * ```typescript
 * const host = yield* Cloudflare.Worker("Host", {
 *   main: "./src/host.ts",
 *   bindings: {
 *     Counter: Cloudflare.DurableObject<Counter>("Counter"),
 *   },
 * });
 * ```
 *
 * @example Consumer Worker binds to the host script
 * ```typescript
 * const consumer = yield* Cloudflare.Worker("Consumer", {
 *   main: "./src/consumer.ts",
 *   bindings: {
 *     Counter: Cloudflare.DurableObject<Counter>("Counter", {
 *       scriptName: host.workerName,
 *     }),
 *   },
 * });
 * ```
 *
 * @example Binding to a different exported class name
 * ```typescript
 * const consumer = yield* Cloudflare.Worker("Consumer", {
 *   main: "./src/consumer.ts",
 *   bindings: {
 *     Counter: Cloudflare.DurableObject<Counter>("Counter", {
 *       className: "CounterV2",
 *       scriptName: host.workerName,
 *     }),
 *   },
 * });
 * ```
 *
 * @section Moving a Class Between Workers
 * A Durable Object class can move from one Worker to another with its
 * data intact. The move is always **declared** — a class that disappears
 * from one worker and appears on another is otherwise ambiguous between
 * "transfer the data" and "delete it, start fresh", so Alchemy never
 * guesses (removing a DO deletes it; that is the default). Declare
 * `transferredFrom` on the Durable Object at its **new host**, naming the
 * former host, and the new host's deploy ships Cloudflare's
 * data-preserving `transferred_classes` migration. The former host's
 * deploy converges on its own — no delete migration is emitted for a
 * class that moved away.
 *
 * Each `transferredFrom` entry is either the former host's Worker
 * **logical id** (same stack + stage, resolved via alchemy's ownership
 * tags) or its **physical script name** (required for cross-stack moves).
 * When no listed host holds the namespace — a fresh stage, or the
 * transfer already completed — the declaration is inert, so it is safe to
 * leave in place indefinitely.
 *
 * @example Move a class from WorkerB to WorkerA
 * ```typescript
 * // BEFORE: worker-b hosts the class
 * const b = yield* Cloudflare.Worker("WorkerB", {
 *   main: "./src/worker-b.ts", // exports MyDOClass
 *   bindings: {
 *     MyDO: Cloudflare.DurableObject("MyDO", { className: "MyDOClass" }),
 *   },
 * });
 *
 * // AFTER: worker-a hosts it and declares where it came from;
 * // worker-b keeps a cross-script reference.
 * const a = yield* Cloudflare.Worker("WorkerA", {
 *   main: "./src/worker-a.ts", // now exports MyDOClass
 *   bindings: {
 *     MyDO: Cloudflare.DurableObject("MyDO", {
 *       className: "MyDOClass",
 *       transferredFrom: "WorkerB", // logical id (or its script name)
 *     }),
 *   },
 * });
 * const b = yield* Cloudflare.Worker("WorkerB", {
 *   main: "./src/worker-b.ts", // no longer exports MyDOClass
 *   bindings: {
 *     MyDO: Cloudflare.DurableObject("MyDO", {
 *       className: "MyDOClass",
 *       scriptName: a.workerName,
 *     }),
 *   },
 * });
 * ```
 *
 * Forgetting the declaration is safe: when the former host still
 * references the class cross-script, its deploy fails before any upload
 * with `DurableObjectTransferRequired`, telling you exactly what to
 * declare — data is never silently destroyed or forked.
 *
 * @example Chained moves keep the host history
 * ```typescript
 * // The class moved WorkerB → WorkerA last release and WorkerA →
 * // WorkerC this release. Keep the full history so a stage that lagged
 * // behind (or skipped the intermediate release) still transfers from
 * // wherever its namespace currently lives.
 * Cloudflare.DurableObject("MyDO", {
 *   className: "MyDOClass",
 *   transferredFrom: ["WorkerB", "WorkerA"],
 * })
 * ```
 *
 * Two rules for multi-worker migrations:
 *
 * - **Pure moves (the former host drops the DO entirely, keeping no
 *   cross-script reference) must be two deploys**: first add the class to
 *   the new host with `transferredFrom` and deploy; then remove it from
 *   the former host and deploy. In a single deploy nothing orders the
 *   transfer before the former host's delete.
 * - **Cross-stack moves deploy the new host's stack first**, naming the
 *   former host by physical script name; the former host's stack deploys
 *   after and converges.
 *
 * @section Adopting an Existing Durable Object
 * When you adopt a Worker that already exists on Cloudflare — created
 * outside Alchemy via Wrangler, the dashboard, or the raw API — its
 * Durable Object classes are adopted along with it. You opt in to the
 * takeover the same way you adopt any foreign resource: with
 * `adopt(true)` (or the `--adopt` CLI flag), since `Worker.read` reports
 * a worker with no Alchemy ownership tags as `Unowned`.
 *
 * Alchemy normally tracks which class backs each binding through an
 * `alchemy:dos:` metadata tag it writes on the script (mapping each
 * binding's logical id to its class name). A
 * foreign worker has no such tag, so on the **adopting deploy** Alchemy
 * falls back to matching your binding to the live class **by binding
 * name**. The class is then reused in place — not recreated — so
 * Cloudflare's migration engine doesn't reject the upload for creating a
 * class that already exists.
 *
 * The consequence is a one-time constraint: **on the adopting deploy the
 * binding's `className` must match the class that already exists on the
 * worker.** You cannot rename the class in the same deploy that adopts
 * it. Once the deploy completes, Alchemy owns the worker and has written
 * the `alchemy:dos:` tag, so subsequent renames are driven by logical id
 * and work normally.
 *
 * @example Adopting a worker whose `Counter` class already exists
 * ```typescript
 * // The worker + `Counter` class were created outside Alchemy.
 * // `className` must match the existing class on this first deploy.
 * const worker = yield* Cloudflare.Worker("Worker", {
 *   name: "existing-worker",
 *   main: "./src/worker.ts",
 *   bindings: {
 *     Counter: Cloudflare.DurableObject<Counter>("Counter"),
 *   },
 * }).pipe(adopt(true));
 * ```
 *
 * @example Renaming the class — only after adoption
 * ```typescript
 * // A SECOND deploy, after the one above. Alchemy now owns the worker
 * // and maps the binding by logical id, so the class can be renamed.
 * const worker = yield* Cloudflare.Worker("Worker", {
 *   name: "existing-worker",
 *   main: "./src/worker.ts",
 *   bindings: {
 *     Counter: Cloudflare.DurableObject<Counter>("Counter", {
 *       className: "CounterV2",
 *     }),
 *   },
 * });
 * ```
 */
export const DurableObject: DurableObjectClass = taggedFunction(
  DurableObjectScope,
  function (
    ...args:
      | []
      | [
          name: string,
          props?: DurableObjectProps,
          // phantom argument
          isClassForm?: true,
        ]
      | [
          name: string,
          impl: Effect.Effect<
            Effect.Effect<DurableObject<any>, never, DurableObjectState>
          >,
          // phantom argument
          isClassForm?: true,
        ]
  ) {
    if (args.length === 0) {
      return (name: string, propsOrImpl?: any) =>
        // @ts-expect-error
        DurableObject(name, propsOrImpl, true);
    }
    const namespace = args[0];
    const isClassForm = args[2] === true;
    const propsOrImpl = args[1];
    const tag = Context.Service(namespace);

    const binding = (
      scriptName?: Input<string>,
      transferredFrom?:
        | DurableObjectTransferSource
        | DurableObjectTransferSource[],
    ) =>
      Effect.gen(function* () {
        const worker = yield* Worker;

        yield* worker.bind`${namespace}`({
          bindings: [
            {
              type: "durable_object_namespace",
              name: namespace,
              className: namespace,
              scriptName,
              transferredFrom: normalizeTransferredFrom(transferredFrom),
            },
          ],
        });

        const binding = yield* Effect.all([
          WorkerEnvironment,
          ALCHEMY_PHASE,
        ]).pipe(
          Effect.flatMap(([env, phase]) => {
            if (env === undefined || phase === "plan") {
              // should be fine to return undefined here (it is only undefined at plantime)
              return Effect.succeed(undefined);
            }
            const ns = env[namespace];
            if (!ns) {
              return Effect.die(
                new Error(`DurableObject '${namespace}' not found`),
              );
            } else if (typeof ns.getByName === "function") {
              return Effect.succeed(ns);
            } else {
              return Effect.die(
                new Error(
                  `DurableObject '${namespace}' is not a DurableObject`,
                ),
              );
            }
          }),
        );

        return {
          Type: TypeId,
          LogicalId: namespace,
          name: namespace,
          namespaceId: worker.durableObjectNamespaces.pipe(
            Output.map(
              (durableObjectNamespaces) => durableObjectNamespaces?.[namespace],
            ),
          ),
          getByName: (
            name: string,
            options?: DurableObjectGetDurableObjectOptions,
          ) => makeRpcStub(binding.getByName(name, options)),
          // newUniqueId: () => use((ns) => ns.newUniqueId()),
          // idFromName: (name: string) => use((ns) => ns.idFromName(name)),
          // idFromString: (id: string) => use((ns) => ns.idFromString(id)),
          // get: (
          //   id: cf.DurableObjectId,
          //   options?: cf.DurableObjectNamespaceGetDurableObjectOptions,
          // ) => use((ns) => makeRpcStub(ns.get(id, options))),
          // jurisdiction: (jurisdiction: cf.DurableObjectJurisdiction) =>
          //   use((ns) => ns.jurisdiction(jurisdiction) as any),
        };
      });

    // Class-form declarations (`DurableObject<Self>()("Name", props?)`) can
    // carry `transferredFrom` so the host's local binding drives a
    // data-preserving transfer migration.
    const classProps =
      isClassForm && !Effect.isEffect(propsOrImpl)
        ? (propsOrImpl as
            | Pick<DurableObjectProps, "transferredFrom">
            | undefined)
        : undefined;

    const make = Effect.fn(function* (
      impl: Effect.Effect<
        Effect.Effect<DurableObjectShape>,
        never,
        DurableObjectState
      >,
    ) {
      // Register the local DO binding (no `scriptName`) and obtain the
      // namespace handle. We provide this same handle as
      // `DurableObjectScope` to the user's constructor effect
      // and also return it so a `Layer.effect(tag, make(impl))` Layer
      // resolves the tag to a concrete namespace value.
      const self = yield* binding(undefined, classProps?.transferredFrom);
      const phase = yield* ALCHEMY_PHASE;
      const constructor = impl.pipe(
        Effect.provide(Layer.succeed(DurableObjectScope, self as any)),
      );
      if (phase === "plan") {
        // during plan time, we evaluate the constructor with a mock DurableObjectState
        // to trigger discovery of bindings
        yield* constructor.pipe(
          Effect.provide(
            Layer.succeed(
              DurableObjectState,
              // mock during plan time
              fromDurableObjectState({ storage: {} } as any),
            ),
          ),
        );
      }
      yield* (yield* Worker).export(namespace, {
        kind: "durableObject",
        // initialize the object's constructor (apply infra dependencies)
        constructor,
        // grab the object's infra dependencies so we can apply them when calling the instance's methods
        services: yield* Effect.context<Effect.Services<typeof impl>>(),
      } satisfies DurableObjectExport);
      return self;
    });

    if (!isClassForm && !Effect.isEffect(args[1])) {
      // this is an in-line, async only DO (no implementation, props only)
      return {
        kind: TypeId,
        name: namespace,
        className: (args[1] as DurableObjectProps)?.className || namespace,
        scriptName: (args[1] as DurableObjectProps)?.scriptName,
        transferredFrom: (args[1] as DurableObjectProps)?.transferredFrom,
      };
    } else if (Effect.isEffect(propsOrImpl)) {
      // inline Effect DO
      return effectClass(
        Effect.tap(binding(), () =>
          make(propsOrImpl as any).pipe(
            Effect.provideService(
              DurableObjectState,
              fromDurableObjectState(
                // everything is lazy, so this should build a proper mock
                {
                  storage: {},
                } as any,
              ),
            ),
          ),
        ),
      );
    } else {
      // Tagged Effect DO. Yielding the class resolves the `tag`, which
      // forces the `CounterLive` Layer (built by `Counter.make(impl)`) to
      // run so `worker.export(namespace, …)` is invoked — without this,
      // the class would never be registered with the Worker's exports
      // map and the deployed bundle would have no DO class for
      // Cloudflare to instantiate.
      return class extends effectClass(tag as Effect.Effect<any, never, any>) {
        static make = <Req = never>(
          impl: Effect.Effect<
            Effect.Effect<DurableObjectShape, never, DurableObjectState | Req>
          >,
        ) => Layer.effect(tag, make(impl as any));

        static from = (
          worker: string | Worker | Effect.Effect<Worker, any, any>,
        ) => {
          // Resolve `worker` to an Effect that yields the actual Worker
          // instance (or a plain string scriptName).
          //
          // A class produced by `Cloudflare.Worker<T>()(...)` exposes
          // `asEffect()` returning the Self tag — yielding that tag
          // resolves to the live Worker instance whose `workerName`
          // is a `PropExpr`, which is what we need so the engine can:
          //   1) Track WorkerB → WorkerA as a binding-level upstream
          //      dependency (so WorkerA reconciles first).
          //   2) Persist `scriptName` as a real value (not `undefined`)
          //      on the cross-script binding so the migration code in
          //      Worker.ts can detect it and skip emitting class
          //      migrations for the foreign class.
          // Plain Effects and string literals are passed through as-is.
          const resolved: Effect.Effect<Worker | string, any, any> =
            typeof worker === "string"
              ? Effect.succeed(worker)
              : asEffect(worker);

          return resolved.pipe(
            Effect.flatMap((w) =>
              binding(typeof w === "string" ? w : w.workerName),
            ),
          );
        };
      };
    }
  },
) as any;

export type DurableObjectStub<Shape> = {
  // TODO(sam): do we need to transform? hopefully not
  [key in keyof Shape]: Shape[key];
} & {
  fetch: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError,
    never
  >;
};
