/**
 * Phantom-typed JSONata value references for the Step Functions program DSL.
 *
 * An {@link Expr} is a *typed reference to a value that will exist at
 * execution time* — the execution input, the result of a previous state
 * (an ASL variable), the current Map item, etc. Property access is a Proxy
 * that builds up a JSONata path (`$states.context.Execution.Input.customerId`
 * style); comparator helpers (`eq`, `gt`, `and`, …) build boolean
 * expressions for Choice states.
 *
 * The same expression AST has two interpreters:
 * - `compile.ts` renders it to a `{% ... %}` JSONata string in the ASL
 *   definition,
 * - `simulate.ts` evaluates it in-process against a variable environment.
 */

/** Brand key carried by every {@link Expr} proxy. */
export const ExprTypeId = Symbol.for("alchemy/AWS/StepFunctions/JsonataExpr");
export type ExprTypeId = typeof ExprTypeId;

/** The value roots a JSONata path can start from. */
export type ExprRoot =
  /** The state machine execution input (`$states.context.Execution.Input`). */
  | { readonly kind: "input" }
  /** An ASL variable assigned by an earlier state (`$name`). */
  | { readonly kind: "variable"; readonly name: string }
  /** The callback task token (`$states.context.Task.Token`). */
  | { readonly kind: "token" };

/** Binary comparison / boolean operators supported by the expression AST. */
export type ExprOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "and" | "or";

/**
 * The untyped expression AST behind an {@link Expr} proxy. Plain data — both
 * the ASL printer and the local simulator interpret it structurally.
 */
export type ExprNode =
  | { readonly _: "root"; readonly root: ExprRoot }
  | { readonly _: "prop"; readonly parent: ExprNode; readonly name: string }
  | { readonly _: "literal"; readonly value: unknown }
  | {
      readonly _: "binop";
      readonly op: ExprOperator;
      readonly left: ExprNode;
      readonly right: ExprNode;
    }
  | { readonly _: "not"; readonly inner: ExprNode }
  /** Raw JSONata escape hatch — compiles verbatim, unsupported by simulate. */
  | { readonly _: "raw"; readonly jsonata: string };

interface ExprBrand<T> {
  readonly [ExprTypeId]: {
    readonly node: ExprNode;
    readonly _T: (_: never) => T;
  };
}

/**
 * A typed JSONata value reference. Property access is typed: given
 * `input: Expr<{ order: { total: number } }>`, `input.order.total` is an
 * `Expr<number>` that renders as `….order.total`.
 *
 * Arrays are opaque references (pass them to `Sfn.forEach`); primitives are
 * leaf references usable in comparators and payloads.
 */
export type Expr<T = any> = ExprBrand<T> &
  ([T] extends [readonly any[]]
    ? {}
    : [T] extends [object]
      ? { readonly [K in keyof T & string]-?: Expr<T[K]> }
      : {});

/** A value of `T`, a typed reference to one, or `Expr<any>` (untyped hole). */
export type ExprInput<T> = T | Expr<T> | Expr<any>;

/** Recursively replace `Expr<T>` references with their referent type. */
export type UnwrapExpr<T> =
  T extends Expr<infer A>
    ? A
    : T extends readonly (infer U)[]
      ? UnwrapExpr<U>[]
      : T extends object
        ? { [K in keyof T]: UnwrapExpr<T[K]> }
        : T;

/** Runtime guard for {@link Expr} proxies. */
export const isExpr = (value: unknown): value is Expr<any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as ExprBrand<any>)[ExprTypeId] !== undefined;

/** Extract the AST node from an {@link Expr}. */
export const nodeOf = (expr: Expr<any>): ExprNode => expr[ExprTypeId].node;

/**
 * Wrap an AST node in the typed Proxy. String property access appends a
 * `prop` node; everything else (symbols, `then`, iteration protocols) is
 * absent so the proxy never masquerades as a Promise, Effect, or Output.
 */
export const makeExpr = <T>(node: ExprNode): Expr<T> => {
  const brand = { node, _T: undefined as never };
  return new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === ExprTypeId) return brand;
        if (typeof prop !== "string") return undefined;
        // `toJSON`/`then` lookups happen when host code probes values
        // (JSON.stringify, await). Treat them as path segments would be
        // wrong; renderers detect Exprs *before* serialization, so any
        // such probe reaching here is a misuse — return a child expr
        // anyway (harmless, typed access never sees these names).
        return makeExpr({ _: "prop", parent: node, name: prop });
      },
      has: (_, prop) => prop === ExprTypeId,
    },
  ) as Expr<T>;
};

const literalNode = (value: unknown): ExprNode => ({ _: "literal", value });

/** Lift a value or Expr to an AST node. */
export const toNode = (value: unknown): ExprNode =>
  isExpr(value) ? nodeOf(value) : literalNode(value);

