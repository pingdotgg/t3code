import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

/**
 * The span a child process or RPC call runs under, so its records and spans
 * join the caller's trace instead of starting their own.
 */
export interface TraceParent {
  readonly traceId: string;
  readonly spanId: string;
}

/** Set on alchemy child processes to the trace they report under. */
export const TRACE_PARENT_ENV = "ALCHEMY_TRACE_PARENT";

const fromEnv = (): TraceParent | undefined => {
  const [traceId, spanId] = (process.env[TRACE_PARENT_ENV] ?? "").split("-");
  return traceId && spanId ? { traceId, spanId } : undefined;
};

/**
 * This process's trace, for records logged outside any span (startup,
 * shutdown, finalizers): the parent's when it passed one in
 * {@link TRACE_PARENT_ENV}, otherwise a new one. It ties a process's
 * untraced records together and to its parent's, without a span that would
 * stay open for the life of the process.
 */
export const processTrace: TraceParent = fromEnv() ?? {
  traceId: Hex.random(32),
  spanId: Hex.random(16),
};

/** The caller's current span, if it is in one. */
export const currentTraceParent: Effect.Effect<TraceParent | undefined> = Effect.map(
  Effect.option(Effect.currentParentSpan),
  Option.match({
    onNone: () => undefined,
    onSome: (span) => ({ traceId: span.traceId, spanId: span.spanId }),
  }),
);

/**
 * {@link TRACE_PARENT_ENV} for a child process: the current span, or this
 * process's trace outside one.
 */
export const traceParentEnv: Effect.Effect<Record<string, string>> = Effect.map(
  currentTraceParent,
  (parent = processTrace): Record<string, string> => ({
    [TRACE_PARENT_ENV]: `${parent.traceId}-${parent.spanId}`,
  }),
);

const spanOf = (parent: TraceParent) => Tracer.externalSpan({ ...parent, sampled: true });

/** Run `effect` as a child of `parent`, when there is one. */
export const withTraceParent =
  (parent: TraceParent | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    parent === undefined ? effect : Effect.withParentSpan(effect, spanOf(parent));

/** Run `stream` (its whole execution, not just its construction) as a child of `parent`. */
export const withStreamTraceParent =
  (parent: TraceParent | undefined) =>
  <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    parent === undefined
      ? stream
      : Stream.provideService(stream, Tracer.ParentSpan, spanOf(parent));
