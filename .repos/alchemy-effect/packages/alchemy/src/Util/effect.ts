import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipeArguments } from "effect/Pipeable";
import { SingleShotGen } from "effect/Utils";

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
        class {
          static asEffect() {
            return impl;
          }
          static [Symbol.iterator]() {
            return new SingleShotGen(this.asEffect());
          }
          static pipe(...fns: any) {
            return pipeArguments(this, fns);
          }
        },
        impl,
      ) as unknown as EffectClass<any, any, any, any>)) as any;

export const taggedFunction = <
  Tag extends Context.ServiceClass<any, any, any>,
  Fn extends (...args: any[]) => any,
>(
  tag: Tag,
  fn: Fn,
): Tag & Fn => {
  const overrides = {
    asEffect: () => tag,
    [Symbol.iterator]: () => tag[Symbol.iterator](),
    pipe: (...fns: any[]) => pipeArguments(tag, fns as any),
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
  typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
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
  isYieldableEffect(value) || isEffectClassLike(value);

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
