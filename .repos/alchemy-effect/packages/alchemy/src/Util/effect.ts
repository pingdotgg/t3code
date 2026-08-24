import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";

export type EffectClass<Shape, A, Err = never, Req = never> = Effect.Effect<
  A,
  Err,
  Req
> & {
  new (_: never): Shape;
};

export const effectClass: {
  <A, Err = never, Req = never>(
    impl: Effect.Effect<A, Err, Req>,
  ): EffectClass<A, A, Err, Req>;
  <Shape>(): <A, Err = never, Req = never>(
    impl: Effect.Effect<A, Err, Req>,
  ) => EffectClass<Shape, A, Err, Req>;
} = ((impl?: any) =>
  impl === undefined
    ? (innerImpl: any) => effectClass(innerImpl)
    : (Object.assign(
        class {},
        // Spreading the Effect prototype onto the class (static side) makes the
        // class itself a real Effect — `Effect.isEffect(X)` is true, so
        // `Effect.all([X])` / `Effect.forEach` work — and subclasses
        // (`class Y extends effectClass(impl)`) inherit the protocol statically.
        Effectable.Prototype({
          label: "alchemy/EffectClass",
          evaluate: () => impl,
        }),
      ) as unknown as EffectClass<any, any, any, any>)) as any;

export const taggedFunction = <
  Tag extends Context.ServiceClass<any, any, any>,
  Fn extends (...args: any[]) => any,
>(
  tag: Tag,
  fn: Fn,
): Tag & Fn => {
  // The Proxy below forwards every Effect-protocol key to `tag` (already an
  // Effect), so `asEffect`/`[Symbol.iterator]`/`pipe` need no explicit
  // override — only `toString` diverges.
  const overrides = {
    toString: () => `${tag.toString()}.${fn.name}`,
  };

  return new Proxy(fn, {
    get: (target, prop, receiver) =>
      Reflect.has(overrides, prop)
        ? Reflect.get(overrides, prop, receiver)
        : Reflect.has(target, prop)
          ? Reflect.get(target, prop, receiver)
          : Reflect.get(tag as object, prop, tag),
    has: (target, prop) =>
      Reflect.has(overrides, prop) ||
      Reflect.has(target, prop) ||
      Reflect.has(tag as object, prop),
  }) as Tag & Fn;
};

export const isYieldableEffect = (
  value: unknown,
): value is Effect.Effect<unknown, unknown, unknown> =>
  Effect.isEffect(value) &&
  typeof (value as any as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
    "function";

export type YieldableEffectLike<A = unknown, E = unknown, R = unknown> =
  | Effect.Effect<A, E, R>
  | {
      asEffect: () => Effect.Effect<A, E, R>;
      [Symbol.iterator]: () => Iterator<unknown>;
    };

export const isEffectClassLike = (
  value: unknown,
): value is YieldableEffectLike =>
  typeof value === "function" &&
  typeof (value as { asEffect?: unknown }).asEffect === "function";

export const isYieldableEffectLike = (
  value: unknown,
): value is YieldableEffectLike =>
  (isYieldableEffect(value) || isEffectClassLike(value)) &&
  !("~alchemy/Kind" in value);

export type UnwrapEffect<T> =
  T extends Effect.Effect<infer A, any, any> ? A : T;

export type ToEffectInterface<T> = {
  raw: T;
} & {
  [K in keyof T]: T[K] extends (...args: any[]) => any
    ? (...args: Parameters<T[K]>) => Effect.Effect<Awaited<ReturnType<T[K]>>>
    : T[K];
};

export const toEffectInterface = <T extends object>(raw: T) =>
  ({
    raw,
    ...Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        typeof value === "function"
          ? (...args: any[]) => Effect.tryPromise(async () => value(...args))
          : value,
      ]),
    ),
  }) as ToEffectInterface<T>;
