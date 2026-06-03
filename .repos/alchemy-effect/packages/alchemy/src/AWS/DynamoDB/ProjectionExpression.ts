import type {
  ArrayIndex,
  Expr,
  Identifier,
  NameRef,
  NumberLiteral,
  PropRef,
  ValueRef,
  Word,
} from "./Expr.ts";

export type ParseProjectionExpression<Text extends string> = Parse<
  Text,
  [],
  undefined
>;

type AsExpr<T> = Extract<T, Expr>;

type Parse<
  Text extends string,
  Expressions extends Expr[],
  Exp extends Expr | undefined,
> = Text extends `.${infer Rest}`
  ? Exp extends Expr
    ? Parse<Rest, Expressions, PropRef<Exp, Identifier<"">>>
    : never
  : Text extends `[:${infer Rest}`
    ? Parse<Rest, Expressions, ArrayIndex<AsExpr<Exp>, ValueRef<"">>>
    : Text extends `[${infer Rest}`
      ? Parse<Rest, Expressions, ArrayIndex<AsExpr<Exp>, NumberLiteral<"">>>
      : Text extends `]${infer Rest}`
        ? Parse<Rest, Expressions, Exp>
        : Text extends `]`
          ? Concat<Expressions, Exp>
          : Text extends `${"," | " "}${infer Rest}`
            ? Parse<Rest, Concat<Expressions, Exp>, undefined>
            : Text extends `#${infer Rest}`
              ? Parse<Rest, Concat<Expressions, Exp>, NameRef<Rest>>
              : Text extends `:${infer Rest}`
                ? Parse<Rest, Concat<Expressions, Exp>, ValueRef<Rest>>
                : Text extends `${Word}${string}`
                  ? Text extends `${infer char}${infer Rest}`
                    ? Parse<Rest, Expressions, Append<Exp, char>>
                    : never
                  : Text extends `${Word}${string}`
                    ? Text extends `${infer char}${infer Rest}`
                      ? Parse<Rest, Expressions, Append<Exp, char>>
                      : never
                    : Concat<Expressions, Exp>;

type Concat<
  Expressions extends Expr[],
  CurrentExpr extends Expr | undefined,
> = undefined extends CurrentExpr
  ? Expressions
  : [...Expressions, Extract<CurrentExpr, Expr>];

type Append<
  Exp extends Expr | undefined,
  char extends string,
> = Exp extends undefined
  ? Identifier<char>
  : Exp extends Identifier<infer Name>
    ? Identifier<`${Name}${char}`>
    : Exp extends NumberLiteral<infer Name>
      ? NumberLiteral<`${Name}${char}`>
      : Exp extends NameRef<infer Name>
        ? NameRef<`${Name}${char}`>
        : Exp extends ValueRef<infer Name>
          ? ValueRef<`${Name}${char}`>
          : Exp extends PropRef<infer expr, infer name>
            ? PropRef<expr, Extract<Append<name, char>, Identifier>>
            : Exp extends ArrayIndex<infer expr, infer idx>
              ? ArrayIndex<expr, Extract<Append<idx, char>, NumberLiteral>>
              : never;

export type ApplyProjection<T, Expr extends string> = Flatten<
  UnionToIntersection<
    ApplyProjectionExpr<T, ParseProjectionExpression<Expr>[number]>
  >
>;

type ApplyProjectionExpr<T, Exp extends Expr> = T extends undefined
  ? never
  : Exp extends PropRef<infer expr, infer i>
    ? {
        [p in keyof ApplyProjectionExpr<T, expr>]: ApplyProjectionExpr<
          ApplyProjectionExpr<T, expr>[p],
          i
        >;
      }
    : Exp extends ArrayIndex<infer expr, infer i>
      ? {
          [p in keyof ApplyProjectionExpr<T, expr>]: ApplyProjectionExpr<
            ApplyProjectionExpr<T, expr>[keyof ApplyProjectionExpr<T, expr>],
            i
          >;
        }
      : Exp extends Identifier<infer I>
        ? I extends keyof T
          ? Pick<T, I>
          : never
        : Exp extends NumberLiteral<infer I>
          ? ParseInt<I> extends keyof T
            ? Pick<T, ParseInt<I>>
            : never
          : never;

type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

type Flatten<T> = T extends object
  ? keyof T extends number
    ? FlattenArray<Extract<T, Record<number, any>>>
    : {
        [k in keyof T]: Flatten<T[k]>;
      }
  : T;

type FlattenArray<
  T extends { [i in number]: any },
  i extends number = 0,
> = i extends keyof T
  ? [T[i], ...FlattenArray<T, Inc<i>>]
  : number extends i
    ? []
    : FlattenArray<T, Inc<i>>;

type BuildTuple<N extends number, T extends any[] = []> = T["length"] extends N
  ? T
  : BuildTuple<N, [...T, any]>;

type Inc<N extends number> = Extract<[...BuildTuple<N>, any]["length"], number>;

type ParseInt<N extends string> = N extends "0"
  ? 0
  : N extends "1"
    ? 1
    : N extends "2"
      ? 2
      : N extends "3"
        ? 3
        : N extends "4"
          ? 4
          : N extends "5"
            ? 5
            : N extends "6"
              ? 6
              : N extends "7"
                ? 7
                : N extends "8"
                  ? 8
                  : N extends "9"
                    ? 9
                    : number;
