/**
 * The `Cron` module provides utilities for representing recurring calendar
 * schedules with cron expressions. A `Cron` value stores allowed seconds,
 * minutes, hours, days of month, months, weekdays, and an optional time zone,
 * then uses those constraints to test dates and find scheduled occurrences.
 *
 * **Mental model**
 *
 * - A cron schedule is a set of allowed values for each time field
 * - Expressions may use five fields (`minute hour day month weekday`) or six
 *   fields (`second minute hour day month weekday`); five-field expressions
 *   default seconds to `0`
 * - Each field supports `*`, comma-separated values, ranges, and step syntax
 * - Month and weekday fields support aliases such as `JAN`, `DEC`, `SUN`, and
 *   `MON`
 * - Empty internal field sets represent an unconstrained field, the same idea
 *   as `*`
 * - When both day-of-month and weekday are constrained, matching uses cron's
 *   inclusive behavior: either field may match
 *
 * **Common tasks**
 *
 * - Build directly from field constraints: {@link make}
 * - Parse expressions safely: {@link parse}
 * - Parse expressions and throw on invalid input: {@link parseUnsafe}
 * - Check whether a date satisfies a schedule: {@link match}
 * - Find adjacent scheduled dates: {@link next}, {@link prev}
 * - Iterate future scheduled dates: {@link sequence}
 * - Compare schedule constraints: {@link equals}, {@link Equivalence}
 * - Detect parse failures: {@link CronParseError}, {@link isCronParseError}
 *
 * **Gotchas**
 *
 * - Weekdays are numbered `0` through `6`, with `0` representing Sunday
 * - Months are numbered `1` through `12`, while JavaScript `Date` months are
 *   zero-based
 * - `*` normalizes to an empty set internally, so inspect schedules with the
 *   public helpers instead of assuming every allowed value is stored
 * - `next` and `prev` search strictly after or before the provided instant
 * - Time-zone-aware schedules account for daylight saving transitions; during
 *   a fall-back transition, repeated local times are emitted once when moving
 *   forward
 *
 * @since 2.0.0
 */
import * as Arr from "./Array.ts"
import * as Data from "./Data.ts"
import type * as DateTime from "./DateTime.ts"
import * as Equal from "./Equal.ts"
import * as Equ from "./Equivalence.ts"
import { format } from "./Formatter.ts"
import { constVoid, dual, pipe } from "./Function.ts"
import * as Hash from "./Hash.ts"
import { type Inspectable, NodeInspectSymbol } from "./Inspectable.ts"
import * as dateTime from "./internal/dateTime.ts"
import * as N from "./Number.ts"
import * as Option from "./Option.ts"
import { type Pipeable, pipeArguments } from "./Pipeable.ts"
import { hasProperty } from "./Predicate.ts"
import * as Result from "./Result.ts"
import * as String from "./String.ts"
import type { Mutable } from "./Types.ts"

const TypeId = "~effect/time/Cron"

/**
 * Represents a cron schedule with time constraints and timezone information.
 *
 * **When to use**
 *
 * Use to represent a recurring calendar schedule that can be matched against
 * dates or used to compute scheduled occurrences.
 *
 * **Details**
 *
 * A `Cron` instance defines when a scheduled task should run, supporting
 * seconds, minutes, hours, days, months, and weekday constraints. It also
 * supports timezone-aware scheduling.
 *
 * **Example** (Creating a cron schedule)
 *
 * ```ts
 * import { Cron } from "effect"
 *
 * // Create a cron that runs at 9 AM on weekdays
 * const weekdayMorning = Cron.make({
 *   minutes: [0],
 *   hours: [9],
 *   days: [
 *     1,
 *     2,
 *     3,
 *     4,
 *     5,
 *     6,
 *     7,
 *     8,
 *     9,
 *     10,
 *     11,
 *     12,
 *     13,
 *     14,
 *     15,
 *     16,
 *     17,
 *     18,
 *     19,
 *     20,
 *     21,
 *     22,
 *     23,
 *     24,
 *     25,
 *     26,
 *     27,
 *     28,
 *     29,
 *     30,
 *     31
 *   ],
 *   months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
 *   weekdays: [1, 2, 3, 4, 5] // Monday to Friday
 * })
 *
 * // Check if a date matches the schedule
 * const matches = Cron.match(weekdayMorning, new Date("2023-06-05T09:00:00"))
 * console.log(matches) // true if it's 9 AM on a weekday
 * ```
 *
 * @see {@link make} for creating a schedule from explicit field constraints
 * @see {@link parse} for creating a schedule from a cron expression string
 * @see {@link match} for testing a date against a schedule
 * @see {@link next} for finding the next scheduled occurrence
 *
 * @category models
 * @since 2.0.0
 */
