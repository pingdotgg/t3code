/**
 * The `Sfn.*` combinators — Effect-mirroring constructors over the ASL AST.
 *
 * Names and semantics track their `Effect` counterparts as closely as the
 * target language allows: `Sfn.gen`, `Sfn.retry`, `Sfn.catchTag`,
 * `Sfn.catchAll`, `Sfn.all`, `Sfn.forEach`, `Sfn.sleep`, `Sfn.when`,
 * `Sfn.match`, `Sfn.succeed`, `Sfn.fail`. Divergences are deliberate:
 * `retry` takes an option bag mirroring the `Schedule.exponential`
 * vocabulary (a real `Schedule` is opaque and cannot be introspected into
 * ASL's `BackoffRate`), and branching goes through `when`/`match` because a
 * compiled program cannot branch on runtime JS.
 */
import * as Duration from "effect/Duration";
import { aslSeconds } from "./compile.ts";
import type { Expr, UnwrapExpr } from "./Jsonata.ts";
import type {
  ErrorOutput,
  ForEachOptions,
  IntegrationOptions,
  InvokableFunction,
  RetryOptions,
} from "./Node.ts";
import {
  isSfnEffect as isSfn,
  make,
  type Error as ErrorOf,
  type SfnEffect,
  type Success,
} from "./Program.ts";

/**
 * Invoke a Lambda function as a Task state
 * (`arn:aws:states:::lambda:invoke`). The payload may embed typed `Expr`
 * references and resource `Output`s; the result reference is the function's
 * response payload.
 *
 * Compiling the program emits the `lambda:InvokeFunction` policy statement
 * for the function's exact ARN (and its qualified variants) into the
 * collected `policyStatements`.
 */
export const invoke = <A = unknown, E = never>(
  fn: InvokableFunction,
  payload?: unknown,
): SfnEffect<A, E> => make({ kind: "invoke", fn, payload });

/**
 * Call an optimized service integration as a Task state, e.g.
 * `arn:aws:states:::sqs:sendMessage`. Provide the exact-ARN policy
 * statements the execution role needs.
 */
export const integrate = <A = unknown, E = never>(
  options: IntegrationOptions,
): SfnEffect<A, E> =>
  make({ kind: "integrate", options, waitForTaskToken: false });

/**
 * Call a service integration with the `.waitForTaskToken` callback pattern:
 * the state parks until `SendTaskSuccess`/`SendTaskFailure` is called with
 * the token. Embed {@link taskToken} (re-exported as `Sfn.taskToken`) in the
 * arguments to hand the token to the callback side; the result is the JSON
 * given to `SendTaskSuccess`.
 */
export const waitForTaskToken = <A = unknown, E = never>(
  options: IntegrationOptions,
): SfnEffect<A, E> =>
  make({ kind: "integrate", options, waitForTaskToken: true });

/**
 * Run programs in parallel (an ASL `Parallel` state) — mirrors
 * `Effect.all`. The result is the tuple of branch results.
 */
export const all = <const T extends readonly SfnEffect<any, any>[]>(
  branches: T,
): SfnEffect<{ [K in keyof T]: Success<T[K]> }, ErrorOf<T[number]>> =>
  make({ kind: "all", branches });

/**
 * Apply `body` to every element of `items` (an ASL inline `Map` state) —
 * mirrors `Effect.forEach`, including the `concurrency` option
 * (`MaxConcurrency`). The result is the array of iteration results.
 */
export const forEach = <Item, A, E>(
  items: Expr<readonly Item[]> | Expr<Item[]>,
  body: (item: Expr<Item>) => SfnEffect<A, E>,
  options?: ForEachOptions,
): SfnEffect<A[], E> =>
  make({
    kind: "forEach",
    items: items as Expr<any>,
    body: body as (item: Expr<any>) => SfnEffect<any, any>,
    options: options ?? {},
  });

/**
 * Pause the workflow (an ASL `Wait` state) — mirrors `Effect.sleep`.
 * Durations round up to whole seconds (ASL's granularity).
 */
export const sleep = (duration: Duration.Input): SfnEffect<void> =>
  make({
    kind: "sleep",
    seconds: Math.max(1, Math.ceil(Duration.toSeconds(duration))),
  });

/**
 * Branch on a typed condition (an ASL `Choice` state) — mirrors
 * `Effect.if`. Build conditions with the typed comparators (`Sfn.eq`,
 * `Sfn.gt`, `Sfn.and`, …). When `onFalse` is omitted the false branch
 * produces `null`.
 */
export const when = <A, E, B = null, E2 = never>(
  condition: Expr<boolean>,
  onTrue: SfnEffect<A, E>,
  onFalse?: SfnEffect<B, E2>,
): SfnEffect<A | B, E | E2> =>
  make({ kind: "when", condition, onTrue, onFalse });

/**
 * Branch on a value's literal cases (an ASL `Choice` state with one rule
 * per case) — mirrors `Effect.match`-style dispatch. With no `otherwise`
 * and no matching case the execution fails with `States.NoChoiceMatched`.
 */
export const match = <
  T extends string | number | boolean,
  const Cases extends Record<string, SfnEffect<any, any>>,
  B = never,
  E2 = never,
