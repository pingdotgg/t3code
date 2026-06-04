import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Dependencies } from "../../Dependencies.ts";
import type { HttpEffect } from "../../Http.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { ALCHEMY_PHASE } from "../../Phase.ts";
import type { PlatformServices } from "../../Platform.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import { asEffect } from "../../Util/types.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import { makeRpcStub } from "./Rpc.ts";
import { type DurableWebSocket } from "./WebSocket.ts";
import { Worker, WorkerEnvironment, type WorkerServices } from "./Worker.ts";

export interface DurableObjectExport {
  readonly kind: "durableObject";
  readonly constructor: Effect.Effect<
    DurableObjectShape,
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
export type DurableObjectNamespaceGetDurableObjectOptions =
  cf.DurableObjectNamespaceGetDurableObjectOptions;

export type AlarmInvocationInfo = cf.AlarmInvocationInfo;

type TypeId = "Cloudflare.DurableObjectNamespace";
const TypeId = "Cloudflare.DurableObjectNamespace";

export const isDurableObjectNamespaceLike = (
  value: unknown,
): value is DurableObjectNamespaceLike =>
  typeof value === "object" && (value as any)?.kind === TypeId;

export interface DurableObjectNamespaceLike<Shape = any> {
  kind: TypeId;
  name: string;
  /** @internal phantom */
  className?: string;
  /** @internal phantom */
  scriptName?: Input<string>;
  /** @internal phantom */
  Shape?: Shape;
}

export interface DurableObjectNamespace<
  Shape = unknown,
> extends DurableObjectNamespaceLike<Shape> {
  Type: TypeId;
  name: string;
  namespaceId: Output.Output<string>;
  getByName: (name: string) => DurableObjectStub<Shape>;
  newUniqueId: () => DurableObjectId;
  idFromName: (name: string) => DurableObjectId;
  idFromString: (id: string) => DurableObjectId;
  get: (
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ) => DurableObjectStub<Shape>;
  jurisdiction: (
    jurisdiction: DurableObjectJurisdiction,
  ) => DurableObjectNamespace<Shape>;
}

export interface DurableObjectShape {
  fetch?: HttpEffect<DurableObjectState>;
  alarm?: (
    alarmInfo?: AlarmInvocationInfo,
  ) => Effect.Effect<void, never, never>;
  webSocketMessage?: (
    socket: DurableWebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void>;
  webSocketClose?: (
    socket: DurableWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void>;
}

export type DurableObjectServices =
  | DurableObjectNamespace
  | DurableObjectState
  | WorkerServices
  | WorkerEnvironment
  | PlatformServices;

export interface DurableObjectNamespaceProps {
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
  // environment?: string | undefined;
  // sqlite?: boolean | undefined;
  // namespaceId?: string | undefined;
}

export interface DurableObjectNamespaceClass extends Effect.Effect<
  DurableObjectNamespace,
  never,
  DurableObjectNamespace
> {
  <Self, Shape>(): {
    <Name extends string>(
      name: Name,
    ): Effect.Effect<DurableObjectNamespace<Self>, never, Worker | Self> & {
      new (_: never): Shape & {
        /** @internal */
        "~alchemy/name": Name;
      };
      from(
        scriptName: Input<string>,
      ): Effect.Effect<DurableObjectNamespace<Self>, never, Worker>;
      from<Req = never>(
        worker:
          | Dependencies<Self>
          | Effect.Effect<Dependencies<Self>, never, Req>,
      ): Effect.Effect<DurableObjectNamespace<Self>, never, Worker | Req>;
      make<InitReq = never>(
        impl: Effect.Effect<
          Effect.Effect<Shape, never, DurableObjectServices>,
          never,
          InitReq
        >,
      ): Layer.Layer<
        Self,
        never,
        Worker | Exclude<InitReq, DurableObjectServices>
      >;
    };
  };
  <Self>(): {
    <Shape, InitReq = never>(
      name: string,
      impl: Effect.Effect<
        Effect.Effect<Shape, never, DurableObjectServices>,
        never,
        InitReq
      >,
    ): Effect.Effect<
      DurableObjectNamespace<Self>,
      never,
      Worker | Exclude<InitReq, DurableObjectServices>
    > & {
      new (_: never): Shape;
    };
  };
  <Shape>(
    name: string,
    props?: DurableObjectNamespaceProps,
  ): DurableObjectNamespaceLike<Shape>;
  <Shape, InitReq = never>(
    name: string,
    impl: Effect.Effect<
      Effect.Effect<Shape, never, DurableObjectServices>,
      never,
      InitReq
    >,
  ): Effect.Effect<
    DurableObjectNamespace<Shape>,
    never,
    Worker | Exclude<InitReq, DurableObjectServices>
  >;
}

export class DurableObjectNamespaceScope extends Context.Service<
  DurableObjectNamespaceScope,
  DurableObjectNamespace
>()("Cloudflare.DurableObjectNamespace") {}

/**
 * A Cloudflare Durable Object namespace that manages globally unique, stateful
 * instances with WebSocket hibernation support.
 *
 * A Durable Object uses a two-phase pattern with two nested `Effect.gen`
 * blocks. The outer Effect resolves shared dependencies (other DOs,
 * containers, etc.). The inner Effect runs once per instance and returns
 * the object's public methods and WebSocket handlers.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   // Phase 1: resolve shared dependencies
 *   const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 *   return Effect.gen(function* () {
 *     // Phase 2: per-instance setup and public API
 *     const state = yield* Cloudflare.DurableObjectState;
 *
 *     return {
 *       save: (data: string) => db.exec("INSERT ..."),
 *       fetch: Effect.gen(function* () { ... }),
 *       webSocketMessage: Effect.fnUntraced(function* (ws, msg) { ... }),
 *     };
 *   });
 * })
 * ```
 *
 * There are two ways to define a Durable Object. See the
 * {@link https://alchemy.run/concepts/platform | Platform concept} page
 * for the full explanation.
 *
 * - **Inline** — Effect implementation passed directly, single file.
 * - **Modular** — class and implementation in separate files for tree-shaking.
 *
 * @resource
 *
 * @section Inline Durable Objects
 * Pass the Effect implementation as the second argument. This is the
 * simplest approach — everything lives in one file. Convenient when
 * the DO doesn't need to be referenced by other Workers or DOs that
 * would pull in its runtime dependencies.
 *
 * @example Inline Durable Object
 * ```typescript
 * export default class Counter extends Cloudflare.DurableObjectNamespace<Counter>()(
 *   "Counter",
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 *     return Effect.gen(function* () {
 *       const state = yield* Cloudflare.DurableObjectState;
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *
 *       return {
 *         // runtime: use them
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
 * export class Counter extends Cloudflare.DurableObjectNamespace<Counter>()(
 *   "Counter",
 * ) {}
 *
 * export default Counter.make(
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 *     return Effect.gen(function* () {
 *       const state = yield* Cloudflare.DurableObjectState;
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *
 *       return {
 *         // runtime: use them
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
 *   { main: import.meta.filename },
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
 *   { main: import.meta.filename },
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
 *   { main: import.meta.filename },
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
 * @section Accessing Instance State
 * Each Durable Object instance has its own transactional key-value
 * storage via `Cloudflare.DurableObjectState`. Use `storage.get` and
 * `storage.put` inside the inner Effect to persist data across requests
 * and restarts.
 *
 * @example Reading and writing durable storage
 * ```typescript
 * const state = yield* Cloudflare.DurableObjectState;
 *
 * yield* state.storage.put("counter", 42);
 * const value = yield* state.storage.get("counter");
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
 *   webSocketMessage: Effect.fnUntraced(function* (
 *     socket: Cloudflare.DurableWebSocket,
 *     message: string | Uint8Array,
 *   ) {
 *     const text = typeof message === "string"
 *       ? message
 *       : new TextDecoder().decode(message);
 *     // process the message
 *   }),
 *   webSocketClose: Effect.fnUntraced(function* (
 *     ws: Cloudflare.DurableWebSocket,
 *     code: number,
 *     reason: string,
 *   ) {
 *     yield* ws.close(code, reason);
 *   }),
 * };
 * ```
 *
 * @example Recovering sessions after hibernation
 * Place the rehydration loop **inside the inner `Effect.gen`** so
 * it runs every time the DO instance is reconstructed (including
 * after Cloudflare wakes the DO from hibernation).
 *
 * ```typescript
 * return Effect.gen(function* () {
 *   const state = yield* Cloudflare.DurableObjectState;
 *   const sessions = new Map<string, Cloudflare.DurableWebSocket>();
 *
 *   // Rehydrate the in-memory session map after hibernation.
 *   for (const socket of yield* state.getWebSockets()) {
 *     const data = socket.deserializeAttachment<{ id: string }>();
 *     if (data) sessions.set(data.id, socket);
 *   }
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const [response, socket] = yield* Cloudflare.upgrade();
 *       const id = crypto.randomUUID();
 *       socket.serializeAttachment({ id });
 *       sessions.set(id, socket);
 *       return response;
 *     }),
 *     webSocketMessage: Effect.fnUntraced(function* (socket, message) {
 *       const text =
 *         typeof message === "string" ? message : new TextDecoder().decode(message);
 *       for (const peer of sessions.values()) {
 *         yield* peer.send(text);
 *       }
 *     }),
 *   };
 * });
 * ```
 *
 * @section Scheduled Alarms
 * Each Durable Object can have a single alarm timestamp. Alchemy
 * layers a small SQLite-backed scheduler on top via
 * `Cloudflare.scheduleEvent` and `Cloudflare.processScheduledEvents`,
 * so you can register many named events with arbitrary payloads and
 * fire them from a single `alarm` handler.
 *
 * @example Scheduling and processing events
 * ```typescript
 * // schedule from a request or message handler
 * yield* Cloudflare.scheduleEvent(
 *   "reminder-1",
 *   new Date(Date.now() + 60_000),
 *   { message: "your meeting starts in a minute" },
 * );
 *
 * return {
 *   alarm: () =>
 *     Effect.gen(function* () {
 *       const fired = yield* Cloudflare.processScheduledEvents;
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
 * Worker resource. Pass a `DurableObjectNamespace` reference with a
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
 *     Counter: Cloudflare.DurableObjectNamespace<Counter>("Counter"),
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
 * consumer Worker declares a `DurableObjectNamespace` with `scriptName`
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
 *     Counter: Cloudflare.DurableObjectNamespace<Counter>("Counter"),
 *   },
 * });
 * ```
 *
 * @example Consumer Worker binds to the host script
 * ```typescript
 * const consumer = yield* Cloudflare.Worker("Consumer", {
 *   main: "./src/consumer.ts",
 *   bindings: {
 *     Counter: Cloudflare.DurableObjectNamespace<Counter>("Counter", {
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
 *     Counter: Cloudflare.DurableObjectNamespace<Counter>("Counter", {
 *       className: "CounterV2",
 *       scriptName: host.workerName,
 *     }),
 *   },
 * });
 * ```
 */
export const DurableObjectNamespace: DurableObjectNamespaceClass =
  taggedFunction(
    DurableObjectNamespaceScope,
    function (
      ...args:
        | []
        | [
            name: string,
            props?: DurableObjectNamespaceProps,
            // phantom argument
            isClassForm?: true,
          ]
        | [
            name: string,
            impl: Effect.Effect<
              Effect.Effect<
                DurableObjectNamespace<any>,
                never,
                DurableObjectState
              >
            >,
            // phantom argument
            isClassForm?: true,
          ]
    ) {
      if (args.length === 0) {
        return (name: string, propsOrImpl?: any) =>
          // @ts-expect-error
          DurableObjectNamespace(name, propsOrImpl, true);
      }
      const namespace = args[0];
      const isClassForm = args[2] === true;
      const propsOrImpl = args[1];
      const tag = Context.Service(namespace);

      const binding = (scriptName?: Input<string>) =>
        Effect.gen(function* () {
          const worker = yield* Worker;

          yield* worker.bind`${namespace}`({
            // TODO(sam): automate class migrations, probably in the provider
            bindings: [
              {
                type: "durable_object_namespace",
                name: namespace,
                className: namespace,
                scriptName,
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
                  new Error(`DurableObjectNamespace '${namespace}' not found`),
                );
              } else if (typeof ns.getByName === "function") {
                return Effect.succeed(ns);
              } else {
                return Effect.die(
                  new Error(
                    `DurableObjectNamespace '${namespace}' is not a DurableObjectNamespace`,
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
                (durableObjectNamespaces) =>
                  durableObjectNamespaces?.[namespace],
              ),
            ),
            getByName: (name: string) => makeRpcStub(binding.getByName(name)),
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

      const make = Effect.fnUntraced(function* (
        impl: Effect.Effect<
          Effect.Effect<DurableObjectShape, never, DurableObjectState>
        >,
      ) {
        // Register the local DO binding (no `scriptName`) and obtain the
        // namespace handle. We provide this same handle as
        // `DurableObjectNamespaceScope` to the user's constructor effect
        // and also return it so a `Layer.effect(tag, make(impl))` Layer
        // resolves the tag to a concrete namespace value.
        const self = yield* binding();
        yield* (yield* Worker).export(namespace, {
          kind: "durableObject",
          // initialize the object's constructor (apply infra dependencies)
          constructor: yield* impl.pipe(
            Effect.provideService(DurableObjectNamespaceScope, self as any),
          ),
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
          className:
            (args[1] as DurableObjectNamespaceProps)?.className || namespace,
          scriptName: (args[1] as DurableObjectNamespaceProps)?.scriptName,
        };
      } else if (Effect.isEffect(propsOrImpl)) {
        // inline Effect DO
        return effectClass(
          Effect.tap(binding(), () => make(propsOrImpl as any)),
        );
      } else {
        // Tagged Effect DO. Yielding the class resolves the `tag`, which
        // forces the `CounterLive` Layer (built by `Counter.make(impl)`) to
        // run so `worker.export(namespace, …)` is invoked — without this,
        // the class would never be registered with the Worker's exports
        // map and the deployed bundle would have no DO class for
        // Cloudflare to instantiate.
        return class extends effectClass(
          tag as Effect.Effect<any, never, any>,
        ) {
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