export interface Cron extends Pipeable, Equal.Equal, Inspectable {
  readonly [TypeId]: typeof TypeId
  readonly tz: Option.Option<DateTime.TimeZone>
  readonly seconds: ReadonlySet<number>
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly days: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly weekdays: ReadonlySet<number>
  /** @internal */
  readonly first: {
    readonly second: number
    readonly minute: number
    readonly hour: number
    readonly day: number
    readonly month: number
    readonly weekday: number
  }
  /** @internal */
  readonly last: {
    readonly second: number
    readonly minute: number
    readonly hour: number
    readonly day: number
    readonly month: number
    readonly weekday: number
  }
  /** @internal */
  readonly next: {
    readonly second: ReadonlyArray<number | undefined>
    readonly minute: ReadonlyArray<number | undefined>
    readonly hour: ReadonlyArray<number | undefined>
    readonly day: ReadonlyArray<number | undefined>
    readonly month: ReadonlyArray<number | undefined>
    readonly weekday: ReadonlyArray<number | undefined>
  }
  /** @internal */
  readonly prev: {
    readonly second: ReadonlyArray<number | undefined>
    readonly minute: ReadonlyArray<number | undefined>
    readonly hour: ReadonlyArray<number | undefined>
    readonly day: ReadonlyArray<number | undefined>
    readonly month: ReadonlyArray<number | undefined>
    readonly weekday: ReadonlyArray<number | undefined>
  }
}

function toPojo(cron: Cron): Record<string, unknown> {
  return {
    tz: cron.tz,
    seconds: Arr.fromIterable(cron.seconds),
    minutes: Arr.fromIterable(cron.minutes),
    hours: Arr.fromIterable(cron.hours),
    days: Arr.fromIterable(cron.days),
    months: Arr.fromIterable(cron.months),
    weekdays: Arr.fromIterable(cron.weekdays)
  }
}

