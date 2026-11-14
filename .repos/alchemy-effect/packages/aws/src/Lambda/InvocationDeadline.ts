import type * as lambda from "aws-lambda";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { Flusher } from "effect/observability/OtlpExporter";
import * as Option from "effect/Option";

/**
 * The AWS Lambda invocation context — the `context` argument Lambda passes
 * to the handler. Provided to every invocation's effect by the Lambda
 * dispatcher (see `Function.ts`).
 */
export class HandlerContext extends Context.Service<HandlerContext, lambda.Context>()(
  "AWS.Lambda.HandlerContext",
) {}

/**
 * Environment variable the deploy side writes and the runtime reads per
 * invocation: the milliseconds between the Function's `timeout` and the
 * timeout Lambda is configured with. The runtime interrupts the handler that
 * long before Lambda would kill it. Unset or `0` → the handler is never
 * interrupted.
 */
export const TIMEOUT_GRACE_ENV = "ALCHEMY_LAMBDA_TIMEOUT_GRACE_MS";

/**
 * Default {@link FunctionCommonProps.timeoutMargin}: the time Lambda keeps
 * the invocation alive after the handler is interrupted, for finalizers and
 * the telemetry flush.
 */
export const DEFAULT_TIMEOUT_MARGIN_MS = 1000;

/**
 * How long before Lambda's hard timeout the backstop flush runs when
 * finalizers are still running (or the handler is not interrupted at all).
 * Wide enough for one OTLP export round-trip to a remote collector.
 */
export const BACKSTOP_FLUSH_MS = 500;

/**
 * Span attribute set on a root span the backstop flush ended early: the
 * invocation was still running moments before Lambda's hard timeout, so the
 * span was exported before Lambda could kill it.
 */
export const TIMEOUT_IMMINENT_ATTRIBUTE = "aws.lambda.timeout.imminent";

/**
 * The invocation ran past the Function's `timeout`. The runtime interrupts
 * the handler — so `acquireRelease`, `ensuring` and scope finalizers run, and
 * every open span ends — and fails the invocation with this error, which
 * becomes the status of the root span. The invocation is then held until
 * Lambda's own timeout ends it, so Lambda reports a real timeout.
 *
 * Also the status of a root span the backstop flush ends just before Lambda's
 * hard timeout.
 */
export class InvocationTimeoutError extends Data.TaggedError("AWS.Lambda.InvocationTimeoutError")<{
  readonly functionName: string;
  readonly requestId: string;
  /** Milliseconds the handler had been running when the deadline fired. */
  readonly budgetMs: number;
}> {
  override get message() {
    return `Lambda invocation ${this.requestId} of ${this.functionName} timed out after ${this.budgetMs}ms`;
  }
}

/**
 * Set by the deadline guard when it interrupts an invocation at the
 * Function's `timeout`. The dispatcher provides a fresh one per invocation
 * and, once finalizers have run and telemetry has flushed, holds a fired
 * invocation open until Lambda's own timeout ends it (see
 * {@link withInvocationDeadline}).
 */
export class InvocationDeadlineState extends Context.Service<
  InvocationDeadlineState,
  { fired: boolean }
>()("AWS.Lambda.InvocationDeadlineState") {}

interface Deadline {
  /** Tell the enclosing guard an inner guard now owns the deadline. */
  readonly claim: () => void;
}

/**
 * Internal handshake between nested deadline guards. The dispatcher guards
 * every listener; the HTTP listener guards again *inside* its `http.server`
 * span so the timeout ends that span; a durable listener guards again to opt
 * out of interruption. The inner guard claims the deadline and the outer one
 * stands down, so the deadline is enforced exactly once, by the innermost
 * guard.
 */
class InvocationDeadline extends Context.Service<InvocationDeadline, Deadline>()(
  "AWS.Lambda.InvocationDeadline",
) {}

/**
 * Parse the grace from its environment variable. Unset, unparseable or
 * negative → `0` (never interrupt).
 */
export const readTimeoutGrace = (raw: string | undefined): number => {
  if (raw === undefined || raw === "") return 0;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0;
};

/**
 * Normalize a `Duration` prop (`timeout`, `timeoutMargin`) to whole
 * milliseconds. Handles the state-JSON `Duration` shape
 * (`{_id:"Duration",_tag:"Millis"|"Nanos"|"Infinity",...}`), which is not a
 * valid `Duration.Input`. Infinite → `undefined` (default).
 */
export const toDurationMillis = (duration: Duration.Duration | undefined): number | undefined => {
  if (duration === undefined) return undefined;
  const json = duration as {
    _id?: unknown;
    _tag?: "Millis" | "Nanos" | "Infinity" | "NegativeInfinity";
    millis?: number;
    nanos?: string;
  };
  const input: Duration.Input =
    json._id === "Duration"
      ? json._tag === "Millis"
        ? json.millis!
        : json._tag === "Nanos"
          ? BigInt(json.nanos!)
          : "Infinity"
      : duration;
  const millis = Duration.toMillis(input);
  return Number.isFinite(millis) ? Math.max(0, Math.ceil(millis)) : undefined;
};

