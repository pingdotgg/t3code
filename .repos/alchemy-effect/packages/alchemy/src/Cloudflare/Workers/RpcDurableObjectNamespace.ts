import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import type { Dependencies } from "../../Dependencies.ts";
import type { HttpEffect } from "../../Http.ts";
import type { Input } from "../../Input.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import {
  DurableObjectNamespace,
  type DurableObjectNamespaceLike,
  type DurableObjectNamespaceProps,
  type DurableObjectNamespace as DurableObjectNamespaceType,
  type DurableObjectServices,
} from "./DurableObjectNamespace.ts";
import type { DurableObjectState } from "./DurableObjectState.ts";
import { bindEffectRpc } from "./Rpc.ts";
import type { Worker as WorkerService } from "./Worker.ts";

/**
 * The runtime value bound to a typed rpc Durable Object namespace.
 * Same shape as the underlying {@link DurableObjectNamespaceType} for
 * binding metadata (name, namespaceId, kind), but `getByName(id)`
 * returns a typed Effect `RpcClient` over the rpc server living on
 * the DO's `fetch` handler.
 */
export interface RpcDurableObjectNamespace<
  Self,
  Rpcs extends Rpc.Any = Rpc.Any,
> extends Omit<
  DurableObjectNamespaceType<{ fetch: HttpEffect<DurableObjectState> }>,
  "getByName" | "get" | "Shape"
> {
  /** @internal phantom — keeps `Self` reachable through the inferred type */
  Self?: Self;
  readonly getByName: (
    id: string,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>,
    never,
    Rpc.MiddlewareClient<Rpcs>
  >;
}

// Context tag carrying the surrounding `RpcDurableObjectNamespace`
// inside an rpc DO impl. Yield it from within a DO handler to refer
// back to the surrounding namespace (e.g. to fan a call out to
// sibling instances). Documented as part of the main
// `RpcDurableObjectNamespace` JSDoc below.
export class RpcDurableObjectNamespaceScope extends Context.Service<
  RpcDurableObjectNamespaceScope,
  RpcDurableObjectNamespace<unknown>
>()("Cloudflare.RpcDurableObjectNamespace") {}

export interface RpcDurableObjectNamespaceClass extends Effect.Effect<
  RpcDurableObjectNamespace<unknown>,
  never,
  RpcDurableObjectNamespaceScope
> {
  /**
   * Class-based forms: `class Counter extends RpcDurableObjectNamespace<Counter>()(...)`.
   *
   * Modular (no impl):
   * ```ts
   * class Counter extends RpcDurableObjectNamespace<Counter>()(
   *   "Counter",
   *   { schema: CounterRpcs },
   * ) {}
   * export const CounterLive = Counter.make(/* impl *\/);
   * ```
   * Inline impl:
   * ```ts
   * class Counter extends RpcDurableObjectNamespace<Counter>()(
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
      props: { readonly schema: RpcGroup.RpcGroup<Rpcs> },
    ): Effect.Effect<
      RpcDurableObjectNamespace<Self, Rpcs>,
      never,
      WorkerService | Self
    > & {
      new (_: never): {};
      from(
        scriptName: Input<string>,
      ): Effect.Effect<
        RpcDurableObjectNamespace<Self, Rpcs>,
        never,
        WorkerService
      >;
      from<Req = never>(
        worker:
          | Dependencies<Self>
          | Effect.Effect<Dependencies<Self>, never, Req>,
      ): Effect.Effect<
        RpcDurableObjectNamespace<Self, Rpcs>,
        never,
        WorkerService | Req
      >;
      make<InnerR = never, InitReq = never>(
        impl: Effect.Effect<
          Effect.Effect<
            Effect.Effect<HttpEffect<InnerR>, never, InnerR>,
            never,
            DurableObjectServices
          >,
          never,
          InitReq
        >,
      ): Layer.Layer<
        Self,
        never,
        WorkerService | Exclude<InitReq | InnerR, DurableObjectServices>
      >;
    };
    /** Inline-impl form. */
    <Rpcs extends Rpc.Any, InnerR = never, InitReq = never>(
      name: string,
      props: { readonly schema: RpcGroup.RpcGroup<Rpcs> },
      impl: Effect.Effect<
        Effect.Effect<
          Effect.Effect<HttpEffect<InnerR>, never, InnerR>,
          never,
          DurableObjectServices
        >,
        never,
        InitReq
      >,
    ): Effect.Effect<
      RpcDurableObjectNamespace<Self, Rpcs>,
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
    } & Partial<DurableObjectNamespaceProps>,
  ): DurableObjectNamespaceLike<{ fetch: HttpEffect<DurableObjectState> }>;
  /** Bare form: `(name, { schema }, impl)` */
  <Rpcs extends Rpc.Any, InnerR = never, InitReq = never>(
    name: string,
    props: { readonly schema: RpcGroup.RpcGroup<Rpcs> },
    impl: Effect.Effect<
      Effect.Effect<
        Effect.Effect<HttpEffect<InnerR>, never, InnerR>,
        never,
        DurableObjectServices
      >,
      never,
      InitReq
    >,
  ): Effect.Effect<
    RpcDurableObjectNamespace<unknown, Rpcs>,
    never,
    WorkerService | Exclude<InitReq | InnerR, DurableObjectServices>
  >;
}