const CronProto = {
  [TypeId]: TypeId,
  [Equal.symbol](this: Cron, that: unknown) {
    return isCron(that) && equals(this, that)
  },
  [Hash.symbol](this: Cron): number {
    return pipe(
      Hash.hash(this.tz),
      Hash.combine(Hash.array(Arr.fromIterable(this.seconds))),
      Hash.combine(Hash.array(Arr.fromIterable(this.minutes))),
      Hash.combine(Hash.array(Arr.fromIterable(this.hours))),
      Hash.combine(Hash.array(Arr.fromIterable(this.days))),
      Hash.combine(Hash.array(Arr.fromIterable(this.months))),
      Hash.combine(Hash.array(Arr.fromIterable(this.weekdays)))
    )
  },
  toObject(this: Cron) {
    return {
      tz: this.tz,
      seconds: Arr.fromIterable(this.seconds),
      minutes: Arr.fromIterable(this.minutes),
      hours: Arr.fromIterable(this.hours),
      days: Arr.fromIterable(this.days),
      months: Arr.fromIterable(this.months),
      weekdays: Arr.fromIterable(this.weekdays)
    }
  },
  toString(this: Cron) {
    return `Cron(${format(toPojo(this))})`
  },
  toJSON(this: Cron) {
    const out = toPojo(this)
    out["_id"] = "Cron"
    return out
  },
  [NodeInspectSymbol](this: Cron) {
    return this.toJSON()
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

/**
 * Checks whether a given value is a Cron instance.
 *
 * **When to use**
 *
 * Use to narrow an unknown value before treating it as a `Cron` schedule.
 *
 * **Details**
 *
 * This function is a type guard that determines whether the provided
 * value is a valid Cron instance by checking for the presence of the
 * Cron type identifier.
 *
 * **Example** (Checking cron values)
 *
 * ```ts
 * import { Cron } from "effect"
 *
 * const cron = Cron.make({
 *   minutes: [0],
 *   hours: [9],
 *   days: [1, 15],
 *   months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
 *   weekdays: [1, 2, 3, 4, 5]
 * })
 *
 * console.log(Cron.isCron(cron)) // true
 * console.log(Cron.isCron({})) // false
 * console.log(Cron.isCron("not a cron")) // false
 * ```
 *
 * @see {@link make} for constructing a `Cron` value directly
 * @see {@link parse} for constructing a `Cron` value from a string
 *
 * @category guards
 * @since 2.0.0
 */
export const isCron = (u: unknown): u is Cron => hasProperty(u, TypeId)

/**
 * Creates a Cron instance from time constraints.
 *
 * **When to use**
 *
 * Use to build a cron schedule from explicit sets of allowed time-field values.
 *
 * **Details**
 *
 * Constructs a cron schedule by specifying which seconds, minutes, hours,
 * days, months, and weekdays the schedule should match. Empty arrays mean
 * "match all" for that time unit.
 *
 * **Example** (Creating schedules from constraints)
 *
 * ```ts
 * import { Cron } from "effect"
 *
 * // Every day at midnight
 * const midnight = Cron.make({
 *   minutes: [0],
 *   hours: [0],
 *   days: [
 *     1,
 *     2,
 *     3,
 *     4,
 *     5,
 *     6,
 *     7,
 *     8,
 *     9,
 *     10,
 *     11,
 *     12,
 *     13,
 *     14,
 *     15,
 *     16,
 *     17,
 *     18,
 *     19,
 *     20,
 *     21,
 *     22,
 *     23,
 *     24,
 *     25,
 *     26,
 *     27,
 *     28,
 *     29,
 *     30,
 *     31
 *   ],
 *   months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
 *   weekdays: [0, 1, 2, 3, 4, 5, 6]
 * })
 *
 * // Every 15 minutes during business hours on weekdays
 * const businessHours = Cron.make({
 *   minutes: [0, 15, 30, 45],
 *   hours: [9, 10, 11, 12, 13, 14, 15, 16, 17],
 *   days: [
 *     1,
 *     2,
 *     3,
 *     4,
 *     5,
 *     6,
 *     7,
 *     8,
 *     9,
 *     10,
 *     11,
 *     12,
 *     13,
 *     14,
 *     15,
 *     16,
 *     17,
 *     18,
 *     19,
 *     20,
 *     21,
 *     22,
 *     23,
 *     24,
 *     25,
 *     26,
 *     27,
 *     28,
 *     29,
 *     30,
 *     31
 *   ],
 *   months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
 *   weekdays: [1, 2, 3, 4, 5] // Monday to Friday
 * })
 * ```
 *
 * @see {@link parse} for building a schedule from a cron expression string
 *
 * @category constructors
 * @since 2.0.0
 */
export const make = (values: {
  readonly seconds?: Iterable<number> | undefined
  readonly minutes: Iterable<number>
  readonly hours: Iterable<number>
  readonly days: Iterable<number>
  readonly months: Iterable<number>
  readonly weekdays: Iterable<number>
  readonly tz?: DateTime.TimeZone | undefined
}): Cron => {
  const o: Mutable<Cron> = Object.create(CronProto)
  o.seconds = new Set(Arr.sort(values.seconds ?? [0], N.Order))
  o.minutes = new Set(Arr.sort(values.minutes, N.Order))
  o.hours = new Set(Arr.sort(values.hours, N.Order))
  o.days = new Set(Arr.sort(values.days, N.Order))
  o.months = new Set(Arr.sort(values.months, N.Order))
  o.weekdays = new Set(Arr.sort(values.weekdays, N.Order))
  o.tz = Option.fromUndefinedOr(values.tz)

  const seconds = Array.from(o.seconds)
  const minutes = Array.from(o.minutes)
  const hours = Array.from(o.hours)
  const days = Array.from(o.days)
  const months = Array.from(o.months)
  const weekdays = Array.from(o.weekdays)

  o.first = {
    second: seconds[0] ?? 0,
    minute: minutes[0] ?? 0,
    hour: hours[0] ?? 0,
    day: days[0] ?? 1,
    month: (months[0] ?? 1) - 1,
    weekday: weekdays[0] ?? 0
  }

  o.last = {
    second: seconds[seconds.length - 1] ?? 59,
    minute: minutes[minutes.length - 1] ?? 59,
    hour: hours[hours.length - 1] ?? 23,
    day: days[days.length - 1] ?? 31,
    month: (months[months.length - 1] ?? 12) - 1,
    weekday: weekdays[weekdays.length - 1] ?? 6
  }

  o.next = {
    second: lookupTable(seconds, 60, "next"),
    minute: lookupTable(minutes, 60, "next"),
    hour: lookupTable(hours, 24, "next"),
    day: lookupTable(days, 32, "next"),
    month: lookupTable(months, 13, "next"),
    weekday: lookupTable(weekdays, 7, "next")
  }

  o.prev = {
    second: lookupTable(seconds, 60, "prev"),
    minute: lookupTable(minutes, 60, "prev"),
    hour: lookupTable(hours, 24, "prev"),
    day: lookupTable(days, 32, "prev"),
    month: lookupTable(months, 13, "prev"),
    weekday: lookupTable(weekdays, 7, "prev")
  }

  return o
}

const lookupTable = (
  values: ReadonlyArray<number>,
  size: number,
  dir: "next" | "prev"
): Array<number | undefined> => {
  const result = new Array(size).fill(undefined)
  if (values.length === 0) {
    return result
  }

  let current: number | undefined = undefined

  if (dir === "next") {
    let index = values.length - 1
    for (let i = size - 1; i >= 0; i--) {
      while (index >= 0 && values[index] >= i) {
        current = values[index--]
      }
      result[i] = current
    }
  } else {
    let index = 0
    for (let i = 0; i < size; i++) {
      while (index < values.length && values[index] <= i) {
        current = values[index++]
      }
      result[i] = current
    }
  }

  return result
}

const CronParseErrorTypeId = "~effect/time/Cron/CronParseError"

/**
 * Represents an error that occurs when parsing a cron expression fails.
 *
 * **When to use**
 *
 * Use to handle invalid cron expression failures returned by `parse`.
 *
 * **Details**
 *
 * This error provides information about what went wrong during parsing,
 * including the error message and optionally the input that caused the error.
 *
 * **Example** (Handling cron parse failures)
 *
 * ```ts
 * import { Cron, Result } from "effect"
 *
 * const result = Cron.parse("invalid expression")
 * if (Result.isFailure(result)) {
 *   const error: Cron.CronParseError = result.failure
 *   console.log(error.message) // "Invalid number of segments in cron expression"
 *   console.log(error.input) // "invalid expression"
 * }
 * ```
 *
 * @see {@link parse} for the parser that returns this error in `Result.fail`
 * @see {@link isCronParseError} for narrowing unknown values to this error type
 *
 * @category models
 * @since 4.0.0
 */
export class CronParseError extends Data.TaggedError("CronParseError")<{
  readonly message: string
  readonly input?: string
}> {
  readonly [CronParseErrorTypeId]: typeof CronParseErrorTypeId = CronParseErrorTypeId
}

/**
 * Checks whether a given value is a CronParseError instance.
 *
 * **When to use**
 *
 * Use to narrow an unknown failure before handling it as a cron parse error.
 *
 * **Details**
 *
 * This function is a type guard that determines whether the provided
 * value is a CronParseError by checking for the presence of the
 * CronParseError type identifier.
 *
 * **Example** (Checking cron parse errors)
 *
 * ```ts
 * import { Cron, Result } from "effect"
 *
 * const result = Cron.parse("invalid cron expression")
 * if (Result.isFailure(result)) {
 *   const error = result.failure
 *   console.log(Cron.isCronParseError(error)) // true
 * }
 *
 * console.log(Cron.isCronParseError(new Error("regular error"))) // false
 * console.log(Cron.isCronParseError("not an error")) // false
 * ```
 *
 * @see {@link CronParseError} for the parse error type
 * @see {@link parse} for producing `CronParseError` values on invalid input
 *
 * @category guards
 * @since 4.0.0
 */
export const isCronParseError = (u: unknown): u is CronParseError => hasProperty(u, CronParseErrorTypeId)

/**
 * Parses a cron expression safely into a `Cron` instance, returning a `Result`
 * instead of throwing.
 *
 * **When to use**
 *
 * Use to parse cron expressions from configuration or user input while handling
 * invalid input as a `Result`.
 *
 * **Details**
 *
 * The expression may contain five fields, where seconds default to `0`, or six
 * fields including seconds. Fields support `*`, comma-separated values, ranges,
 * steps, and month or weekday aliases. Invalid expressions fail with
 * `CronParseError`.
 *
 * **Example** (Parsing cron expressions)
 *
 * ```ts
 * import { Cron, Result } from "effect"
 * import * as assert from "node:assert"
 *
 * // At 04:00 on every day-of-month from 8 through 14.
 * assert.deepStrictEqual(
 *   Cron.parse("0 0 4 8-14 * *"),
 *   Result.succeed(Cron.make({
 *     seconds: [0],
 *     minutes: [0],
 *     hours: [4],
 *     days: [8, 9, 10, 11, 12, 13, 14],
 *     months: [],
 *     weekdays: []
 *   }))
 * )
 * ```
 *
 * @see {@link parseUnsafe} for throwing on invalid cron expressions
 * @see {@link make} for constructing a schedule from explicit field constraints
 *
 * @category constructors
 * @since 2.0.0
 */
export const parse = (cron: string, tz?: DateTime.TimeZone | string): Result.Result<Cron, CronParseError> => {
  const segments = cron.split(" ").filter(String.isNonEmpty)
  if (segments.length !== 5 && segments.length !== 6) {
    return Result.fail(new CronParseError({ message: `Invalid number of segments in cron expression`, input: cron }))
  }

  if (segments.length === 5) {
    segments.unshift("0")
  }

  const [seconds, minutes, hours, days, months, weekdays] = segments
  const zone = tz === undefined || dateTime.isTimeZone(tz) ?
    Result.succeed(tz) :
    Result.fromOption(
      dateTime.zoneFromString(tz),
      () => new CronParseError({ message: `Invalid time zone in cron expression`, input: tz })
    )

  return Result.all({
    tz: zone,
    seconds: parseSegment(seconds, secondOptions),
    minutes: parseSegment(minutes, minuteOptions),
    hours: parseSegment(hours, hourOptions),
    days: parseSegment(days, dayOptions),
    months: parseSegment(months, monthOptions),
    weekdays: parseSegment(weekdays, weekdayOptions)
  }).pipe(Result.map(make))
}

/**
 * Parses a cron expression into a `Cron` instance, throwing on failure.
 *
 * **When to use**
 *
 * Use when the input is expected to be valid and you want to avoid
 * handling the `Result` type.
 *
 * **Example** (Parsing cron expressions unsafely)
 *
 * ```ts
 * import { Cron } from "effect"
 *
 * // At 04:00 on every day-of-month from 8 through 14
 * const cron = Cron.parseUnsafe("0 0 4 8-14 * *")
 *
 * // With timezone
 * const cronWithTz = Cron.parseUnsafe("0 0 9 * * *", "America/New_York")
 *
 * // This would throw an error
 * // const invalid = Cron.parseUnsafe("invalid expression")
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const parseUnsafe = (cron: string, tz?: DateTime.TimeZone | string): Cron => Result.getOrThrow(parse(cron, tz))

/**
 * Returns `true` when a date/time matches a `Cron` schedule.
 *
 * **When to use**
 *
 * Use to test whether a specific date/time satisfies a cron schedule.
 *
 * **Details**
 *
 * Seconds, minutes, hours, months, and the optional timezone are checked
 * directly. For day constraints, an empty `days` or `weekdays` set means that
 * field matches every value; when both sets are non-empty, a date matches if
 * either the day-of-month or weekday matches.
 *
 * **Example** (Matching dates against a schedule)
 *
 * ```ts
 * import { Cron, Result } from "effect"
 *
 * const cron = Result.getOrThrow(Cron.parse("0 0 4 8-14 * *"))
 *
 * // Check if specific dates match
 * const matches1 = Cron.match(cron, new Date("2021-01-08T04:00:00Z"))
 * console.log(matches1) // true - 4 AM on the 8th
 *
 * const matches2 = Cron.match(cron, new Date("2021-01-08T05:00:00Z"))
 * console.log(matches2) // false - wrong hour
 *
 * const matches3 = Cron.match(cron, new Date("2021-01-07T04:00:00Z"))
 * console.log(matches3) // false - wrong day
 * ```
 *
 * @see {@link next} for finding the next matching date/time
 * @see {@link prev} for finding the previous matching date/time
 *
 * @category utils
 * @since 2.0.0
 */
export const match = (cron: Cron, date: DateTime.DateTime.Input): boolean => {
  const parts = dateTime.makeZonedUnsafe(date, {
    timeZone: Option.getOrUndefined(cron.tz)
  }).pipe(dateTime.toParts)

  if (cron.seconds.size !== 0 && !cron.seconds.has(parts.second)) {
    return false
  }

  if (cron.minutes.size !== 0 && !cron.minutes.has(parts.minute)) {
    return false
  }

  if (cron.hours.size !== 0 && !cron.hours.has(parts.hour)) {
    return false
  }

  if (cron.months.size !== 0 && !cron.months.has(parts.month)) {
    return false
  }

  if (cron.days.size === 0 && cron.weekdays.size === 0) {
    return true
  }

  if (cron.weekdays.size === 0) {
    return cron.days.has(parts.day)
  }

  if (cron.days.size === 0) {
    return cron.weekdays.has(parts.weekDay)
  }

  return cron.days.has(parts.day) || cron.weekdays.has(parts.weekDay)
}

const daysInMonth = (date: Date): number =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()

/**
 * Returns the next scheduled date/time for the given Cron instance.
 *
 * **When to use**
 *
 * Use to find the next occurrence of a cron schedule after a specific date/time
 * or after the current time.
 *
 * **Details**
 *
 * Searches for the next date and time when the cron schedule should trigger,
 * starting after the specified date/time or after the current time when no
 * date is provided.
 *
 * **Example** (Finding the next occurrence)
 *
 * ```ts
 * import { Cron, Result } from "effect"
 *
 * const cron = Result.getOrThrow(Cron.parse("0 0 4 8-14 * *"))
 *
 * // Get next run after a specific date
 * const after = new Date("2021-01-01T00:00:00Z")
 * const nextRun = Cron.next(cron, after)
 * console.log(nextRun) // 2021-01-08T04:00:00.000Z
 *
 * // Get next run from current time
 * const nextFromNow = Cron.next(cron)
 * console.log(nextFromNow) // Next occurrence from now
 * ```
 *
 * @see {@link prev} for finding the previous scheduled occurrence
 * @see {@link sequence} for iterating future scheduled occurrences
 *
 * @category utils
 * @since 2.0.0
 */
export const next = (cron: Cron, now?: DateTime.DateTime.Input): Date => {
  return stepCron(cron, now, "next")
}

/**
 * Returns the previous scheduled date/time for the given Cron instance.
 *
 * **When to use**
 *
 * Use to find the most recent occurrence of a cron schedule before a specific
 * date/time or before the current time.
 *
 * **Details**
 *
 * When no date/time is provided, the search starts from the current time.
 *
 * **Gotchas**
 *
 * The search is strict: if the supplied date/time already matches the schedule,
 * the result is the earlier occurrence.
 *
 * @see {@link next} for finding the next scheduled occurrence
 *
 * @category utils
 * @since 3.20.0
 */
export const prev = (cron: Cron, now?: DateTime.DateTime.Input): Date => {
  return stepCron(cron, now, "prev")
}

const stepCron = (cron: Cron, now: DateTime.DateTime.Input | undefined, direction: "next" | "prev"): Date => {
  const tz = Option.getOrUndefined(cron.tz)
  const zoned = dateTime.makeZonedUnsafe(now ?? new Date(), {
    timeZone: tz
  })

  const reverse = direction === "prev"
  const tick = reverse ? -1 : 1
  const table = cron[direction]
  const boundary = reverse ? cron.last : cron.first

  const needsStep = reverse ?
    (next: number, current: number) => next < current :
    (next: number, current: number) => next > current

  const utc = tz !== undefined && dateTime.isTimeZoneNamed(tz) && tz.id === "UTC"
  const adjustDst = utc ? constVoid : (current: Date) => {
    const adjusted = dateTime.makeZonedUnsafe(current, {
      timeZone: zoned.zone,
      adjustForTimeZone: true,
      disambiguation: reverse ? "later" : undefined
    }).pipe(dateTime.toDate)

    const drift = current.getTime() - adjusted.getTime()
    if (reverse ? drift !== 0 : drift > 0) {
      current.setTime(reverse ? adjusted.getTime() : current.getTime() + drift)
    }
  }

  const result = dateTime.mutate(zoned, (current) => {
    current.setUTCSeconds(current.getUTCSeconds() + tick, 0)

    for (let i = 0; i < 10_000; i++) {
      if (cron.seconds.size !== 0) {
        const currentSecond = current.getUTCSeconds()
        const nextSecond = table.second[currentSecond]
        if (nextSecond === undefined) {
          current.setUTCMinutes(current.getUTCMinutes() + tick, boundary.second)
          adjustDst(current)
          continue
        }
        if (needsStep(nextSecond, currentSecond)) {
          current.setUTCSeconds(nextSecond)
          adjustDst(current)
          continue
        }
      }

      if (cron.minutes.size !== 0) {
        const currentMinute = current.getUTCMinutes()
        const nextMinute = table.minute[currentMinute]
        if (nextMinute === undefined) {
          current.setUTCHours(current.getUTCHours() + tick, boundary.minute, boundary.second)
          adjustDst(current)
          continue
        }
        if (needsStep(nextMinute, currentMinute)) {
          current.setUTCMinutes(nextMinute, boundary.second)
          adjustDst(current)
          continue
        }
      }

      if (cron.hours.size !== 0) {
        const currentHour = current.getUTCHours()
        const nextHour = table.hour[currentHour]
        if (nextHour === undefined) {
          current.setUTCDate(current.getUTCDate() + tick)
          current.setUTCHours(boundary.hour, boundary.minute, boundary.second)
          adjustDst(current)
          continue
        }
        if (needsStep(nextHour, currentHour)) {
          current.setUTCHours(nextHour, boundary.minute, boundary.second)
          adjustDst(current)
          continue
        }
      }

      if (cron.weekdays.size !== 0 || cron.days.size !== 0) {
        let a: number = reverse ? -Infinity : Infinity
        let b: number = reverse ? -Infinity : Infinity

        if (cron.weekdays.size !== 0) {
          const currentWeekday = current.getUTCDay()
          const nextWeekday = table.weekday[currentWeekday]
          if (nextWeekday === undefined) {
            a = reverse ?
              currentWeekday - 7 + boundary.weekday :
              7 - currentWeekday + boundary.weekday
          } else {
            a = nextWeekday - currentWeekday
          }
        }

        if (cron.days.size !== 0 && a !== 0) {
          const currentDay = current.getUTCDate()
          const nextDay = table.day[currentDay]
          if (nextDay === undefined) {
            if (reverse) {
              const prevMonthDays = daysInMonth(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0)))
              b = -(currentDay + (prevMonthDays - boundary.day))
            } else {
              b = daysInMonth(current) - currentDay + boundary.day
            }
          } else {
            b = nextDay - currentDay
          }
        }

        const addDays = reverse ? Math.max(a, b) : Math.min(a, b)
        if (addDays !== 0) {
          current.setUTCDate(current.getUTCDate() + addDays)
          current.setUTCHours(boundary.hour, boundary.minute, boundary.second)
          adjustDst(current)
          continue
        }
      }

      if (cron.months.size !== 0) {
        const currentMonth = current.getUTCMonth() + 1
        const nextMonth = table.month[currentMonth]
        const clampBoundaryDay = (targetMonthIndex: number): number => {
          if (cron.days.size !== 0) {
            return boundary.day
          }
          const maxDayInMonth = daysInMonth(new Date(Date.UTC(current.getUTCFullYear(), targetMonthIndex + 1, 0)))
          return Math.min(boundary.day, maxDayInMonth)
        }
        if (nextMonth === undefined) {
          current.setUTCFullYear(current.getUTCFullYear() + tick)
          current.setUTCMonth(boundary.month, clampBoundaryDay(boundary.month))
          current.setUTCHours(boundary.hour, boundary.minute, boundary.second)
          adjustDst(current)
          continue
        }
        if (needsStep(nextMonth, currentMonth)) {
          const targetMonthIndex = nextMonth - 1
          current.setUTCMonth(targetMonthIndex, clampBoundaryDay(targetMonthIndex))
          current.setUTCHours(boundary.hour, boundary.minute, boundary.second)
          adjustDst(current)
          continue
        }
      }

      return
    }

    throw new Error("Unable to find " + direction + " cron date")
  })

  return dateTime.toDateUtc(result)
}