/** Lambda's maximum function timeout, in seconds. */
export const MAX_LAMBDA_TIMEOUT_SECONDS = 900;

/**
 * The function's `timeout` plus `timeoutMargin` does not fit in Lambda's
 * 900-second maximum.
 */
export class FunctionTimeoutTooLong extends Data.TaggedError("AWS.Lambda.FunctionTimeoutTooLong")<{
  readonly id: string;
  readonly timeoutMs: number;
  readonly marginMs: number;
}> {
  override get message() {
    return `Function(${this.id}): timeout (${this.timeoutMs}ms) plus timeoutMargin (${this.marginMs}ms) exceeds Lambda's ${MAX_LAMBDA_TIMEOUT_SECONDS}s maximum. Lower the timeout to ${MAX_LAMBDA_TIMEOUT_SECONDS * 1000 - this.marginMs}ms or less, or set timeoutMargin to Duration.zero to let Lambda kill the invocation at the timeout without interrupting it.`;
  }
}

/**
 * The Lambda configuration a Function's `timeout` and `timeoutMargin`
 * produce.
 *
 * With interruption on (`interrupt: true`, a non-zero margin), Lambda's
 * timeout is the Function's `timeout` plus the margin, rounded up to whole
 * seconds, and `graceMs` is the time between the two: the runtime
 * interrupts the handler at exactly `timeout` and Lambda kills it `graceMs`
 * later. A handler that would have finished inside `timeout` is never cut
 * short.
 *
 * Without it (a zero margin, or a handler alchemy's runtime does not run),
 * Lambda's timeout is `timeout` rounded up to whole seconds and `graceMs` is
 * `0`.
 */
export const lambdaTimeoutOf = (props: {
  id: string;
  timeout: Duration.Duration | undefined;
  timeoutMargin: Duration.Duration | undefined;
  interrupt: boolean;
}): Effect.Effect<{ timeoutSeconds: number; graceMs: number }, FunctionTimeoutTooLong> => {
  const timeoutMs = toDurationMillis(props.timeout) ?? 3000;
  const marginMs = props.interrupt
    ? (toDurationMillis(props.timeoutMargin) ?? DEFAULT_TIMEOUT_MARGIN_MS)
    : 0;
  const timeoutSeconds = Math.max(1, Math.ceil((timeoutMs + marginMs) / 1000));
  if (timeoutSeconds > MAX_LAMBDA_TIMEOUT_SECONDS && marginMs > 0) {
    return Effect.fail(new FunctionTimeoutTooLong({ id: props.id, timeoutMs, marginMs }));
  }
  return Effect.succeed({
    timeoutSeconds,
    graceMs: marginMs > 0 ? timeoutSeconds * 1000 - timeoutMs : 0,
  });
};

/**
 * Enforce the Function's `timeout` on an invocation, the way `runMain`
 * treats SIGTERM: interrupt the handler so its finalizers run and its spans
 * end, then let Lambda's extra margin carry the cleanup and the telemetry
 * flush.
 *
 * The deploy side configures Lambda's timeout as the Function's `timeout`
 * plus `timeoutMargin` and writes the difference to
 * `ALCHEMY_LAMBDA_TIMEOUT_GRACE_MS`. The deadline is known up front
 * (`context.getRemainingTimeInMillis()`), and a sandbox only ever handles
 * one invocation at a time, so the timers are race-free:
 *
 * 1. At `remaining - grace` — the Function's `timeout` — the handler is
 *    interrupted. `acquireRelease`, `ensuring` and scope finalizers run;
 *    every open span ends with the interruption, so the trace shows the
 *    call that hung. The invocation fails with {@link InvocationTimeoutError}
 *    and {@link InvocationDeadlineState} is marked fired. A handler that
 *    finishes before its `timeout` is never touched.
 * 2. The dispatcher closes the request scope (request finalizers, the
 *    telemetry flush) and then holds the invocation open instead of
 *    returning. Lambda's own timeout ends it: Lambda logs `Task timed out`,
 *    counts a timeout, retries as it would for any timeout, and resets the
 *    sandbox, so work that ignored the interruption (a promise without an
 *    `AbortSignal`, a connection left mid-query) can never resume in the
 *    next invocation. The cost is the unused rest of the margin, billed only
 *    on invocations that time out.
 * 3. At {@link BACKSTOP_FLUSH_MS} before Lambda's hard timeout, if the
 *    invocation is *still* running (a slow finalizer, an uninterruptible
 *    region, or interruption is off), the current root span is ended with
 *    {@link InvocationTimeoutError} and marked
 *    {@link TIMEOUT_IMMINENT_ATTRIBUTE}, a warning is logged, and every
 *    exporter is drained through the OTLP {@link Flusher} — so the trace is
 *    exported even if Lambda kills the process. This step never changes the
 *    invocation's outcome.
 *
 * `interrupt: false` keeps only step 3. Durable functions use it: their
 * invocations are replayed from checkpoints, and interrupting one would
 * leave the durable SDK's promise running.
 *
 * Without a `HandlerContext` (unit tests, non-Lambda hosts) the effect runs
 * unguarded.
 *
 * Guards nest: an inner guard (the HTTP listener's, placed inside the
 * `http.server` span so the timeout ends it; the durable listener's, which
 * turns interruption off) takes the deadline over from the outer one (the
 * dispatcher's), so the deadline is enforced once, by the innermost guard.
 */