/**
 * `RpcDurableObjectNamespace` is sugar over {@link DurableObjectNamespace}
 * for Durable Objects whose surface is a typed Effect `RpcGroup`. The
 * DO serves an `RpcServer.toHttpEffect(group)` on its own `fetch`, and
 * consumers see `namespace.getByName(id)` as a typed `RpcClient`
 * directly — no manual client wiring.
 *
 * Use this over alchemy's built-in DO method bridge whenever values
 * crossing the DO boundary contain `Schema.Class` instances. The
 * built-in bridge `JSON.stringify`s every method return value, which
 * strips class identity (e.g. an `effect/ai` `Response.Usage` instance
 * becomes a plain struct on the consumer side). With
 * `RpcDurableObjectNamespace`, both ends go through the same
 * `RpcSerialization` codec, so `Schema.decode` reconstructs class
 * instances correctly.
 *
 * @resource
 *
 * @section Defining the rpc group
 * @example DO-scoped rpc schemas
 * The DO instance *is* the session, so the group payloads typically
 * don't include any per-session identifier — only the per-call inputs.
 * ```typescript
 * import * as Schema from "effect/Schema";
 * import { Rpc, RpcGroup } from "effect/unstable/rpc";
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
 * @section Implementing the Durable Object
 * @example Class form (recommended)
 * Mirrors `Cloudflare.DurableObjectNamespace<Self>()(...)` — same
 * outer/inner Effect pattern. The outer Effect resolves shared deps;
 * the per-instance inner Effect returns the
 * `RpcServer.toHttpEffect(schema)`-piped Effect directly.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
 * import { CounterRpcs } from "./rpcs.ts";
 *
 * export default class Counter extends Cloudflare.RpcDurableObjectNamespace<Counter>()(
 *   "Counter",
 *   { schema: CounterRpcs },
 *   Effect.gen(function* () {
 *     // outer init: shared deps for all instances
 *     return Effect.gen(function* () {
 *       // per-instance init: state + handlers
 *       const state = yield* Cloudflare.DurableObjectState;
 *       const handlers = CounterRpcs.toLayer({
 *         setTitle: ({ title }) => state.storage.put("title", title),
 *         getTitle: () =>
 *           Effect.map(state.storage.get<string>("title"), (t) => t ?? ""),
 *       });
 *       return RpcServer.toHttpEffect(CounterRpcs).pipe(
 *         Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
 *       );
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @section Calling the DO from a Worker
 * @example Typed rpc client at the call site
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
 * @section Modular form: separate the class from its runtime
 * @example Class declaration with no impl + `static make(impl)`
 * The inline class form above bundles the runtime into the class
 * declaration. The two-arg form `(name, { schema })` declares the
 * class as a pure tagged identifier; provide the runtime separately
 * via `Class.make(impl)`. Consumer Workers can import the class for
 * binding (`Counter.from(HostWorker)`) without pulling the runtime
 * into their bundle.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
 * import { CounterRpcs } from "./rpcs.ts";
 *
 * export class Counter extends Cloudflare.RpcDurableObjectNamespace<Counter>()(
 *   "Counter",
 *   { schema: CounterRpcs },
 * ) {}
 *
 * // Only the host script imports this default export.
 * export default Counter.make(
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const state = yield* Cloudflare.DurableObjectState;
 *       const handlers = CounterRpcs.toLayer({
 *         setTitle: ({ title }) => state.storage.put("title", title),
 *         getTitle: () =>
 *           Effect.map(state.storage.get<string>("title"), (t) => t ?? ""),
 *       });
 *       return RpcServer.toHttpEffect(CounterRpcs).pipe(
 *         Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
 *       );
 *     });
 *   }),
 * );
 * ```
 *
 * @section Cross-script binding via `Counter.from(Worker)`
 * @example Hosting on WorkerA, binding from WorkerB
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
 *   { main: import.meta.filename },
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
 *   { main: import.meta.filename },
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
 * @example Self-hosted isolated namespace
 * A Worker that declares `Counter` in its own `Deps` and provides
 * `CounterLive` hosts its own isolated namespace — instances under
 * it are separate from any other host's. Use `Counter.from(Self)`
 * inside the host to be explicit about which script's namespace
 * you're binding to.
 * ```typescript
 * export class WorkerC extends Cloudflare.Worker<WorkerC, {}, Counter>()(
 *   "WorkerC",
 *   { main: import.meta.filename },
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
 * @section Yielding the surrounding namespace from inside a DO
 * @example `yield* RpcDurableObjectNamespace` inside the DO impl
 * Lets a DO instance refer to its own namespace — e.g. to fan a call
 * out to sibling instances. Mirrors `yield* DurableObjectNamespace`
 * on the regular `DurableObjectNamespace`.
 * ```typescript
 * Effect.gen(function* () {
 *   const self = yield* Cloudflare.RpcDurableObjectNamespace;
 *   const peer = yield* self.getByName("peer-1");
 *   yield* peer.setTitle({ title: "Sibling call" });
 * }).pipe(Effect.scoped);
 * ```
 */