/**
 * Returns an infinite iterator that yields dates matching the Cron schedule.
 *
 * **When to use**
 *
 * Use to lazily iterate future occurrences of a cron schedule.
 *
 * **Details**
 *
 * The iterator generates an infinite sequence of dates when the cron schedule
 * should trigger, starting after the specified date/time or after the current
 * time when no date is provided.
 *
 * **Example** (Iterating scheduled occurrences)
 *
 * ```ts
 * import { Cron, Result } from "effect"
 *
 * const cron = Result.getOrThrow(Cron.parse("0 0 9 * * 1-5")) // 9 AM weekdays
 *
 * // Get first 5 occurrences
 * const iterator = Cron.sequence(cron, new Date("2023-01-01"))
 * const next5 = Array.from({ length: 5 }, () => iterator.next().value)
 *
 * console.log(next5)
 * // [Mon Jan 02 2023 09:00:00, Tue Jan 03 2023 09:00:00, ...]
 * ```
 *
 * @see {@link next} for computing one next occurrence
 *
 * @category utils
 * @since 2.0.0
 */
export const sequence = function*(cron: Cron, now?: DateTime.DateTime.Input): IterableIterator<Date> {
  while (true) {
    yield now = next(cron, now)
  }
}

/**
 * Equivalence instance for comparing the field restrictions of two `Cron`
 * schedules.
 *
 * **When to use**
 *
 * Use to compare cron schedules through APIs that accept an equivalence
 * relation.
 *
 * **Details**
 *
 * This comparison checks seconds, minutes, hours, days, months, and weekdays.
 * It does not compare the optional timezone.
 *
 * **Example** (Comparing schedules with equivalence)
 *
 * ```ts
 * import { Cron } from "effect"
 *
 * const cron1 = Cron.make({
 *   minutes: [0, 30],
 *   hours: [9],
 *   days: [1, 15],
 *   months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
 *   weekdays: [1, 2, 3, 4, 5]
 * })
 *
 * const cron2 = Cron.make({
 *   minutes: [30, 0], // Different order
 *   hours: [9],
 *   days: [15, 1], // Different order
 *   months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
 *   weekdays: [1, 2, 3, 4, 5]
 * })
 *
 * console.log(Cron.Equivalence(cron1, cron2)) // true
 * ```
 *
 * @see {@link equals} for directly comparing two `Cron` values
 *
 * @category instances
 * @since 2.0.0
 */