export const withInvocationDeadline: {
  (options?: {
    readonly interrupt?: boolean;
  }): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E | InvocationTimeoutError, R>;
} =
  (options) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const context = Option.getOrUndefined(yield* Effect.serviceOption(HandlerContext));
      if (context === undefined || typeof context.getRemainingTimeInMillis !== "function") {
        return yield* self;
      }
      const remainingMs = context.getRemainingTimeInMillis();
      const graceMs =
        options?.interrupt === false ? 0 : readTimeoutGrace(process.env[TIMEOUT_GRACE_ENV]);
      const budgetMs = remainingMs - graceMs;
      // Leave room for the interrupt to land before the backstop; with no
      // grace the backstop carves its margin out of the budget, as before.
      const backstopMs =
        graceMs > 0 ? Math.min(BACKSTOP_FLUSH_MS, Math.floor(graceMs / 2)) : BACKSTOP_FLUSH_MS;
      const backstopAtMs = remainingMs - backstopMs;

      // Take the deadline over from any enclosing guard.
      const outer = yield* Effect.serviceOption(InvocationDeadline);
      if (Option.isSome(outer)) {
        outer.value.claim();
      }
      let claimed = false;
      const deadline: Deadline = {
        claim: () => {
          claimed = true;
        },
      };

      const timeoutError = new InvocationTimeoutError({
        functionName: context.functionName,
        requestId: context.awsRequestId,
        budgetMs,
      });

      const backstopFlush = Effect.gen(function* () {
        // The root span is still open (that is why we are here); end it so
        // it exports with the timeout as its status. Only `Span`s can be
        // ended — an external parent (a propagated `traceparent` with no
        // local span) is skipped.
        const span = yield* Effect.option(Effect.currentSpan);
        if (Option.isSome(span) && span.value.status._tag === "Started") {
          const root = span.value;
          root.attribute(TIMEOUT_IMMINENT_ATTRIBUTE, true);
          root.end(yield* Clock.currentTimeNanos, Exit.fail(timeoutError));
          // This export is the span's final record. Tracers export on every
          // `end`, so if the invocation finishes before Lambda kills it the
          // tracer's own `end` would ship the span a second time; drop it.
          root.end = () => {};
        }
        yield* Effect.logWarning(
          `Lambda invocation ${context.awsRequestId} of ${context.functionName} is still running ${backstopMs}ms before Lambda's timeout; telemetry was flushed early in case Lambda kills the invocation`,
        ).pipe(Effect.annotateLogs({ requestId: context.awsRequestId }));
        const flusher = yield* Effect.serviceOption(Flusher);
        if (Option.isSome(flusher)) {
          yield* flusher.value.flush;
        }
      });

      // The backstop inherits this fiber's context — the invocation's
      // logger, exporters and (on the HTTP path) the root span — and is
      // interrupted when the invocation settles. It is forked outside the
      // timeout below, so it keeps running while a slow finalizer holds up
      // the interrupted handler. The flush itself is uninterruptible so an
      // invocation finishing mid-flush waits for the export rather than
      // abandoning an in-flight batch.
      const backstop =
        backstopAtMs > 0
          ? yield* Effect.sleep(Duration.millis(backstopAtMs)).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  claimed ? Effect.void : Effect.uninterruptible(backstopFlush),
                ),
              ),
              Effect.forkChild,
            )
          : undefined;

      const guarded = self.pipe(Effect.provideService(InvocationDeadline, deadline));
      // Interrupt at the Function's `timeout`. The timer loses the race to
      // the handler once an inner guard claims the deadline — that guard
      // enforces it closer to the work, at the same instant — so the
      // deadline fails the invocation once, from the innermost guard. The
      // race interrupts the handler and waits for its finalizers.
      const timer = Effect.sleep(Duration.millis(budgetMs)).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            claimed
              ? Effect.never
              : Effect.logWarning(timeoutError.message).pipe(
                  Effect.annotateLogs({
                    requestId: timeoutError.requestId,
                    budgetMs: timeoutError.budgetMs,
                  }),
                  Effect.andThen(Effect.serviceOption(InvocationDeadlineState)),
                  Effect.tap((state) =>
                    Effect.sync(() => {
                      if (Option.isSome(state)) state.value.fired = true;
                    }),
                  ),
                  Effect.andThen(Effect.fail(timeoutError)),
                ),
          ),
        ),
      );
      return yield* (graceMs > 0 && budgetMs > 0 ? Effect.raceFirst(guarded, timer) : guarded).pipe(
        Effect.ensuring(backstop ? Fiber.interrupt(backstop) : Effect.void),
      );
    });
