import * as Context from "../Context.ts"
import type { ErrorReporter } from "../ErrorReporter.ts"
import { constTrue, constUndefined } from "../Function.ts"
import type { LogLevel, Severity } from "../LogLevel.ts"
import type { ReadonlyRecord } from "../Record.ts"
import type { StackFrame } from "../References.ts"
import type { SpanLink } from "../Tracer.ts"

/** @internal */
export const CurrentConcurrency = Context.Reference<"unbounded" | number>("effect/References/CurrentConcurrency", {
  defaultValue: () => "unbounded"
})

/** @internal */
export const CurrentErrorReporters = Context.Reference<ReadonlySet<ErrorReporter>>(
  "effect/ErrorReporter/CurrentErrorReporters",
  { defaultValue: () => new Set() }
)

/** @internal */
export const CurrentStackFrame = Context.Reference<StackFrame | undefined>("effect/References/CurrentStackFrame", {
  defaultValue: constUndefined
})

/** @internal */
export const TracerEnabled = Context.Reference<boolean>("effect/References/TracerEnabled", {
  defaultValue: constTrue
})

/** @internal */
export const TracerTimingEnabled = Context.Reference<boolean>("effect/References/TracerTimingEnabled", {
  defaultValue: constTrue
})

/** @internal */
export const TracerSpanAnnotations = Context.Reference<ReadonlyRecord<string, unknown>>(
  "effect/References/TracerSpanAnnotations",
  { defaultValue: () => ({}) }
)

/** @internal */
export const TracerSpanLinks = Context.Reference<ReadonlyArray<SpanLink>>("effect/References/TracerSpanLinks", {
  defaultValue: () => []
})

/** @internal */
export const CurrentLogAnnotations = Context.Reference<ReadonlyRecord<string, unknown>>(
  "effect/References/CurrentLogAnnotations",
  { defaultValue: () => ({}) }
)

/** @internal */
export const CurrentLogLevel: Context.Reference<Severity> = Context.Reference<Severity>(
  "effect/References/CurrentLogLevel",
  { defaultValue: () => "Info" }
)

/** @internal */
export const MinimumLogLevel = Context.Reference<
  LogLevel
>("effect/References/MinimumLogLevel", { defaultValue: () => "Info" })

/** @internal */
export const UnhandledLogLevel: Context.Reference<Severity | undefined> = Context.Reference(
  "effect/References/UnhandledLogLevel",
  { defaultValue: (): Severity | undefined => "Error" }
)

/** @internal */
export const CurrentLogSpans = Context.Reference<
  ReadonlyArray<[label: string, timestamp: number]>
>("effect/References/CurrentLogSpans", { defaultValue: () => [] })
