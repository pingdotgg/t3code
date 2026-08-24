/**
 * `Sfn` — a typed Step Functions program DSL that compiles to ASL.
 *
 * Mirrors Effect's names and semantics (`Sfn.gen`, `Sfn.retry`,
 * `Sfn.catchTag`, `Sfn.all`, `Sfn.forEach`, `Sfn.sleep`, …) over a
 * shallow-embedded AST. Compile with `StateMachine.fromProgram` /
 * {@link compileProgram}; run locally with {@link simulate}. The raw
 * `StateMachine({ definition })` ASL path remains first-class underneath —
 * the compiler is sugar that produces a plain definition object.
 */
export {
  and,
  eq,
  gt,
  gte,
  isExpr,
  jsonata,
  literal,
  lt,
  lte,
  ne,
  not,
  or,
  taskToken,
  type Expr,
  type ExprInput,
  type UnwrapExpr,
} from "./Jsonata.ts";
export type {
  AslNode,
  ErrorOutput,
  ForEachOptions,
  IntegrationOptions,
  InvokableFunction,
  RetryOptions,
} from "./Node.ts";
export {
  gen,
  isSfnEffect,
  make,
  SfnTypeId,
  type Error,
  type SfnEffect,
  type Success,
} from "./Program.ts";
export {
  all,
  catchAll,
  catchTag,
  Errors,
  fail,
  forEach,
  integrate,
  invoke,
  match,
  retry,
  sleep,
  succeed,
  waitForTaskToken,
  when,
} from "./combinators.ts";
export {
  compileProgram,
  SfnCompileError,
  type CompiledProgram,
} from "./compile.ts";
export {
  simulate,
  SimulateError,
  type SimulateHandlers,
  type SimulateOptions,
} from "./simulate.ts";
