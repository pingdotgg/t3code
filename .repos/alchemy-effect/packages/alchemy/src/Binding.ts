import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Input } from "./Input.ts";
import type { ResourceLike } from "./Resource.ts";
import { Self } from "./Self.ts";
import { taggedFunction } from "./Util/effect.ts";

export interface ServiceLike {
  kind: "Service";
}

export interface ServiceShape<
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends Context.ServiceClass.Shape<Identifier, Shape>, ServiceLike {}

type BindParameters<
  Parameters extends any[],
  Req = never,
> = Parameters extends []
  ? []
  : // Variadic lists (`number extends length`) — e.g. `(...parameters:
    // [Parameter, ...Parameter[]])` — must be checked FIRST: a plain array
    // also matches the optional-head pattern below with itself as the rest,
    // which recurses forever (TS2589).
    number extends Parameters["length"]
    ? Parameters extends [infer First, ...infer Rest]
      ? [
          Input<First> | Effect.Effect<First, never, Req>,
          ...Array<
            Input<Rest[number]> | Effect.Effect<Rest[number], never, Req>
          >,
        ]
      : Array<
          | Input<Parameters[number]>
          | Effect.Effect<Parameters[number], never, Req>
        >
    : Parameters extends [infer First, ...infer Rest]
      ? [
          Input<First> | Effect.Effect<First, never, Req>,
          ...BindParameters<Rest, Req>,
        ]
      : // Optional head (e.g. `(bus?: EventBus)`) — `[infer F, ...R]` does
        // not match a tuple with an optional first element, which used to
        // collapse the whole parameter list to `[]` (`PutEvents(bus)` failed
        // with "Expected 0 arguments").
        Parameters extends [(infer First)?, ...infer Rest]
        ? [
            (Input<First> | Effect.Effect<First, never, Req>)?,
            ...BindParameters<Rest, Req>,
          ]
        : [];

/**
 * The combined tag + callable + type form of a binding (the `Resource.ts`-style
 * single-identifier pattern). `interface X extends Binding.Service<X, Id, Shape>`
 * declares the type; `const X = Binding.Service<X>(id)` produces a value that is at
 * once the Context tag (usable in `Layer.effect(X, …)` / `Effect.provide`), the
 * callable (`X(resource)`), and carries the type.
 */
export interface Service<
  Self,
  Identifier extends string,
  Shape extends (...args: any[]) => Effect.Effect<any, any, any>,
>
  extends Context.Service<Self, Shape>, ServiceLike {
  readonly key: Identifier;
  new (_: never): ServiceShape<Identifier, Shape>;
  <Req = never>(
    ...args: BindParameters<Parameters<Shape>, Req>
  ): Effect.Effect<
    Effect.Success<ReturnType<Shape>>,
    Effect.Error<ReturnType<Shape>>,
    Self | Effect.Services<ReturnType<Shape>> | Req
  >;
}

/**
 * Build a combined tag+callable binding (see {@link Service}). The returned
 * value forwards the Effect/Tag protocol to its Context tag (via `taggedFunction`)
 * so `Layer.effect`/`provide` work, while being directly callable to bind a
 * resource at the call site.
 */
export const Service = <
  Self extends ServiceLike & {
    readonly key: string;
  },
>(
  id: Self["key"],
): Self => {
  const tag = Context.Service<Self, (...args: any[]) => Effect.Effect<any>>(id);
  const callable = (...args: any[]) =>
    tag.use((f: (...a: any[]) => Effect.Effect<any>) =>
      Effect.all(
        args.map((arg) => (Effect.isEffect(arg) ? arg : Effect.succeed(arg))),
        { concurrency: "unbounded" },
      ).pipe(Effect.flatMap((resolved) => f(...resolved))),
    );
  return taggedFunction(tag as any, callable) as unknown as Self;
};

/**
 * Resolves the host resource a binding is attaching to (the Worker / Lambda
 * Function), i.e. `Self`. It is typed WITHOUT a Context requirement because it
 * is only ever read at DEPLOY time, inside the `if (!globalThis.__ALCHEMY_RUNTIME__)`
 * guard of a binding's impl layer — at runtime the host is absent and the guard
 * skips it, so leaking a `Self` requirement onto the runtime client would be
 * wrong. Narrow it with `isWorker`/`isFunction` before calling `host.bind`.
 */
export const Host = Self as unknown as Effect.Effect<ResourceLike>;
