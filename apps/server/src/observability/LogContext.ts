/**
 * LogContext - Unified correlation IDs across logs, spans, and provider
 * event streams.
 *
 * Provides a `Context.Reference` (the Effect 4 replacement for `FiberRef`)
 * that holds the active `sessionId`/`threadId`/`provider` triple. Call
 * `withLogContext` once at a boundary (a provider session starting, a turn
 * being sent, a WS command being handled) and every downstream `Effect.log*`
 * call and span annotation in that fiber - and any fiber forked from it -
 * automatically carries the same correlation fields. Nothing deeper in the
 * call stack needs to call `Effect.annotateLogs`/`annotateCurrentSpan`
 * itself.
 *
 * @module observability/LogContext
 */
import { Context, Effect } from "effect";

export interface LogContextShape {
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly provider?: string;
}

const emptyLogContext: LogContextShape = {};

/**
 * Context reference holding the correlation IDs for the active fiber. Reads
 * default to `{}` so any code path can safely read it even before a boundary
 * has called `withLogContext`.
 */
export const CurrentLogContext = Context.Reference<LogContextShape>(
  "t3/observability/CurrentLogContext",
  { defaultValue: () => emptyLogContext },
);

/** Reads the correlation IDs active on the current fiber. */
export const currentLogContext: Effect.Effect<LogContextShape> = Effect.service(CurrentLogContext);

const toLogAnnotations = (context: LogContextShape): Record<string, string> => {
  const annotations: Record<string, string> = {};
  if (context.sessionId !== undefined) annotations.sessionId = context.sessionId;
  if (context.threadId !== undefined) annotations.threadId = context.threadId;
  if (context.provider !== undefined) annotations.provider = context.provider;
  return annotations;
};

/**
 * Merges `patch` into the active `LogContext` for the duration of `effect`,
 * and tags every log line and the current span with the merged fields. Set
 * this once at a boundary (provider session start, turn dispatch, WS command
 * handling); nested effects and forked fibers inherit it without any further
 * annotation calls.
 */
export const withLogContext =
  (patch: LogContextShape) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const previous = yield* currentLogContext;
      const merged = { ...previous, ...patch };
      const annotations = toLogAnnotations(merged);

      // `annotateCurrentSpan` is itself an effect (it tags whatever span is
      // active at the call site), so it runs as its own statement rather
      // than as a pipeable combinator.
      yield* Effect.annotateCurrentSpan(annotations);

      return yield* effect.pipe(
        Effect.updateService(CurrentLogContext, () => merged),
        Effect.annotateLogs(annotations),
      );
    });
