import * as Tracer from "effect/Tracer";

export interface SqlStatementCounter {
  readonly tracer: Tracer.Tracer;
  readonly count: () => number;
}

/** Install on every test runtime to include background reactor statements. */
export function makeSqlStatementCounter(): SqlStatementCounter {
  let statements = 0;
  const tracer = Tracer.make({
    span: (options) => {
      if (options.kind === "client" && options.name === "sqlite") statements += 1;
      return new Tracer.NativeSpan(options);
    },
  });
  return { tracer, count: () => statements };
}
