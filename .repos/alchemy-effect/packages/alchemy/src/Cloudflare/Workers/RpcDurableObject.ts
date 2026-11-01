import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/http/HttpServerResponse";
import type { HttpServerError } from "effect/http/HttpServerError";
import type { Rpc, RpcGroup } from "effect/rpc";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import type { Dependencies } from "../../Dependencies.ts";
import type { HttpEffect } from "../../Http.ts";
import type { Input } from "../../Input.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import {
  DurableObject,
  type DurableObjectGetDurableObjectOptions,
  type DurableObjectLike,
  type DurableObjectProps,
  type DurableObject as DurableObjectType,
  type DurableObjectServices,
} from "./DurableObject.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import { bindEffectRpc } from "./Rpc.ts";
import * as RpcWebSocket from "./RpcWebSocket.ts";
import type { Worker as WorkerService } from "./Worker.ts";

export interface RpcDurableObjectProps<Rpcs extends Rpc.Any> {
  /** The RPC schema shared by the Durable Object and its clients. */
  readonly schema: RpcGroup.RpcGroup<Rpcs>;
}

type HandlerImplementation<
  Rpcs extends Rpc.Any,
  Provided,
  InnerR,
  InitReq,
> = Effect.Effect<
  Effect.Effect<
    Layer.Layer<Rpc.ToHandler<Rpcs> | Provided, never, InnerR | RuntimeContext>,
    never,
    DurableObjectServices | RuntimeContext
  >,
  ConfigError,
  InitReq
>;

type HandlerRequirements<Rpcs extends Rpc.Any, Provided, InnerR, InitReq> =
  | WorkerService
  | Exclude<
      | InitReq
      | InnerR
      | Exclude<Rpc.Middleware<Rpcs>, Provided>
      | Rpc.ServicesServer<Rpcs>,
      DurableObjectServices | RuntimeContext
    >;

/**
 * The runtime value bound to a typed rpc Durable Object namespace.
 * Same shape as the underlying {@link DurableObjectType} for
 * binding metadata (name, namespaceId, kind), but `getByName(id)`
 * returns a typed Effect `RpcClient` over the rpc server living on
 * the DO's `fetch` handler.
 */
export interface RpcDurableObject<
  Self,
  Rpcs extends Rpc.Any = Rpc.Any,
> extends Omit<
  DurableObjectType<{ fetch: HttpEffect<DurableObjectState> }>,
  "getByName" | "get" | "Shape"