export const Equivalence: Equ.Equivalence<Cron> = Equ.make((self, that) =>
  restrictionsEquals(self.seconds, that.seconds) &&
  restrictionsEquals(self.minutes, that.minutes) &&
  restrictionsEquals(self.hours, that.hours) &&
  restrictionsEquals(self.days, that.days) &&
  restrictionsEquals(self.months, that.months) &&
  restrictionsEquals(self.weekdays, that.weekdays)
)

const restrictionsArrayEquals = Equ.Array(Equ.strictEqual<number>())
const restrictionsEquals = (self: ReadonlySet<number>, that: ReadonlySet<number>): boolean =>
  restrictionsArrayEquals(Arr.fromIterable(self), Arr.fromIterable(that))

/**
 * Checks whether two `Cron` instances have the same field restrictions.
 *
 * **When to use**
 *
 * Use to directly compare whether two cron schedules have the same field
 * restrictions.
 *
 * **Details**
 *
 * The comparison checks seconds, minutes, hours, days, months, and weekdays.
 * It does not compare the optional timezone.
 *
 * **Example** (Checking schedule equality)
 *
 * ```ts
 * import { Cron } from "effect"
 *
 * const cron1 = Cron.make({
 *   minutes: [0],
 *   hours: [9],
 *   days: [1, 15],
 *   months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
 *   weekdays: [1, 2, 3, 4, 5]
 * })
 *
 * const cron2 = Cron.make({
 *   minutes: [0],
 *   hours: [9],
 *   days: [1, 15],
 *   months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
 *   weekdays: [1, 2, 3, 4, 5]
 * })
 *
 * console.log(Cron.equals(cron1, cron2)) // true
 * console.log(Cron.equals(cron1)(cron2)) // true (curried form)
 * ```
 *
 * @see {@link Equivalence} for the reusable equivalence instance
 *
 * @category predicates
 * @since 2.0.0
 */
