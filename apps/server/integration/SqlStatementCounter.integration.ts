import * as Tracer from "effect/Tracer";

export interface SqlStatementCounter {
  readonly tracer: Tracer.Tracer;
  /** Statements executed so far. Read before and after a phase and subtract. */
  readonly count: () => number;
}

/**
 * Counts `sql.execute` spans, which the Effect SQL client opens once per
 * statement. Spans behave exactly as with the native tracer. Install the same
 * counter on every runtime under test, otherwise statements run by background
 * reactors and statements run by request handlers land in different counters.
 */
export function makeSqlStatementCounter(): SqlStatementCounter {
  let statements = 0;
  const tracer = Tracer.make({
    span: (options) => {
      if (options.name === "sql.execute") statements += 1;
      return new Tracer.NativeSpan(options);
    },
  });
  return { tracer, count: () => statements };
}
