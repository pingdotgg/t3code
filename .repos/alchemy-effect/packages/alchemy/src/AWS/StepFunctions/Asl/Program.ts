/**
 * `SfnEffect<A, E>` — the yieldable, pipeable Step Functions program type.
 *
 * It mirrors Effect's `<A, E>` channels (there is deliberately no `R`
 * channel: an ASL program cannot require services — its "requirements" are
 * the resources its Task states reference, collected structurally at
 * compile). It is **not** an `Effect`: it is a shallow-embedded AST that
 * *feels* like Effect (generator syntax, `catchTag` narrowing `E`) but
 * constructs a data structure that `compile.ts` turns into ASL JSON.
 *
 * Yielding a real `Effect` inside `Sfn.gen` is a **type error** — only
 * `SfnEffect`s (branded with {@link SfnTypeId}) are yieldable.
 */
import { pipeArguments } from "effect/Pipeable";
import type { Pipeable } from "effect/Pipeable";
import type { Expr, UnwrapExpr } from "./Jsonata.ts";
import type { AslNode } from "./Node.ts";

/** Brand distinguishing `SfnEffect` from `Effect` (and everything else). */
export const SfnTypeId = Symbol.for("alchemy/AWS/StepFunctions/SfnEffect");
export type SfnTypeId = typeof SfnTypeId;

/**
 * A typed Step Functions program producing `A` or failing with a tagged
 * error `E`. Build with `Sfn.gen` and the `Sfn.*` combinators; compile with
 * `StateMachine.fromProgram` (or `compileProgram`); run locally with
 * `simulate`.
 */
export interface SfnEffect<out A, out E = never> extends Pipeable {
  readonly [SfnTypeId]: {
    readonly _A: (_: never) => A;
    readonly _E: (_: never) => E;
  };
  /** The program AST node this effect wraps. */
  readonly node: AslNode;
  /**
   * `yield*` protocol for `Sfn.gen`: yields this program once and resumes
   * with a typed {@link Expr} reference to its result.
   */
  [Symbol.iterator](): Generator<SfnEffect<A, E>, Expr<A>, any>;
}

/** The success type of an {@link SfnEffect}. */
export type Success<T> = T extends SfnEffect<infer A, any> ? A : never;
/** The error type of an {@link SfnEffect}. */
export type Error<T> = T extends SfnEffect<any, infer E> ? E : never;

const variance = {
  _A: undefined as never,
  _E: undefined as never,
};

class SfnEffectImpl implements SfnEffect<any, any> {
  readonly [SfnTypeId] = variance;
  constructor(readonly node: AslNode) {}
  pipe() {
    // eslint-disable-next-line prefer-rest-params
    return pipeArguments(this, arguments);
  }
  *[Symbol.iterator](): Generator<SfnEffect<any, any>, Expr<any>, any> {
    // yield this program once; the tracer (compile/simulate) resumes the
    // generator with a typed variable reference to its result
    return yield this;
  }
}

/** Construct an {@link SfnEffect} from an AST node. */
export const make = <A, E = never>(node: AslNode): SfnEffect<A, E> =>
  new SfnEffectImpl(node) as SfnEffect<A, E>;

/** Runtime guard for {@link SfnEffect} values. */
export const isSfnEffect = (value: unknown): value is SfnEffect<any, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  SfnTypeId in value;

/**
 * Write a Step Functions program with generator syntax — the `Sfn`
 * counterpart of `Effect.gen`. Each `yield*` of an `SfnEffect` resumes with
 * a **typed reference** ({@link Expr}) to that step's result, usable in
 * later payloads and conditions; the compiler turns the sequence into
 * `Next`-chained ASL states.
 *
 * The body receives a typed reference to the execution input. Annotate the
 * parameter to type it:
 *
 * ```typescript
 * const program = Sfn.gen(function* (input: Sfn.Expr<{ orderId: string }>) {
 *   const order = yield* Sfn.invoke<Order>(getOrder, { id: input.orderId });
 *   return { total: order.total };
 * });
 * ```
 *
 * The generator is a *trace*, not a running program: it executes at compile
 * time with placeholder references, so data-dependent JS control flow over
 * step results is unsound — use `Sfn.when` / `Sfn.match` for branching.
 * Yielding a real `Effect` is a type error by design.
 */
export const gen = <Y extends SfnEffect<any, any>, R, In = any>(
  body: (input: Expr<In>) => Generator<Y, R, any>,
): SfnEffect<UnwrapExpr<R>, [Y] extends [never] ? never : Error<Y>> =>
  make({ kind: "gen", body: body as GenBody });

type GenBody = (input: Expr<any>) => Generator<SfnEffect<any, any>, any, any>;
