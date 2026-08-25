import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * Retry policy for a durable step. Maps onto the Durable Execution SDK's
 * `retryStrategy` — the delay grows per the configured backoff between
 * attempts, and the step fails the execution once `limit` retries are
 * exhausted.
 */
export interface DurableRetryPolicy {
  /**
   * Maximum number of RETRIES after the first attempt (a step with
   * `limit: 2` runs at most 3 times).
   */
  limit: number;
  /**
   * Delay before the first retry.
   * @default 1 second
   */
  delay?: Duration.Input;
  /**
   * Backoff shape applied to `delay` across attempts.
   * @default "exponential"
   */
  backoff?: "constant" | "linear" | "exponential";
  /**
   * Upper bound on the computed delay.
   */
  maxDelay?: Duration.Input;
}

/**
 * Configuration for a durable {@link step}.
 */
export interface DurableStepConfig {
  /**
   * Retry policy applied when the step's effect dies. Omit for the SDK's
   * default behavior.
   */
  retry?: DurableRetryPolicy;
  /**
   * Checkpoint semantics for the step body.
   *
   * - `"at-least-once"` (default) — the body may re-run if the invocation is
   *   interrupted before the checkpoint lands; the body must be idempotent.
   * - `"at-most-once"` — the step is checkpointed as started before the body
   *   runs; an interruption surfaces as a `StepInterruptedError` instead of a
   *   silent re-run.
   */
  semantics?: "at-least-once" | "at-most-once";
}

/**
 * Configuration for {@link waitForCallback}.
 */
export interface DurableCallbackConfig {
  /**
   * How long to wait for the external system to complete the callback before
   * the operation fails.
   */
  timeout?: Duration.Input;
  /**
   * Maximum silence between `SendDurableExecutionCallbackHeartbeat` calls
   * before the callback is considered lost.
   */
  heartbeatTimeout?: Duration.Input;
}

/**
 * Internal descriptor passed from {@link step} to the bridge. Bundles the
 * step name and (fully-provided) Effect together with the step config.
 */
export interface DurableStepOptions<
  Output = unknown,
> extends DurableStepConfig {
  name: string;
  effect: Effect.Effect<Output>;
}

/**
 * Internal descriptor passed from {@link waitForCallback} to the bridge.
 */
export interface DurableCallbackOptions extends DurableCallbackConfig {
  name: string;
  /**
   * Runs exactly once (checkpointed) with the callback id; hand the id to the
   * external system that will complete the callback via
   * `SendDurableExecutionCallbackSuccess`/`Failure`.
   */
  submitter: (callbackId: string) => Effect.Effect<void>;
}

/**
 * Internal service that wraps the AWS Durable Execution SDK's
 * `DurableContext`. Not accessed directly by users — use {@link step},
 * {@link sleep}, and {@link waitForCallback} instead.
 */
export class DurableStep extends Context.Service<
  DurableStep,
  {
    step<T>(options: DurableStepOptions<T>): Effect.Effect<T>;
    wait(name: string, duration: Duration.Input): Effect.Effect<void>;
    waitForCallback<T>(options: DurableCallbackOptions): Effect.Effect<T>;
  }
>()("AWS.Lambda.DurableStep") {}

/**
 * Runtime information about the current durable execution.
 * `yield* DurableExecutionContext` inside a durable function body.
 */
export class DurableExecutionContext extends Context.Service<
  DurableExecutionContext,
  {
    /**
     * ARN uniquely identifying this durable execution instance. Stable across
     * every suspend/resume invocation of the same execution.
     */
    executionArn: string;
  }
>()("AWS.Lambda.DurableExecutionContext") {}

/**
 * Execute a named, durable step. The effect runs inside the AWS Durable
 * Execution checkpoint protocol: its result is persisted after first
 * completion and replayed (without re-executing) on every subsequent
 * invocation of the execution.
 *
 * Any services the inner effect requires (e.g. binding clients resolved in
 * the durable function's init phase) are threaded through automatically by
 * capturing the surrounding body's context and providing it to the inner
 * effect before it is handed to the SDK.
 *
 * Determinism law: all effectful/non-deterministic work (time, randomness,
 * I/O, SDK calls) must live INSIDE a step — code between steps re-runs on
 * every replay and must be a pure function of the input and prior step
 * results.
 */
export function step<T, R = never>(
  name: string,
  effect: Effect.Effect<T, never, R>,
  config?: DurableStepConfig,
): Effect.Effect<T, never, DurableStep | R> {
  return Effect.gen(function* () {
    const durable = yield* DurableStep;
    const context = yield* Effect.context<R>();
    return yield* durable.step({
      ...config,
      name,
      effect: effect.pipe(Effect.provide(context)),
    });
  });
}

/**
 * Pause the durable execution for the given duration. The invocation is
 * checkpointed and terminated — no compute is billed while suspended — and
 * Lambda re-invokes the function when the timer fires.
 */
export const sleep = (
  name: string,
  duration: Duration.Input,
): Effect.Effect<void, never, DurableStep> =>
  Effect.gen(function* () {
    const durable = yield* DurableStep;
    yield* durable.wait(name, duration);
  });

/**
 * Suspend the durable execution until an external system completes the
 * callback via `SendDurableExecutionCallbackSuccess` (or fails it via
 * `...Failure`). The `submitter` effect runs exactly once (checkpointed) and
 * receives the callback id to hand to the external system.
 */
export const waitForCallback = <T = unknown, R = never>(
  name: string,
  submitter: (callbackId: string) => Effect.Effect<void, never, R>,
  config?: DurableCallbackConfig,
): Effect.Effect<T, never, DurableStep | R> =>
  Effect.gen(function* () {
    const durable = yield* DurableStep;
    const context = yield* Effect.context<R>();
    return yield* durable.waitForCallback<T>({
      ...config,
      name,
      submitter: (callbackId) =>
        submitter(callbackId).pipe(Effect.provide(context)),
    });
  });
