/**
 * The Step Functions program AST.
 *
 * Every {@link SfnEffect} wraps exactly one of these nodes. The AST is plain
 * data with two interpreters: `compile.ts` (→ ASL definition +
 * policy statements) and `simulate.ts` (→ an in-process `Effect`).
 */
import type * as Duration from "effect/Duration";
import type * as Output from "../../../Output.ts";
import type { PolicyStatement } from "../../IAM/Policy.ts";
import type { Expr } from "./Jsonata.ts";
import type { SfnEffect } from "./Program.ts";

/**
 * The structural surface `Sfn.invoke` needs from a Lambda Function resource:
 * a stable logical id (simulation handler key + policy dedupe key) and the
 * function ARN (an `Output` inside a stack, a plain string in simulations).
 */
export interface InvokableFunction {
  readonly LogicalId: string;
  readonly functionArn: Output.Output<string, any> | string;
}

/** Options for an `Sfn.integrate` / `Sfn.waitForTaskToken` task state. */
export interface IntegrationOptions {
  /**
   * The optimized service-integration resource ARN, e.g.
   * `arn:aws:states:::sqs:sendMessage`. `Sfn.waitForTaskToken` appends the
   * `.waitForTaskToken` suffix automatically.
   */
  resource: string;
  /**
   * The task `Arguments`. `Expr` references compile to `{% ... %}` JSONata
   * strings; embedded `Output`s (queue URLs, table names) resolve at deploy.
   */
  arguments?: unknown;
  /**
   * IAM policy statements the execution role needs for this integration
   * (exact-ARN scoped by the caller).
   */
  policyStatements?: PolicyStatement[];
  /**
   * Task-level timeout (ASL `TimeoutSeconds`). Accepts any
   * `Duration.Input` (`"30 seconds"`, `Duration.minutes(5)`, millis);
   * rounded up to whole seconds (ASL's granularity).
   */
  timeout?: Duration.Input;
}

/** Options for `Sfn.retry` — mirrors the `Schedule.exponential` vocabulary. */
export interface RetryOptions {
  /**
   * Error names (tags) that are retried, mirroring `Effect.retry`'s `while`.
   * @default ["States.ALL"]
   */
  while?: string | string[];
  /** Initial retry interval (`IntervalSeconds`). @default "1 second" */
  initial?: Duration.Input;
  /** Backoff multiplier (`BackoffRate`). @default 2 */
  backoff?: number;
  /** Maximum retry attempts (`MaxAttempts`). @default 3 */
  maxAttempts?: number;
  /** Cap on the interval between retries (`MaxDelaySeconds`). */
  maxDelay?: Duration.Input;
  /** Apply full jitter to retry intervals (`JitterStrategy: "FULL"`). */
  jitter?: boolean;
}

/** Options for `Sfn.forEach`. */
export interface ForEachOptions {
  /** Maximum concurrent iterations (`MaxConcurrency`). */
  concurrency?: number;
}

export interface GenNode {
  readonly kind: "gen";
  /**
   * The user's generator. Re-invoked on every compile/simulate pass — each
   * `yield*` is fed a typed variable reference by the tracer.
   */
  readonly body: (input: Expr<any>) => Generator<SfnEffect<any, any>, any, any>;
}

export interface InvokeNode {
  readonly kind: "invoke";
  readonly fn: InvokableFunction;
  readonly payload: unknown;
}

export interface IntegrateNode {
  readonly kind: "integrate";
  readonly options: IntegrationOptions;
  readonly waitForTaskToken: boolean;
}

export interface AllNode {
  readonly kind: "all";
  readonly branches: readonly SfnEffect<any, any>[];
}

export interface ForEachNode {
  readonly kind: "forEach";
  readonly items: Expr<any>;
  readonly body: (item: Expr<any>) => SfnEffect<any, any>;
  readonly options: ForEachOptions;
}

export interface SleepNode {
  readonly kind: "sleep";
  readonly seconds: number;
}

export interface WhenNode {
  readonly kind: "when";
  readonly condition: Expr<boolean>;
  readonly onTrue: SfnEffect<any, any>;
  readonly onFalse: SfnEffect<any, any> | undefined;
}

export interface MatchNode {
  readonly kind: "match";
  readonly value: Expr<any>;
  readonly cases: Readonly<Record<string, SfnEffect<any, any>>>;
  readonly otherwise: SfnEffect<any, any> | undefined;
}

export interface SucceedNode {
  readonly kind: "succeed";
  readonly value: unknown;
}

export interface FailNode {
  readonly kind: "fail";
  /** The ASL `Error` name (the failure's `_tag`). */
  readonly error: string;
  /** The ASL `Cause` string. */
  readonly cause: string;
  /** The typed failure `simulate` fails with (when constructed from one). */
  readonly failure: unknown;
}

export interface RetryNode {
  readonly kind: "retry";
  readonly inner: SfnEffect<any, any>;
  readonly options: RetryOptions;
}

export interface CatchNode {
  readonly kind: "catch";
  readonly inner: SfnEffect<any, any>;
  /** Error names to catch — `["States.ALL"]` for `catchAll`. */
  readonly tags: readonly string[];
  /** Handler over the ASL error output (`{ Error, Cause }`). */
  readonly handler: (error: Expr<ErrorOutput>) => SfnEffect<any, any>;
}

/**
 * The shape ASL hands a Catch transition (`$states.errorOutput`): the error
 * name and its cause. For Lambda task failures `Cause` carries the
 * serialized exception.
 */
export interface ErrorOutput {
  readonly Error: string;
  readonly Cause: string;
}

export type AslNode =
  | GenNode
  | InvokeNode
  | IntegrateNode
  | AllNode
  | ForEachNode
  | SleepNode
  | WhenNode
  | MatchNode
  | SucceedNode
  | FailNode
  | RetryNode
  | CatchNode;