export const RpcDurableObjectNamespace: RpcDurableObjectNamespaceClass =
  taggedFunction(RpcDurableObjectNamespaceScope, (...args: any[]) => {
    // Class-form: zero args returns the inner builder. Inner-arg arity
    // distinguishes modular (`(name, { schema })`, no impl — `static
    // from`/`static make` provide the runtime) from inline-impl
    // (`(name, { schema }, impl)`).
    if (args.length === 0) {
      return (...inner: any[]) => {
        if (inner.length === 2) {
          const [name, props] = inner as [
            string,
            { readonly schema: RpcGroup.RpcGroup<any> },
          ];
          return buildModular(name, props.schema);
        }
        const [name, props, impl] = inner as [
          string,
          { readonly schema: RpcGroup.RpcGroup<any> },
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
        } & Partial<DurableObjectNamespaceProps>,
      ];
      return {
        kind: "Cloudflare.DurableObjectNamespace" as const,
        name,
        className: props?.className,
      } satisfies DurableObjectNamespaceLike<any>;
    }
    // Bare form: `(name, { schema }, impl)`.
    const [name, props, impl] = args as [
      string,
      { readonly schema: RpcGroup.RpcGroup<any> },
      Effect.Effect<Effect.Effect<any>>,
    ];
    return build(name, props, impl);
  }) as any;