/** Lift a constant into a typed expression. */
export const literal = <T>(value: T): Expr<T> => makeExpr(literalNode(value));

/**
 * Raw JSONata escape hatch. Compiles verbatim into the definition
 * (`{% <jsonata> %}`); `simulate` rejects it with a `SimulateError`.
 */
export const jsonata = <T = unknown>(expression: string): Expr<T> =>
  makeExpr({ _: "raw", jsonata: expression });

const binop = (
  op: ExprOperator,
  left: unknown,
  right: unknown,
): Expr<boolean> =>
  makeExpr({ _: "binop", op, left: toNode(left), right: toNode(right) });

/** `left = right` (JSONata equality). */
export const eq = <T>(left: ExprInput<T>, right: ExprInput<T>): Expr<boolean> =>
  binop("=", left, right);
/** `left != right`. */
export const ne = <T>(left: ExprInput<T>, right: ExprInput<T>): Expr<boolean> =>
  binop("!=", left, right);
/** `left > right`. */
export const gt = (
  left: ExprInput<number>,
  right: ExprInput<number>,
): Expr<boolean> => binop(">", left, right);
/** `left >= right`. */
export const gte = (
  left: ExprInput<number>,
  right: ExprInput<number>,
): Expr<boolean> => binop(">=", left, right);
/** `left < right`. */
export const lt = (
  left: ExprInput<number>,
  right: ExprInput<number>,
): Expr<boolean> => binop("<", left, right);
/** `left <= right`. */
export const lte = (
  left: ExprInput<number>,
  right: ExprInput<number>,
): Expr<boolean> => binop("<=", left, right);
/** Boolean conjunction. */
export const and = (
  ...conditions: [
    ExprInput<boolean>,
    ExprInput<boolean>,
    ...ExprInput<boolean>[],
  ]
): Expr<boolean> =>
  conditions
    .slice(1)
    .reduce<Expr<boolean>>(
      (acc, c) => binop("and", acc, c),
      isExpr(conditions[0])
        ? (conditions[0] as Expr<boolean>)
        : literal(conditions[0] as boolean),
    );
/** Boolean disjunction. */
export const or = (
  ...conditions: [
    ExprInput<boolean>,
    ExprInput<boolean>,
    ...ExprInput<boolean>[],
  ]
): Expr<boolean> =>
  conditions
    .slice(1)
    .reduce<Expr<boolean>>(
      (acc, c) => binop("or", acc, c),
      isExpr(conditions[0])
        ? (conditions[0] as Expr<boolean>)
        : literal(conditions[0] as boolean),
    );
/** Boolean negation (`$not(...)`). */
export const not = (condition: ExprInput<boolean>): Expr<boolean> =>
  makeExpr({ _: "not", inner: toNode(condition) });

/** The execution-input root expression. */
export const inputExpr = <T>(): Expr<T> =>
  makeExpr({ _: "root", root: { kind: "input" } });

/** A reference to the ASL variable `name`. */
export const variableExpr = <T>(name: string): Expr<T> =>
  makeExpr({ _: "root", root: { kind: "variable", name } });

/**
 * The callback task token (`$states.context.Task.Token`) — embed inside
 * `Sfn.waitForTaskToken` arguments so the callback side can complete the
 * task via `SendTaskSuccess`/`SendTaskFailure`.
 */
export const taskToken: Expr<string> = makeExpr({
  _: "root",
  root: { kind: "token" },
});

// ---------------------------------------------------------------------------
// JSONata printer (used by compile.ts)
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const renderRoot = (root: ExprRoot): string => {
  switch (root.kind) {
    case "input":
      return "$states.context.Execution.Input";
    case "variable":
      return `$${root.name}`;
    case "token":
      return "$states.context.Task.Token";
  }
};

/** Render an AST node to JSONata source (without the `{% %}` wrapper). */
export const renderNode = (node: ExprNode): string => {
  switch (node._) {
    case "root":
      return renderRoot(node.root);
    case "prop": {
      const parent =
        node.parent._ === "root" || node.parent._ === "prop"
          ? renderNode(node.parent)
          : `(${renderNode(node.parent)})`;
      return IDENT.test(node.name)
        ? `${parent}.${node.name}`
        : `${parent}.\`${node.name}\``;
    }
    case "literal":
      return JSON.stringify(node.value === undefined ? null : node.value);
    case "binop":
      return `(${renderNode(node.left)} ${node.op} ${renderNode(node.right)})`;
    case "not":
      return `$not(${renderNode(node.inner)})`;
    case "raw":
      return node.jsonata;
  }
};

/** Render an {@link Expr} to a `{% ... %}`-wrapped ASL JSONata string. */
export const renderExprString = (expr: Expr<any>): string =>
  `{% ${renderNode(nodeOf(expr))} %}`;
