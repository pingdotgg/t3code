import type { Config } from "effect/Config";
import type { Effect } from "effect/Effect";
import type * as S from "effect/Schema";
import type { Primitive } from ".//Util/data.ts";
import type { Output } from "./Output.ts";

export type Function = (...args: any[]) => any;
export type Constructor = new (...args: any[]) => any;
type PolicyLike = { kind: "alchemy/Policy" };

export type Input<T> =
  | T
  | Output<T>
  | Config<T>
  // TODO(sam): extract Requirements in Resource
  | Effect<T, any, any>
  | (T extends S.Schema<any>
      ? never
      :
          | Output<T, any>
          | (T extends Primitive
              ? never
              : T extends any[]
                ? number extends T["length"]
                  ? Input<T[number]>[]
                  : Inputs<T>
                : T extends object
                  ? { [K in keyof T]: Input<T[K]> }
                  : never));

export type InputProps<
  T extends Record<string, any>,
  Static extends keyof T = never,
> = {
  [K in keyof T]: K extends Static ? T[K] : Input<T[K]>;
};

export declare namespace Input {
  export type Resolve<T> = T extends {
    Type: string;
    Attributes: infer Attributes;
  }
    ? {
        [K in keyof Attributes]: Resolve<Attributes[K]>;
      }
    : T extends Output<infer U>
      ? U
      : T extends
            | Primitive
            | Constructor
            | Function
            | S.Schema<any>
            | PolicyLike
        ? T
        : T extends any[]
          ? ResolveArray<T>
          : T extends Record<string, any>
            ? {
                [k in keyof T]: Input.Resolve<T[k]>;
              }
            : never;

  export type ResolveArray<T extends any[]> = number extends T["length"]
    ? Resolve<T[number]>[]
    : ResolveTuple<T>;

  export type ResolveTuple<
    T extends any[],
    // TODO(sam): I added the accumulator because it resolved infinite type instantiation
    Accum extends any[] = [],
  > = T extends [infer H, ...infer Tail]
    ? ResolveTuple<Tail, [...Accum, Input.Resolve<H>]>
    : Accum;

  export type ResolveProps<Props extends Record<string, any>> = {
    [k in keyof Props]: Input.Resolve<Props[k]>;
  };

  export type ResolveOpaque<T> =
    // use true extends IsOut to avoid distribution in the case where we have an Out<T>
    // because T is a clean type, e.g. Input<SubnetProps> should just be SubnetProps (don't bother resolving the recursive input type variants)
    true extends IsOut<T> ? ResolveOut<T> : Resolve<T>;
  export type IsOut<T> = T extends Output<infer _U> ? true : never;

  export type ResolveOut<T> = T extends Output<infer U> ? U : never;
}

export type Inputs<T extends any[], Out extends any[] = []> = T extends [
  infer H,
  ...infer T,
]
  ? Inputs<T, [...Out, Input<H>]>
  : Out;