> {
  /** @internal phantom — keeps `Self` reachable through the inferred type */
  Self?: Self;
  /**
   * Select a named instance and forward an HTTP request or WebSocket upgrade.
   * Every RPC on the upgraded socket targets that same instance.
   */
  readonly fetch: (
    id: string,
    request: HttpServerRequest,
    options?: DurableObjectGetDurableObjectOptions,
  ) => Effect.Effect<HttpServerResponse, HttpServerError>;
  readonly getByName: (
    id: string,
    options?: DurableObjectGetDurableObjectOptions,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>,
    never,
    Rpc.MiddlewareClient<Rpcs>
  >;
}

// Context tag carrying the surrounding `RpcDurableObject`
// inside an rpc DO impl. Yield it from within a DO handler to refer
// back to the surrounding namespace (e.g. to fan a call out to
// sibling instances). Documented as part of the main
// `RpcDurableObject` JSDoc below.
export class RpcDurableObjectScope extends Context.Service<
  RpcDurableObjectScope,
  RpcDurableObject<unknown>
>()("Cloudflare.RpcDurableObject") {}

export interface RpcDurableObjectClass extends Effect.Effect<
  RpcDurableObject<unknown>,
  never,
  RpcDurableObjectScope
> {
  /**
   * Class-based forms: `class Counter extends RpcDurableObject<Counter>()(...)`.
   *
   * Modular (no impl):
   * ```ts
   * class Counter extends RpcDurableObject<Counter>()(
   *   "Counter",
   *   { schema: CounterRpcs },
   * ) {}
   * export const CounterLive = Counter.make(/* impl *\/);
   * ```
   * Inline impl:
   * ```ts
   * class Counter extends RpcDurableObject<Counter>()(
   *   "Counter",
   *   { schema: CounterRpcs },
   *   Effect.gen(function* () { ... }),
   * ) {}
   * ```
   */
  <Self>(): {
    /** Modular form: separate `static make(impl)` + `static from(scriptName | Worker)`. */
    <Rpcs extends Rpc.Any>(
      name: string,
      props: RpcDurableObjectProps<Rpcs>,
    ): Effect.Effect<
      RpcDurableObject<Self, Rpcs>,
      never,
      WorkerService | Self
    > & {
      new (_: never): {};
      from(
        scriptName: Input<string>,
      ): Effect.Effect<RpcDurableObject<Self, Rpcs>, never, WorkerService>;
      from<Req = never>(
        worker:
          | Dependencies<Self>
          | Effect.Effect<Dependencies<Self>, ConfigError, Req>,
      ): Effect.Effect<
        RpcDurableObject<Self, Rpcs>,
        never,
        WorkerService | Req
      >;
      make<Provided = never, InnerR = never, InitReq = never>(
        impl: HandlerImplementation<Rpcs, Provided, InnerR, InitReq>,
      ): Layer.Layer<
        Self,
        never,
        HandlerRequirements<Rpcs, Provided, InnerR, InitReq>
      >;
      make<InnerR = never, InitReq = never>(
        impl: Effect.Effect<
          Effect.Effect<
            Effect.Effect<HttpEffect<InnerR>, never, InnerR | RuntimeContext>,
            never,
            DurableObjectServices | RuntimeContext
          >,
          ConfigError,
          InitReq
        >,
      ): Layer.Layer<
        Self,
        never,
        WorkerService | Exclude<InitReq | InnerR, DurableObjectServices>
      >;
    };
    /** Inline handler Layer; the runtime supplies the RPC transports. */
    <Rpcs extends Rpc.Any, Provided = never, InnerR = never, InitReq = never>(
      name: string,
      props: RpcDurableObjectProps<Rpcs>,
      impl: HandlerImplementation<Rpcs, Provided, InnerR, InitReq>,
    ): Effect.Effect<
      RpcDurableObject<Self, Rpcs>,
      never,
      HandlerRequirements<Rpcs, Provided, InnerR, InitReq>
    > & { new (_: never): {} };
    /** Inline-impl form. */
    <Rpcs extends Rpc.Any, InnerR = never, InitReq = never>(
      name: string,
      props: RpcDurableObjectProps<Rpcs>,
      impl: Effect.Effect<
        Effect.Effect<
          Effect.Effect<HttpEffect<InnerR>, never, InnerR | RuntimeContext>,
          never,
          DurableObjectServices | RuntimeContext
        >,
        ConfigError,
        InitReq
      >,
    ): Effect.Effect<
      RpcDurableObject<Self, Rpcs>,
      never,
      WorkerService | Exclude<InitReq | InnerR, DurableObjectServices>
    > & {
      new (_: never): {};
    };
  };
  /** Descriptor-only form, for `worker.bind` declarations */
  <Rpcs extends Rpc.Any>(
    name: string,
    props: {
      readonly schema: RpcGroup.RpcGroup<Rpcs>;
    } & Partial<DurableObjectProps>,
  ): DurableObjectLike<{ fetch: HttpEffect<DurableObjectState> }>;
  /** Bare handler-Layer form. */
  <Rpcs extends Rpc.Any, Provided = never, InnerR = never, InitReq = never>(
    name: string,
    props: RpcDurableObjectProps<Rpcs>,
    impl: HandlerImplementation<Rpcs, Provided, InnerR, InitReq>,
  ): Effect.Effect<
    RpcDurableObject<unknown, Rpcs>,
    never,
    HandlerRequirements<Rpcs, Provided, InnerR, InitReq>
  >;
  /** Bare form: `(name, { schema }, impl)` */
  <Rpcs extends Rpc.Any, InnerR = never, InitReq = never>(
    name: string,
    props: RpcDurableObjectProps<Rpcs>,
    impl: Effect.Effect<
      Effect.Effect<
        Effect.Effect<HttpEffect<InnerR>, never, InnerR>,
        never,
        DurableObjectServices
      >,
      ConfigError,
      InitReq
    >,
  ): Effect.Effect<
    RpcDurableObject<unknown, Rpcs>,
    never,
    WorkerService | Exclude<InitReq | InnerR, DurableObjectServices>
  >;
}

/**
 * `RpcDurableObject` is sugar over {@link DurableObject}
 * for Durable Objects whose surface is a typed Effect `RpcGroup`. The
 * inner Effect returns the group's handler Layer, automatically enabling
 * HTTP RPC with NDJSON and hibernating WebSocket RPC with JSON. Incoming
 * requests select the transport. Consumers see `namespace.getByName(id)`
 * as a typed HTTP `RpcClient`.
 * Existing implementations returning `RpcServer.toHttpEffect(group)` remain
 * supported for HTTP.
 *
 * Use this over alchemy's built-in DO method bridge whenever values
 * crossing the DO boundary contain `Schema.Class` instances. The
 * built-in bridge `JSON.stringify`s every method return value, which
 * strips class identity (e.g. an `effect/ai` `Response.Usage` instance
 * becomes a plain struct on the consumer side). With
 * `RpcDurableObject`, both ends go through the same
 * `RpcSerialization` codec, so `Schema.decode` reconstructs class
 * instances correctly.
 *
 *
 * ### Defining the rpc group
 * **Example:** DO-scoped rpc schemas
 * The DO instance *is* the session, so the group payloads typically
 * don't include any per-session identifier — only the per-call inputs.
 * ```typescript
 * import * as Schema from "effect/Schema";
 * import { Rpc, RpcGroup } from "effect/rpc";
 *
 * const setTitle = Rpc.make("setTitle", {
 *   success: Schema.Void,
 *   payload: { title: Schema.String },
 * });
 *
 * const getTitle = Rpc.make("getTitle", {
 *   success: Schema.String,
 *   payload: {},
 * });
 *
 * export class CounterRpcs extends RpcGroup.make(setTitle, getTitle) {}
 * ```
 *
 * ### Implementing the Durable Object
 * **Example:** Class form (recommended)
 * Mirrors `Cloudflare.DurableObject<Self>()(...)` — same
 * outer/inner Effect pattern. The outer Effect resolves shared deps;
 * the per-instance inner Effect returns the RPC handler Layer.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { CounterRpcs } from "./rpcs.ts";
 *
 * export default class Counter extends Cloudflare.RpcDurableObject<Counter>()(
 *   "Counter",
 *   { schema: CounterRpcs },
 *   Effect.gen(function* () {
 *     // outer init: shared deps + the instance state reference
 *     const state = yield* Cloudflare.DurableObjectState;
 *     return Effect.gen(function* () {
 *       // inner (runtime): state.storage is RuntimeContext-colored, so
 *       // the handler closures that call it live here
 *       return CounterRpcs.toLayer({
 *         setTitle: ({ title }) => state.storage.put("title", title),
 *         getTitle: () =>
 *           Effect.map(state.storage.get<string>("title"), (t) => t ?? ""),
 *       });
 *     });
 *   }),
 * ) {}
 * ```
 *
 * ### Calling the DO from a Worker
 * **Example:** Typed rpc client at the call site
 * `yield* Counter` resolves to a value whose `getByName(id)` returns
 * an `Effect<RpcClient<CounterRpcs>>`. Each rpc method is a typed
 * Effect/Stream factory — no `RpcClient.make` setup needed. Yield
 * the client inside a per-request `Effect.scoped` handler so it's
 * freed with the request.
 * ```typescript
 * import Counter from "./counter.ts";
 *
 * Effect.gen(function* () {
 *   const counters = yield* Counter;
 *   const client = yield* counters.getByName("global");
 *   yield* client.setTitle({ title: "Hello" });
 *   const title = yield* client.getTitle({});
 *   return title;
 * }).pipe(Effect.scoped);
 * ```
 *
 * ### WebSocket RPC
 * **Example:** Forward a browser connection from the Worker
 * Handler-Layer implementations accept WebSocket upgrades automatically;
 * ordinary HTTP RPC remains available on the same object.
 * ```typescript
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * const counters = yield* Counter;
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *     const path = new URL(request.url, "https://worker").pathname;
 *     const name = /^\/counters\/([a-zA-Z0-9_-]+)$/.exec(path)?.[1];
 *     if (!name) return HttpServerResponse.empty({ status: 404 });
 *     return yield* counters.fetch(name, request);
 *   }),
 * };
 * ```
 * A client connecting to `wss://example.com/counters/alice` targets the
 * `"alice"` instance. Every RPC on that socket stays on that object; RPC
 * payloads do not need an object ID. Another name selects another object.
 * The Worker defines this URL mapping, not Alchemy.
 * Authenticate and authorize access to the selected name before forwarding.
 * See the [Effect RPC guide](/cloudflare/apis/effect-rpc#connect-over-a-websocket)
 * for a browser client whose Layer owns the connection lifetime. Clients use
 * Effect's `RpcClient.layerProtocolSocket` with JSON serialization. Idle
 * connections survive hibernation. Restored sockets with unfinished requests
 * close with code `1012`; platform resets can also cause transport errors.
 * Requests and streams are never replayed. No application acknowledgment
 * methods or checkpoints are required.
 *
 * ### Modular form: separate the class from its runtime
 * **Example:** Class declaration with no impl + `static make(impl)`
 * The inline class form above bundles the runtime into the class
 * declaration. The two-arg form `(name, { schema })` declares the
 * class as a pure tagged identifier; provide the runtime separately
 * via `Class.make(impl)`. Consumer Workers can import the class for
 * binding (`Counter.from(HostWorker)`) without pulling the runtime
 * into their bundle.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { CounterRpcs } from "./rpcs.ts";
 *
 * export class Counter extends Cloudflare.RpcDurableObject<Counter>()(
 *   "Counter",
 *   { schema: CounterRpcs },
 * ) {}
 *
 * // Only the host script imports this default export.
 * export default Counter.make(
 *   Effect.gen(function* () {
 *     const state = yield* Cloudflare.DurableObjectState;
 *     return Effect.gen(function* () {
 *       return CounterRpcs.toLayer({
 *         setTitle: ({ title }) => state.storage.put("title", title),
 *         getTitle: () =>
 *           Effect.map(state.storage.get<string>("title"), (t) => t ?? ""),
 *       });
 *     });
 *   }),
 * );
 * ```
 *
 * ### Cross-script binding via `Counter.from(Worker)`
 * **Example:** Hosting on WorkerA, binding from WorkerB
 * The host Worker declares `Counter` in its `Deps` (third type
 * arg of `Worker<Self, Bindings, Deps>` or second of
 * `RpcWorker<Self, Deps>`) and provides `CounterLive`. Any other
 * Worker uses `Counter.from(HostWorker)` to bind to the same DO
 * instances — writes through `HostWorker.getByName(name)` are
 * visible from `Counter.from(HostWorker).getByName(name)`.
 * ```typescript
 * // host worker (declares + provides Counter)
 * import CounterLive, { Counter } from "./counter.ts";
 *
 * export class WorkerA extends Cloudflare.Worker<WorkerA, {}, Counter>()(
 *   "WorkerA",
 *   { main: import.meta.url },
 * ) {}
 *
 * export default WorkerA.make(
 *   Effect.gen(function* () {
 *     const counters = yield* Counter; // local host binding
 *     // ... fetch handler ...
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 *
 * // consumer worker (binds via .from)
 * export default class WorkerB extends Cloudflare.Worker<WorkerB>()(
 *   "WorkerB",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter.from(WorkerA);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const client = yield* counters.getByName("shared");
 *         yield* client.setTitle({ title: "via WorkerB" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.scoped),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Self-hosted isolated namespace
 * A Worker that declares `Counter` in its own `Deps` and provides
 * `CounterLive` hosts its own isolated namespace — instances under
 * it are separate from any other host's. Use `Counter.from(Self)`
 * inside the host to be explicit about which script's namespace
 * you're binding to.
 * ```typescript
 * export class WorkerC extends Cloudflare.Worker<WorkerC, {}, Counter>()(
 *   "WorkerC",
 *   { main: import.meta.url },
 * ) {}
 *
 * export default WorkerC.make(
 *   Effect.gen(function* () {
 *     const counters = yield* Counter.from(WorkerC); // explicit self
 *     // ... fetch handler ...
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 *
 * ### Yielding the surrounding namespace from inside a DO
 * **Example:** `yield* RpcDurableObject` inside the DO impl
 * Lets a DO instance refer to its own namespace — e.g. to fan a call
 * out to sibling instances. Mirrors `yield* DurableObject`
 * on the regular `DurableObject`.
 * ```typescript
 * Effect.gen(function* () {
 *   const self = yield* Cloudflare.RpcDurableObject;
 *   const peer = yield* self.getByName("peer-1");
 *   yield* peer.setTitle({ title: "Sibling call" });
 * }).pipe(Effect.scoped);
 * ```
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 */
export const RpcDurableObject: RpcDurableObjectClass = taggedFunction(
  RpcDurableObjectScope,
  (...args: any[]) => {
    // Class-form: zero args returns the inner builder. Inner-arg arity
    // distinguishes modular (`(name, { schema })`, no impl — `static
    // from`/`static make` provide the runtime) from inline-impl
    // (`(name, { schema }, impl)`).
    if (args.length === 0) {
      return (...inner: any[]) => {
        if (inner.length === 2) {
          const [name, props] = inner as [string, RpcDurableObjectProps<any>];
          return buildModular(name, props);
        }
        const [name, props, impl] = inner as [
          string,
          RpcDurableObjectProps<any>,
          Effect.Effect<Effect.Effect<any>>,
        ];
        return build(name, props, impl);
      };
    }
    // Descriptor-only form: `(name, { schema })` — no impl.
    if (args.length === 2) {
      const [name, props] = args as [
        string,
        {
          readonly schema: RpcGroup.RpcGroup<any>;
        } & Partial<DurableObjectProps>,
      ];
      return {
        kind: "Cloudflare.DurableObject" as const,
        name,
        className: props?.className,
      } satisfies DurableObjectLike<any>;
    }
    // Bare form: `(name, { schema }, impl)`.
    const [name, props, impl] = args as [
      string,
      RpcDurableObjectProps<any>,
      Effect.Effect<Effect.Effect<any>>,
    ];
    return build(name, props, impl);
  },
) as any;

// Wrap a raw `DurableObject` so its `getByName` returns a typed
// Effect `RpcClient` (via `bindEffectRpc`) instead of the built-in
// method-bridge stub. Used in every branch that produces a yieldable
// `RpcDurableObject` value.
const rpcWrap = (
  rawNs: DurableObjectType<any>,
  schema: RpcGroup.RpcGroup<any>,
): RpcDurableObject<any> => {
  const rpcView = bindEffectRpc(rawNs as any, schema);
  return Object.assign({}, rawNs, {
    getByName: rpcView.getByName,
    fetch: (
      id: string,
      request: HttpServerRequest,
      options?: DurableObjectGetDurableObjectOptions,
    ) => rawNs.getByName(id, options).fetch(request),
  }) as unknown as RpcDurableObject<any>;
};

const wrapImpl = (
  impl: Effect.Effect<Effect.Effect<any>>,
  props: RpcDurableObjectProps<any>,
) =>
  impl.pipe(
    Effect.map((inner) =>
      inner.pipe(
        Effect.flatMap((value) => {
          if (Layer.isLayer(value)) {
            return makeHandlers(props, value as Layer.Layer<any, never, any>);
          }
          return Effect.succeed({ fetch: value });
        }),
      ),
    ),
  ) as Effect.Effect<Effect.Effect<any>>;

class RpcRequestLifetime extends RpcMiddleware.Service<RpcRequestLifetime>()(
  "Cloudflare.RpcDurableObject.RequestLifetime",
) {}

const makeHandlers = Effect.fn(function* (
  props: RpcDurableObjectProps<any>,
  handlers: Layer.Layer<any, never, any>,
) {
  // The protocol outlives the constructor's temporary layer scope.
  return yield* Effect.acquireUseRelease(
    Scope.make(),
    (instanceScope) =>
      Effect.gen(function* () {
        const memoMap = Layer.makeMemoMapUnsafe();
        const context = yield* Layer.buildWithMemoMap(
          handlers,
          memoMap,
          instanceScope,
        );
        const services = Layer.succeedContext(context);
        const http = Effect.gen(function* () {
          const handler = yield* RpcServer.toHttpEffect(props.schema).pipe(
            Effect.provide(
              Layer.mergeAll(services, RpcSerialization.layerNdjson),
            ),
          );
          return yield* handler;
        });
        const state = yield* DurableObjectState;
        const runtime = yield* RuntimeContext;
        const lifetime = Layer.succeed(RpcRequestLifetime, (effect) =>
          Effect.withFiber((fiber) =>
            // RpcServer sends Exit before finalization and drops sends after disconnect.
            state
              .waitUntil(Fiber.await(fiber))
              .pipe(
                Effect.provideService(RuntimeContext, runtime),
                Effect.andThen(effect),
              ),
          ),
        );
        const transport = yield* RpcWebSocket.make.pipe(
          Effect.provide(RpcSerialization.layerJson),
        );
        yield* Layer.buildWithMemoMap(
          RpcServer.layer(props.schema.middleware(RpcRequestLifetime)).pipe(
            Layer.provide(
              Layer.mergeAll(
                services,
                lifetime,
                Layer.succeed(RpcServer.Protocol, transport.protocol),
              ),
            ),
          ),
          memoMap,
          instanceScope,
        );
        return {
          webSocketMessage: transport.webSocketMessage,
          webSocketClose: transport.webSocketClose,
          webSocketError: transport.webSocketError,
          fetch: Effect.gen(function* () {
            const request = yield* HttpServerRequest;
            return yield* request.headers.upgrade?.toLowerCase() === "websocket"
              ? transport.fetch
              : http;
          }),
        };
      }),
    (instanceScope, exit) =>
      Exit.isFailure(exit) ? Scope.close(instanceScope, exit) : Effect.void,
  );
});

const build = (
  name: string,
  props: RpcDurableObjectProps<any>,
  impl: Effect.Effect<Effect.Effect<any>>,
) => {
  // Inline-impl class form: delegate to `DurableObject`'s
  // inline class form, then expose the rpc-wrapped view at yield
  // time. No `static from`/`static make` because the impl is provided
  // eagerly here (consumers wanting cross-script binding use the
  // modular form below).
  const underlying = (DurableObject as any)()(name, wrapImpl(impl, props));
  // `underlying` is itself an Effect now, no `.asEffect()` hop required.
  const underlyingEff = underlying as Effect.Effect<
    DurableObjectType<any>,
    never,
    any
  >;
  const rpcBound = underlyingEff.pipe(
    Effect.map((rawNs) => rpcWrap(rawNs, props.schema)),
  ) as unknown as Effect.Effect<RpcDurableObject<any>>;
  return effectClass(rpcBound);
};

const buildModular = (name: string, props: RpcDurableObjectProps<any>) => {
  const { schema } = props;
  // Delegate to `DurableObject<Self>()(name)` (no-impl class
  // form) so we inherit its Self-tag plumbing for free:
  //   - yielding the class resolves to the live namespace via the tag
  //     (populated by `static make(impl)`'s Layer)
  //   - `static from(scriptName | Worker)` registers a foreign-script
  //     binding on the surrounding worker and yields a fresh handle
  // We just rpc-wrap each output so consumers see a typed `getByName`.
  const Underlying: any = (DurableObject as any)()(name);
  // `Underlying` is itself an Effect now, no `.asEffect()` hop required.
  const underlyingEff = Underlying as Effect.Effect<
    DurableObjectType<any>,
    never,
    any
  >;

  return class extends effectClass(
    underlyingEff.pipe(
      Effect.map((rawNs) => rpcWrap(rawNs, schema)),
    ) as unknown as Effect.Effect<RpcDurableObject<any>>,
  ) {
    static make = (impl: Effect.Effect<Effect.Effect<any>>) =>
      Underlying.make(wrapImpl(impl, props));

    static from = (
      worker: string | object | Effect.Effect<any, any, any>,
    ): Effect.Effect<RpcDurableObject<any>, any, any> =>
      Underlying.from(worker).pipe(
        Effect.map((rawNs: DurableObjectType<any>) => rpcWrap(rawNs, schema)),
      );
  };
};
