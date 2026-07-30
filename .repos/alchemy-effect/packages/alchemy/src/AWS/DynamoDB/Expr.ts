export type Expr =
  | ArrayIndex
  | Identifier
  | NumberLiteral
  | OperatorExpr
  | NameRef
  | PropRef
  | ValueRef;
//

export interface NameRef<Name extends string = string> {
  kind: "name-ref";
  name: Name;
}
export interface ValueRef<Name extends string = string> {
  kind: "value-ref";
  name: Name;
}
export interface Identifier<I extends string = string> {
  kind: "identifier";
  name: I;
}

export interface NumberLiteral<N extends string = string> {
  kind: "index";
  number: N;
}
export interface PropRef<Ex extends Expr = any, Id extends Identifier = any> {
  kind: "prop-ref";
  expr: Ex;
  name: Id;
}
export interface ArrayIndex<
  List extends Expr = any,
  Number extends NumberLiteral | ValueRef = NumberLiteral | ValueRef,
> {
  kind: "array-index";
  list: List;
  number: Number;
}

export type Operator = "and" | "or" | "=" | "<" | "<=" | ">=" | ">";
export interface OperatorExpr<
  Left extends Expr = any,
  Op extends Operator = Operator,
  Right extends Expr = any,
> {
  kind: "op";
  left: Left;
  op: Op;
  right: Right;
}

export type LowercaseLetter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";

export type UppercaseLetter = Uppercase<LowercaseLetter>;

export type Letter = LowercaseLetter | UppercaseLetter;

export type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export type SpecialCharacter = "_";

export type Word = Digit | Letter | SpecialCharacter;
