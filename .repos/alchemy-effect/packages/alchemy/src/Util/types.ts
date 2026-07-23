import * as Effect from "effect/Effect";

export type IsAny<T> = 0 extends 1 & T ? true : false;

export type ExcludeAny<T> = IsAny<T> extends true ? never : T;

export type UnionToIntersection<U> = (
  U extends any ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

export const assertDefined = <T>(value: T | undefined, message: string): T => {
  if (!value) {
    throw new Error(message);
  }
  return value;
};

export const asEffect = <T, Err = never, Req = never>(
  effect:
    | T
    | Effect.Effect<T, Err, Req>
    | { asEffect: () => Effect.Effect<T, Err, Req> },
): Effect.Effect<T, Err, Req> =>
  typeof (effect as any)?.asEffect === "function"
    ? (effect as any).asEffect()
    : Effect.isEffect(effect)
      ? effect
      : Effect.succeed(effect as T);

export type IsNever<T> = [T] extends [never] ? true : false;
