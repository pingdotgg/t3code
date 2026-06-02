import type * as Tracer from "../Tracer.ts"

export interface ErrorWithStackTraceLimit {
  stackTraceLimit?: number | undefined
}

/** @internal */
export const addSpanStackTrace = <A extends Tracer.TraceOptions>(
  options: A | undefined
): A => {
  if (options?.captureStackTrace === false) {
    return options
  } else if (options?.captureStackTrace !== undefined && typeof options.captureStackTrace !== "boolean") {
    return options
  }
  const limit = (Error as ErrorWithStackTraceLimit).stackTraceLimit
  ;(Error as ErrorWithStackTraceLimit).stackTraceLimit = 3
  const traceError = new Error()
  ;(Error as ErrorWithStackTraceLimit).stackTraceLimit = limit
  return {
    ...options,
    captureStackTrace: spanCleaner(() => traceError.stack)
  } as A
}

/** @internal */
export const makeStackCleaner = (line: number) => (stack: () => string | undefined): () => string | undefined => {
  let cache: string | undefined
  return () => {
    if (cache !== undefined) return cache
    const trace = stack()
    if (!trace) return undefined
    const lines = trace.split("\n")
    if (lines[line] !== undefined) {
      cache = lines[line].trim()
      return cache
    }
  }
}

const spanCleaner = makeStackCleaner(3)