// Wrap a raw `DurableObjectNamespace` so its `getByName` returns a typed
// Effect `RpcClient` (via `bindEffectRpc`) instead of the built-in
// method-bridge stub. Used in every branch that produces a yieldable
// `RpcDurableObjectNamespace` value.
const rpcWrap = (
  rawNs: DurableObjectNamespaceType<any>,
  schema: RpcGroup.RpcGroup<any>,
): RpcDurableObjectNamespace<any> => {
  const rpcView = bindEffectRpc(rawNs as any, schema);
  return Object.assign({}, rawNs, {
    getByName: rpcView.getByName,
  }) as unknown as RpcDurableObjectNamespace<any>;
};

// The user's inner Effect resolves to `Effect<HttpEffect>`; the
// underlying `DurableObjectNamespace` expects `Effect<{ fetch:
// HttpEffect }>` (a `DurableObjectShape`). Map through both layers to
// box the http effect in the `{ fetch }` shape.
const wrapImpl = (impl: Effect.Effect<Effect.Effect<any>>) =>
  impl.pipe(
    Effect.map((inner) =>
      inner.pipe(Effect.map((fetch: HttpEffect<any>) => ({ fetch }))),
    ),
  ) as Effect.Effect<Effect.Effect<any>>;

const build = (
  name: string,
  props: { readonly schema: RpcGroup.RpcGroup<any> },
  impl: Effect.Effect<Effect.Effect<any>>,
) => {
  // Inline-impl class form: delegate to `DurableObjectNamespace`'s
  // inline class form, then expose the rpc-wrapped view at yield
  // time. No `static from`/`static make` because the impl is provided
  // eagerly here (consumers wanting cross-script binding use the
  // modular form below).
  const underlying = (DurableObjectNamespace as any)()(name, wrapImpl(impl));
  const underlyingEff: Effect.Effect<
    DurableObjectNamespaceType<any>,
    never,
    any
  > = (underlying as { asEffect(): Effect.Effect<any, never, any> }).asEffect();
  const rpcBound = underlyingEff.pipe(
    Effect.map((rawNs) => rpcWrap(rawNs, props.schema)),
  ) as unknown as Effect.Effect<RpcDurableObjectNamespace<any>>;
  return effectClass(rpcBound);
};

const buildModular = (name: string, schema: RpcGroup.RpcGroup<any>) => {
  // Delegate to `DurableObjectNamespace<Self>()(name)` (no-impl class
  // form) so we inherit its Self-tag plumbing for free:
  //   - yielding the class resolves to the live namespace via the tag
  //     (populated by `static make(impl)`'s Layer)
  //   - `static from(scriptName | Worker)` registers a foreign-script
  //     binding on the surrounding worker and yields a fresh handle
  // We just rpc-wrap each output so consumers see a typed `getByName`.
  const Underlying: any = (DurableObjectNamespace as any)()(name);
  const underlyingEff: Effect.Effect<
    DurableObjectNamespaceType<any>,
    never,
    any
  > = (Underlying as { asEffect(): Effect.Effect<any, never, any> }).asEffect();

  return class extends effectClass(
    underlyingEff.pipe(
      Effect.map((rawNs) => rpcWrap(rawNs, schema)),
    ) as unknown as Effect.Effect<RpcDurableObjectNamespace<any>>,
  ) {
    static make = (impl: Effect.Effect<Effect.Effect<any>>) =>
      Underlying.make(wrapImpl(impl));

    static from = (
      worker: string | object | Effect.Effect<any, any, any>,
    ): Effect.Effect<RpcDurableObjectNamespace<any>, any, any> =>
      Underlying.from(worker).pipe(
        Effect.map((rawNs: DurableObjectNamespaceType<any>) =>
          rpcWrap(rawNs, schema),
        ),
      );
  };
};