export const equals: {
  (that: Cron): (self: Cron) => boolean
  (self: Cron, that: Cron): boolean
} = dual(2, (self: Cron, that: Cron): boolean => Equivalence(self, that))

interface SegmentOptions {
  min: number
  max: number
  aliases?: Record<string, number> | undefined
}

const secondOptions: SegmentOptions = {
  min: 0,
  max: 59
}

const minuteOptions: SegmentOptions = {
  min: 0,
  max: 59
}

const hourOptions: SegmentOptions = {
  min: 0,
  max: 23
}

const dayOptions: SegmentOptions = {
  min: 1,
  max: 31
}

const monthOptions: SegmentOptions = {
  min: 1,
  max: 12,
  aliases: {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
  }
}

const weekdayOptions: SegmentOptions = {
  min: 0,
  max: 6,
  aliases: {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6
  }
}

const parseSegment = (
  input: string,
  options: SegmentOptions
): Result.Result<ReadonlySet<number>, CronParseError> => {
  const capacity = options.max - options.min + 1
  const values = new Set<number>()
  const fields = input.split(",")

  for (const field of fields) {
    const [raw, step] = splitStep(field)
    if (raw === "*" && step === undefined) {
      return Result.succeed(new Set())
    }

    if (step !== undefined) {
      if (!Number.isInteger(step)) {
        return Result.fail(new CronParseError({ message: `Expected step value to be a positive integer`, input }))
      }
      if (step < 1) {
        return Result.fail(new CronParseError({ message: `Expected step value to be greater than 0`, input }))
      }
      if (step > options.max) {
        return Result.fail(new CronParseError({ message: `Expected step value to be less than ${options.max}`, input }))
      }
    }

    if (raw === "*") {
      for (let i = options.min; i <= options.max; i += step ?? 1) {
        values.add(i)
      }
    } else {
      const [left, right] = splitRange(raw, options.aliases)
      if (!Number.isInteger(left)) {
        return Result.fail(new CronParseError({ message: `Expected a positive integer`, input }))
      }
      if (left < options.min || left > options.max) {
        return Result.fail(
          new CronParseError({ message: `Expected a value between ${options.min} and ${options.max}`, input })
        )
      }

      if (right === undefined) {
        values.add(left)
      } else {
        if (!Number.isInteger(right)) {
          return Result.fail(new CronParseError({ message: `Expected a positive integer`, input }))
        }
        if (right < options.min || right > options.max) {
          return Result.fail(
            new CronParseError({ message: `Expected a value between ${options.min} and ${options.max}`, input })
          )
        }
        if (left > right) {
          return Result.fail(new CronParseError({ message: `Invalid value range`, input }))
        }

        for (let i = left; i <= right; i += step ?? 1) {
          values.add(i)
        }
      }
    }

    if (values.size >= capacity) {
      return Result.succeed(new Set())
    }
  }

  return Result.succeed(values)
}

const splitStep = (input: string): [string, number | undefined] => {
  const separator = input.indexOf("/")
  if (separator !== -1) {
    return [input.slice(0, separator), Number(input.slice(separator + 1))]
  }

  return [input, undefined]
}

const splitRange = (input: string, aliases?: Record<string, number>): [number, number | undefined] => {
  const separator = input.indexOf("-")
  if (separator !== -1) {
    return [aliasOrValue(input.slice(0, separator), aliases), aliasOrValue(input.slice(separator + 1), aliases)]
  }

  return [aliasOrValue(input, aliases), undefined]
}

function aliasOrValue(field: string, aliases?: Record<string, number>): number {
  return aliases?.[field.toLocaleLowerCase()] ?? Number(field)
}