>(
  value: Expr<T>,
  cases: Cases,
  otherwise?: SfnEffect<B, E2>,
): SfnEffect<
  Success<Cases[keyof Cases]> | B,
  ErrorOf<Cases[keyof Cases]> | E2
> => make({ kind: "match", value, cases, otherwise });

/**
 * Produce a value (an ASL `Pass` state) — mirrors `Effect.succeed`. The
 * value may embed typed `Expr` references from earlier steps.
 */
export const succeed = <const T>(value: T): SfnEffect<UnwrapExpr<T>> =>
  make({ kind: "succeed", value });

/**
 * Fail the workflow with a tagged error (an ASL `Fail` state) — mirrors
 * `Effect.fail`. The error's `_tag` becomes the ASL `Error` name, so
 * `Sfn.catchTag(program, tag, …)` and `Sfn.retry({ while: [tag] })` line up
 * with it end-to-end.
 */
export const fail = <E extends { readonly _tag: string }>(
  error: E,
  cause?: string,
): SfnEffect<never, E> =>
  make({
    kind: "fail",
    error: error._tag,
    cause: cause ?? (error as { message?: string }).message ?? error._tag,
    failure: error,
  });

/**
 * Retry a program on failure (ASL `Retry`) — mirrors `Effect.retry`, with
 * an option bag in the `Schedule.exponential` vocabulary (`initial`,
 * `backoff`, `maxAttempts`, `maxDelay`, `jitter`; `while` takes error
 * tags). Multi-state programs are wrapped in a single-branch `Parallel`
 * state so the whole program re-runs, matching `Effect.retry` semantics.
 */
export const retry: {
  (options: RetryOptions): <A, E>(self: SfnEffect<A, E>) => SfnEffect<A, E>;
  <A, E>(self: SfnEffect<A, E>, options: RetryOptions): SfnEffect<A, E>;
} = ((
  selfOrOptions: SfnEffect<any, any> | RetryOptions,
  options?: RetryOptions,
) =>
  isSfn(selfOrOptions)
    ? make({ kind: "retry", inner: selfOrOptions, options: options ?? {} })
    : (self: SfnEffect<any, any>) =>
        make({ kind: "retry", inner: self, options: selfOrOptions })) as any;

/**
 * Catch failures by tag (ASL `Catch` with `ErrorEquals`) — mirrors
 * `Effect.catchTag`, narrowing `E` exactly the same way. The handler
 * receives a typed reference to the ASL error output (`{ Error, Cause }`).
 */
export const catchTag: {
  <Tag extends string, A2, E2>(
    tag: Tag | readonly Tag[],
    handler: (error: Expr<ErrorOutput>) => SfnEffect<A2, E2>,
  ): <A, E>(
    self: SfnEffect<A, E>,
  ) => SfnEffect<A | A2, Exclude<E, { _tag: Tag }> | E2>;
  <A, E, Tag extends string, A2, E2>(
    self: SfnEffect<A, E>,
    tag: Tag | readonly Tag[],
    handler: (error: Expr<ErrorOutput>) => SfnEffect<A2, E2>,
  ): SfnEffect<A | A2, Exclude<E, { _tag: Tag }> | E2>;
} = ((...args: any[]) =>
  isSfn(args[0])
    ? make({
        kind: "catch",
        inner: args[0],
        tags: Array.isArray(args[1]) ? args[1] : [args[1]],
        handler: args[2],
      })
    : (self: SfnEffect<any, any>) =>
        make({
          kind: "catch",
          inner: self,
          tags: Array.isArray(args[0]) ? args[0] : [args[0]],
          handler: args[1],
        })) as any;

/**
 * Catch every failure (ASL `Catch` with `States.ALL`) — mirrors
 * `Effect.catchAll`.
 */
export const catchAll: {
  <A2, E2>(
    handler: (error: Expr<ErrorOutput>) => SfnEffect<A2, E2>,
  ): <A, E>(self: SfnEffect<A, E>) => SfnEffect<A | A2, E2>;
  <A, E, A2, E2>(
    self: SfnEffect<A, E>,
    handler: (error: Expr<ErrorOutput>) => SfnEffect<A2, E2>,
  ): SfnEffect<A | A2, E2>;
} = ((...args: any[]) =>
  isSfn(args[0])
    ? make({
        kind: "catch",
        inner: args[0],
        tags: ["States.ALL"],
        handler: args[1],
      })
    : (self: SfnEffect<any, any>) =>
        make({
          kind: "catch",
          inner: self,
          tags: ["States.ALL"],
          handler: args[0],
        })) as any;

/** The `States.*` built-in error names, for `retry`/`catchTag`. */
export const Errors = {
  ALL: "States.ALL",
  Timeout: "States.Timeout",
  TaskFailed: "States.TaskFailed",
  Permissions: "States.Permissions",
  BranchFailed: "States.BranchFailed",
  NoChoiceMatched: "States.NoChoiceMatched",
  IntrinsicFailure: "States.IntrinsicFailure",
  ExceedToleratedFailureThreshold: "States.ExceedToleratedFailureThreshold",
  ItemReaderFailed: "States.ItemReaderFailed",
  ResultWriterFailed: "States.ResultWriterFailed",
  HeartbeatTimeout: "States.HeartbeatTimeout",
  QueryEvaluationError: "States.QueryEvaluationError",
  Runtime: "States.Runtime",
} as const;
