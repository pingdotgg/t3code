# Schedule Cookbook

Use GitHub's document outline or browser search to jump to the recipe matching
your problem. If you are new to `Schedule`, start with Part I. Otherwise,
search for the shape of your problem, such as retry, repeat, polling, backoff,
jitter, timeout, or recurrence limit.

Watch for four beginner traps throughout the recipes:

- **Channel choice** — `repeat` observes successes; `retry` observes typed
  failures.
- **Recurrence counts** — schedules count recurrences after the first execution.
- **Schedule output** — schedule output is not always the business result.
- **Bounds** — unbounded schedules need a limit, owner, or interruption path.

## Part I — Foundations

### 1. What a `Schedule` Really Represents

#### 1.1 Recurrence policies as data

A `Schedule` is a value that describes when to run something again. It says
whether another run is allowed, how long to wait before it, and what value the
schedule reports. It does not perform the work being retried, repeated, or
polled.

##### Problem

Recurrence rules are easy to hide in loops, callbacks, and scattered sleeps.
That makes them hard to reuse and hard to review. A schedule keeps those rules
separate from the effect that performs the work.

The work answers "what should happen now?" The schedule answers "should there be
another opportunity, when should it happen, and what did the policy report?"

##### Model

At the type level, a schedule has the shape
`Schedule.Schedule<Output, Input, Error, Env>`.

Read them from the policy's point of view:

- `Output` is the value emitted by the schedule, such as a count, duration, or
  label.
- `Input` is the value fed to the schedule by the driver.
- `Error` is an error raised by schedule logic itself.
- `Env` is any Effect context required by the schedule.

Most common schedules are simpler than the full type suggests.
`Schedule.recurs(3)`, `Schedule.spaced("1 second")`, and `Schedule.forever`
ignore their input and output counts. Backoff schedules such as
`Schedule.exponential("100 millis")` output durations.

Because a schedule is a value, you can name it, pass it around, transform it,
and compose it before any recurrence happens.

##### Example

This example defines two policies first, then attaches them to effects:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

const retryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(4))
)

const refreshPolicy = Schedule.spaced("10 millis").pipe(
  Schedule.take(2)
)

let attempts = 0

const flakyRequest = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`request attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail("temporary outage")
  }

  return "response"
})

const refresh = Console.log("refresh cache")

const program = Effect.gen(function*() {
  const response = yield* flakyRequest.pipe(
    Effect.retry(retryPolicy)
  )
  yield* Console.log(`retry result: ${response}`)

  const refreshOutput = yield* refresh.pipe(
    Effect.repeat(refreshPolicy)
  )
  yield* Console.log(`refresh schedule output: ${refreshOutput}`)
})

Effect.runPromise(program)
// Output:
// request attempt 1
// request attempt 2
// request attempt 3
// retry result: response
// refresh cache
// refresh cache
// refresh cache
// refresh schedule output: 2
```

##### Common mistakes

A schedule value is not a plain JSON object. Some schedules carry internal step
state while they are being driven. The useful point is that the policy is
first-class: it can be named, reviewed, reused, and combined before a driver such
as `Effect.retry` or `Effect.repeat` runs it.

Other common mistakes are:

- putting timing and stopping rules in the effect body when they belong in the
  schedule;
- treating schedule output as the business result of the repeated or retried
  effect;
- assuming a schedule is only a sleep, when schedules can count, inspect inputs,
  emit durations, transform outputs, and compose with other policies.

##### Practical guidance

Name the rule for running again before attaching it to the work. Start with the
smallest pieces, such as a cadence and a limit, then compose them.

When reading schedule code, ask:

- What rule for running again am I declaring?
- What does the policy output?
- What input does the policy need to observe?
- Which constraints should be composed instead of embedded in the effect body?

If the answer is mostly about timing, counting, stopping, or observing recurrence
inputs, it belongs in a `Schedule`. If the answer is about the business action,
keep it in the effect that the schedule drives.

#### 1.2 The input/output view of a schedule

A schedule is easier to read when you separate the value it observes from the
value it emits. In `Schedule.Schedule<Output, Input, Error, Env>`, `Input` is
what the driver feeds to the policy, and `Output` is what the policy reports.

Beginner note: Schedule output — the schedule reports policy information; it is
not automatically the successful value produced by the effect being repeated or
retried.

##### Problem

Developers often read a schedule only as a delay. That misses an important
part of the model: schedules can receive values and report values. The input is
not the constructor argument in `Schedule.spaced("1 second")`; it is the value
passed to the schedule each time it is stepped.

##### Model

For cookbook usage, read the first two type parameters first:

| Type     | Meaning                                                           |
| -------- | ----------------------------------------------------------------- |
| `Input`  | The value supplied to the schedule at each decision point.        |
| `Output` | The value emitted by the schedule when it continues or completes. |

`Effect.retry` feeds typed failures into the schedule. `Effect.repeat` feeds
successful values into the schedule. A schedule that ignores input can usually
be used with either entry point. A schedule that inspects input must match the
channel selected by the driver.

Common constructor outputs are also worth knowing:

| Schedule                                                        | Common output     |
| --------------------------------------------------------------- | ----------------- |
| `Schedule.recurs`, `Schedule.spaced`, `Schedule.fixed`          | recurrence counts |
| `Schedule.forever`                                              | recurrence counts |
| `Schedule.exponential`, `Schedule.duration`, `Schedule.elapsed` | durations         |
| `Schedule.passthrough(schedule)`                                | the latest input  |

##### Example

This repeat policy receives successful values. `Schedule.passthrough` turns the
latest input into the schedule output, then `Schedule.map` changes the output
into a log-friendly label:

<!-- no-check: focuses on the schedule-builder shape rather than a standalone copy-paste example -->

```ts no-check
import { Console, Effect, Schedule } from "effect"

type Status = "warming" | "ready"

let polls = 0

const readStatus = Effect.sync((): Status => {
  polls += 1
  return polls < 3 ? "warming" : "ready"
}).pipe(
  Effect.tap((status) => Console.log(`effect success: ${status}`))
)

const program = Effect.gen(function*() {
  const scheduleOutput = yield* readStatus.pipe(
    Effect.repeat(($) =>
      Schedule.passthrough($(Schedule.forever)).pipe(
        Schedule.tapInput((status) => Console.log(`schedule input: ${status}`)),
        Schedule.map((status) => `schedule output: saw ${status}`),
        Schedule.tapOutput((message) => Console.log(message)),
        Schedule.while(({ input }) => input !== "ready")
      )
    )
  )

  yield* Console.log(`repeat returned: ${scheduleOutput}`)
})

Effect.runPromise(program)
```

The effect succeeds with `"warming"`, `"warming"`, then `"ready"`. Each success
is schedule input. The final success also becomes the final schedule output
after mapping, because the raw schedule overload of `Effect.repeat` returns the
schedule output.

##### Common mistakes

Schedule output is not automatically the business value produced by the effect.
With `Effect.retry`, the retried effect still succeeds with the original
successful value. With the raw schedule overload of `Effect.repeat`, the result
is the schedule output. With the options form of `Effect.repeat`, the result is
the last successful value of the repeated effect.

Another common mistake is treating the delay as the output. A schedule decision
contains both an output and the delay before the next recurrence, but only some
schedules choose to output durations.

##### Practical guidance

Before choosing combinators, ask two questions:

- What value will the schedule receive: a success, an error, or some other
  input from a lower-level driver?
- What should the schedule report: a count, a duration, the latest input, a
  label, or a combined value?

Use `tapInput` to observe inputs without changing the result, `tapOutput` to
observe outputs, `map` to transform outputs, and `passthrough` when the input
itself is the useful output.

#### 1.3 Time, repetition, and decision points

A `Schedule` is stepped between executions of some other effect. It does not run
the effect. It receives the latest input, updates its own recurrence state, and
decides whether another execution is allowed.

##### Problem

Time-based recurrence is often described as "sleep, then try again." That is too
small a model for `Schedule`. A schedule decision says whether to keep going,
what value to report, and how long to wait. Those are related, but they are not
the same thing.

##### Model

Each successful schedule decision answers three questions:

- What input did the policy observe?
- What output did the policy emit?
- How long should the driver wait before the next recurrence?

If the policy is done, there is no next recurrence. A zero delay means
"continue immediately"; it does not mean "stop."

For retry, the decision point happens after a typed failure. The failure is the
schedule input. For repeat, the decision point happens after a success. The
successful value is the schedule input. In both cases, the first execution
happens before the first schedule decision.

That rule is the source of the common count distinction:
`Schedule.recurs(3)` allows up to three recurrences after the initial execution.
In retry code, that means up to three retries. In repeat code, it means up to
three repetitions.

Beginner note: Recurrence counts — when a requirement says "run three times
total", the schedule usually needs `recurs(2)` because the first execution has
already happened.

##### Time

Schedule time is measured at the step boundary. The schedule receives the
current timestamp and the latest input, then computes its output and next delay.
This lets time-based and count-based policies compose cleanly.

Common timing policies have different meanings:

- `Schedule.spaced(duration)` waits the same amount after each recurrence.
- `Schedule.fixed(duration)` aligns recurrences to fixed time windows.
- `Schedule.exponential(base)` increases the delay from one decision to the
  next.
- `Schedule.duration(duration)` recurs once after the configured duration, then
  completes.
- `Schedule.during(duration)` continues while elapsed schedule time remains
  within the configured duration.
- `Schedule.elapsed` emits elapsed time as its output.

These policies still produce schedule decisions. The delay answers when the next
run may happen. The continue-or-stop decision answers whether it may happen at
all. The output answers what the policy reports to the driver or later
combinators.

##### Common mistakes

The first mistake is counting the initial effect execution as a schedule step.
The effect runs once first. Only then does the schedule decide whether another
run is allowed.

The second mistake is treating delay and "keep going" as the same thing. A
schedule can continue immediately, continue after a delay, or complete. Only the
last case stops recurrence.

The third mistake is reading schedule output as elapsed time in every case.
Some schedules output durations, but many output counts or transformed values.

##### Practical guidance

When reading a schedule, translate it into a decision:

- What input does this decision observe?
- What condition lets it continue?
- What delay does it choose for the next recurrence?
- What output does it publish?

This framing keeps retry, repeat, polling, backoff, jitter, and elapsed-time
limits as variations of the same model instead of separate control-flow tricks.

#### 1.4 Why `Schedule` is more than “retry with delay”

Retry with a delay is one use of `Schedule`, not the definition of it. A
schedule is a reusable rule for running again. It can drive retrying, repeating,
polling, stream pacing, staged behavior, and observability.

##### Problem

A delay answers one question: "How long should I wait?" A schedule can also
answer "Should I continue?", "What input did I observe?", "What output should I
publish?", and "How does this policy combine with another policy?"

Reducing `Schedule` to a sleep duration hides those decisions.

##### Model

A schedule step receives an input and timing metadata, then either continues
with an output plus a delay or completes with a final output. That model supports
several policy concerns:

- continuation with `Schedule.recurs`, `Schedule.take`, `Schedule.during`, and
  `Schedule.while`;
- timing with `Schedule.spaced`, `Schedule.fixed`, `Schedule.windowed`,
  `Schedule.exponential`, `Schedule.fibonacci`, `Schedule.cron`, and
  `Schedule.duration`;
- output transformation and observation with `Schedule.map`,
  `Schedule.tapInput`, and `Schedule.tapOutput`;
- output collection or accumulation with `Schedule.collectOutputs` and
  `Schedule.reduce`;
- policy composition with `Schedule.both`, `Schedule.either`, and
  `Schedule.andThen`.

The same value can therefore express a bounded backoff retry policy, a polling
cadence, or a two-phase loop. The driver decides whether successful values or
typed failures are fed to the policy.

##### Composition

Composition is the part that a raw delay cannot express.

`Schedule.both(left, right)` continues only while both policies continue. When
both produce delays, the combined delay is the maximum. This is useful for
"back off, but stop after five recurrences."

`Schedule.either(left, right)` continues while either policy continues. Its
combined delay uses the minimum delay. This is useful when one policy may keep a
loop alive after another policy has completed.

`Schedule.andThen(left, right)` is sequential. It runs the first policy to
completion, then runs the second. This is the right model for warm-up behavior
followed by a steadier cadence.

##### Common mistakes

The first mistake is treating schedule output as disposable. Counts, durations,
labels, accumulated state, and collected values can be useful for logging,
metrics, fallback decisions, and tests.

The second mistake is assuming schedules only see failures. `Effect.retry` feeds
failures into a schedule, but `Effect.repeat` feeds successes. A successful job
state such as `"pending"` belongs in a repeat loop, not in a fake error used only
to make retry inspect it.

The third mistake is encoding every policy in effect control flow. Once timing,
limits, predicates, or phases matter, a schedule value is usually easier to
inspect than a hand-written loop.

##### Practical guidance

Reach for `Schedule` when the rule for running again is more important than a
single sleep. Name the policy in recurrence terms: bounded backoff, fixed
polling, warm-up then steady state, retry while transient, repeat until terminal.

If the only requirement is one hard-coded pause, a duration or `Effect.sleep`
may be enough. If the requirement includes whether to keep going, what to
report, how to compose policies, or how to inspect input values, model it as a
schedule.

#### 1.5 Composability as the core design idea

`Schedule` is designed around small policies that can be combined. A retry or
repeat policy often has several concerns: a cadence, a limit, a predicate,
observability, and sometimes phases. Each concern can be represented separately.

##### Problem

When recurrence logic is written as one loop, the policy becomes hard to read.
You have to inspect control flow to answer basic questions: what is the delay,
what stops the loop, and what happens after the first phase?

Schedules make those relationships explicit.

##### Core combinators

Choose the combinator by the relationship between policies:

- `Schedule.both` means both policies must continue. The combined delay is the
  maximum delay.
- `Schedule.either` means either policy may continue. The combined delay is the
  minimum delay.
- `Schedule.andThen` means the policies run sequentially: first one, then the
  other.

Use the output-selecting variants when a tuple is not useful:
`bothLeft`, `bothRight`, `bothWith`, `eitherLeft`, `eitherRight`, and
`eitherWith`.

##### Example

This retry policy has three separate concerns: a fast phase, a slower phase, and
a hard retry limit.

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class TemporaryError extends Data.TaggedError("TemporaryError")<{
  readonly attempt: number
}> {}

const burstThenSlow = Schedule.spaced("10 millis").pipe(
  Schedule.take(2),
  Schedule.andThen(
    Schedule.spaced("25 millis").pipe(Schedule.take(2))
  )
)

const retryPolicy = burstThenSlow.pipe(
  Schedule.bothLeft(Schedule.recurs(4)),
  Schedule.tapOutput((step) => Console.log(`policy step ${step}`))
)

let attempts = 0

const request = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`request attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(new TemporaryError({ attempt: attempts }))
  }

  return "ok"
})

const program = Effect.gen(function*() {
  const result = yield* request.pipe(
    Effect.retry(retryPolicy)
  )
  yield* Console.log(`result: ${result}`)
})

Effect.runPromise(program)
// Output:
// request attempt 1
// policy step 0
// request attempt 2
// policy step 1
// request attempt 3
// policy step 0
// request attempt 4
// result: ok
```

The timing policy is phased with `andThen`. The retry budget is added with
`bothLeft`, so both the timing policy and the count limit must allow another
retry.

##### Common mistakes

Do not use `both` when the intended behavior is phased. `both` runs policies at
the same time and stops when either one stops. Use `andThen` for "do this first,
then switch to that."

Do not ignore output shape. `both` and `either` return tuples. That is useful
when both outputs matter, but noisy when the caller only needs one side or a
custom value.

Do not combine many policies before naming the smaller pieces. Names make the
relationship between delay, limits, predicates, and phases visible.

##### Practical guidance

Build schedules in this order:

1. Start with the cadence or backoff.
2. Add the stopping policy.
3. Add input predicates if the policy should inspect successes or failures.
4. Add output mapping or tapping for observability.
5. Sequence phases with `andThen` only when the policy really changes over time.

The result should read like a rule for running again, not like hidden control
flow.

### 2. `repeat` vs `retry`

#### 2.1 Repeating successful effects

Use `Effect.repeat` when a successful result should be followed by another run.
The schedule is consulted after success, not after failure.

Beginner note: Channel choice — choose `repeat` only when the value you need to
inspect is a success value, such as a normal polling status.

##### Problem

Manual repetition tends to mix the unit of work with cadence, stopping rules,
and sleeps. `Effect.repeat` keeps the effect focused on one successful run while
a `Schedule` decides whether another successful run should follow.

##### When to use it

Use `repeat` for workflows where success means "consider doing this again":
heartbeats, periodic refreshes, metric sampling, polling successful domain
states, and bounded setup checks.

A job status such as `"pending"` is usually a normal successful response, not
an error.

##### When not to use it

Do not use `repeat` to recover from failure. If the effect fails, repetition
stops immediately and the failure is returned. Use `Effect.retry` when the next
run should be triggered by a typed failure.

Do not use an unbounded repeat for a one-shot workflow unless some surrounding
fiber, timeout, or interruption boundary is responsible for stopping it.

##### Schedule shape

`Effect.repeat` runs the effect once before the schedule makes a decision. After
each success, the successful value becomes schedule input.

`Schedule.recurs(n)` allows up to `n` repetitions after the first run.
`Schedule.spaced(duration)` repeats indefinitely with that delay between
successful runs. Pair unbounded timing schedules with `times`, `take`,
`recurs`, or a predicate when the loop must finish on its own.

The return value depends on the overload. The raw schedule overload returns the
schedule output. The options form, such as `Effect.repeat({ times: n })` or
`Effect.repeat({ schedule })`, returns the final successful value from the
effect.

##### Example

This heartbeat runs once immediately, then repeats twice more:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let beats = 0

const heartbeat = Effect.sync(() => {
  beats += 1
  return `heartbeat ${beats}`
}).pipe(
  Effect.tap((message) => Console.log(message))
)

const program = Effect.gen(function*() {
  const lastValue = yield* heartbeat.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      times: 2
    })
  )

  yield* Console.log(`repeat returned last value: ${lastValue}`)
})

Effect.runPromise(program)
// Output:
// heartbeat 1
// heartbeat 2
// heartbeat 3
// repeat returned last value: heartbeat 3
```

The initial execution is not counted as a scheduled recurrence. The example
runs three times total: one initial heartbeat plus two repetitions.

##### Variants

Use `times` for the smallest bounded repeat when you care about the final
successful value. Use a raw schedule when you care about the schedule output.

Use `until` when the successful value describes the stopping condition. Use
`while` when the successful value describes the condition for continuing. Both
predicates inspect successes when used with `repeat`.

For polling, keep normal domain states in the success channel. If the status is
`"pending"`, repeat the successful polling effect until it returns a terminal
state. If the polling request itself fails, `repeat` returns that failure unless
the polling effect handles or retries it internally.

##### Notes and caveats

Delays are between recurrences. They do not delay the initial execution.

When `until` or `while` is combined with a bounded schedule, repetition can end
because the predicate stopped it or because the schedule was exhausted. If the
caller must distinguish those outcomes, make that distinction explicit in the
success value or use a schedule output that records it.

If the schedule itself can fail, that failure is part of the returned effect's
error channel. Basic schedules such as `Schedule.recurs` and `Schedule.spaced`
do not add their own error.

#### 2.2 Retrying failed effects

Use `Effect.retry` when a typed failure may be temporary and the same effect may
be attempted again safely.

##### Problem

Retrying is not the same as repeating. `retry` is driven by failures. The
original effect runs once. If it succeeds, retrying is never started. If it
fails with a typed error, the retry policy decides whether another attempt is
allowed.

##### When to use it

Use `retry` for transient inability to complete an operation: temporary network
errors, rate limits modeled as typed failures, reconnect attempts, resource
contention, or startup dependencies that may become available soon.

Put the retry around the smallest operation that is safe to run more than once.
Retrying an entire workflow can duplicate side effects that already succeeded.

##### When not to use it

Do not use `retry` for successful domain states. A successful `"pending"` status
should usually be repeated or polled, not turned into an error only so retry can
see it.

Do not rely on retry for defects or interruptions. `Effect.retry` retries typed
failures from the error channel; defects and interruptions are not retried as
typed failures.

Beginner note: Channel choice — `retry` is for temporary inability to complete
an operation, not for ordinary states like `"pending"`, `"starting"`, or
`"warming"`.

##### Schedule shape

The schedule input is the typed failure from the failed attempt. If a later
attempt succeeds, the whole effect succeeds with that value. If the schedule is
exhausted while attempts are still failing, the last typed failure is returned.

`times: 3` and `Schedule.recurs(3)` both mean up to three retries after the first
attempt. The effect may run four times total.

Use a raw schedule when timing, composition, or reuse matters. Use options such
as `while`, `until`, and `times` when the policy is local to one call site.

##### Example

This request fails twice with a retryable error, then succeeds:

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number
  readonly retryable: boolean
}> {}

let attempts = 0

const request = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`request attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail(
      new HttpError({ status: 503, retryable: true })
    )
  }

  return "response body"
})

const retryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const program = Effect.gen(function*() {
  const body = yield* request.pipe(
    Effect.retry({
      schedule: retryPolicy,
      while: (error) => error.retryable
    })
  )

  yield* Console.log(`retry result: ${body}`)
})

Effect.runPromise(program)
// Output:
// request attempt 1
// request attempt 2
// request attempt 3
// retry result: response body
```

The `while` predicate is checked after each typed failure. If it returns
`false`, retrying stops and that error is returned. If it returns `true`, the
schedule still has to allow another attempt.

##### Common mistakes

- Counting `times` or `Schedule.recurs` as total executions. They count retries
  after the first attempt.
- Expecting retry to continue after success. The first success completes the
  whole effect.
- Retrying a larger workflow when only one operation is idempotent.
- Using an unbounded schedule when an operational limit is required.
- Treating defects or interruptions as retryable typed failures.

##### Practical guidance

Use `retry` when the failure is expected to be temporary and the operation is
safe to attempt again. Add a count, elapsed-time budget, delay, backoff, or
jitter when retrying crosses a process or network boundary.

If all attempts fail and you need a fallback value or recovery effect, use
`Effect.retryOrElse`. Plain `Effect.retry` preserves the final failure.

#### 2.3 When the distinction matters

`Effect.repeat` and `Effect.retry` both accept schedules, but they feed different
values to those schedules. The entry point is a semantic choice, not just a
timing choice.

##### Problem

A policy can only inspect the kind of value you give it. `repeat` gives it
successes. `retry` gives it failures. Polling states belong on the success path.
Transient service errors belong on the failure path. If the operator is wrong,
the schedule may never see the value you meant to inspect.

##### Comparison

| Question                                 | `Effect.repeat`                             | `Effect.retry`                    |
| ---------------------------------------- | ------------------------------------------- | --------------------------------- |
| What triggers the schedule?              | A successful value                          | A typed failure                   |
| What does the schedule receive as input? | The success value                           | The error value                   |
| What stops immediately?                  | The first failure                           | The first success                 |
| What happens when the schedule stops?    | Repetition completes after the last success | Retry fails with the last error   |
| What does `times: n` mean?               | Up to `n` repetitions after the first run   | Up to `n` retries after first run |

The same real-world workflow can use either operator depending on how the result
is modeled.

##### Example

This program uses `repeat` for successful job states and `retry` for transient
service failures:

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

type JobState = "pending" | "ready"

let polls = 0

const checkJob = Effect.sync((): JobState => {
  polls += 1
  return polls < 3 ? "pending" : "ready"
}).pipe(
  Effect.tap((state) => Console.log(`job state: ${state}`))
)

class ReportError extends Data.TaggedError("ReportError")<{
  readonly kind: "Unavailable" | "Unauthorized"
}> {}

let attempts = 0

const fetchReport = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`report attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail(new ReportError({ kind: "Unavailable" }))
  }

  return "report"
})

const retryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(4))
)

const program = Effect.gen(function*() {
  const finalState = yield* checkJob.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (state) => state === "ready"
    })
  )
  yield* Console.log(`repeat finished with: ${finalState}`)

  const report = yield* fetchReport.pipe(
    Effect.retry({
      schedule: retryPolicy,
      while: (error) => error.kind === "Unavailable"
    })
  )
  yield* Console.log(`retry finished with: ${report}`)
})

Effect.runPromise(program)
// Output:
// job state: pending
// job state: pending
// job state: ready
// repeat finished with: ready
// report attempt 1
// report attempt 2
// report attempt 3
// retry finished with: report
```

`"pending"` is a successful value, so the polling loop repeats. `"Unavailable"`
is a typed failure, so the request retries.

##### Tradeoffs

`repeat` keeps normal domain states in the success channel. That is a good fit
for polling, heartbeats, refresh loops, and workflows where a successful
observation decides whether to continue. The tradeoff is that the first failure
stops the repeat unless the repeated effect handles it.

`retry` keeps transient inability to complete the operation in the error
channel. That is a good fit for requests, reconnect attempts, and resource
contention. The tradeoff is that success ends the retry immediately.

##### Recommended default

Put expected domain states in the success channel and repeat over them. Put
temporary inability to complete the operation in the error channel and retry over
it.

If you find yourself failing with normal states only so `retry` can see them, or
turning real failures into successful values only so `repeat` can see them, the
model is probably carrying the wrong information in the wrong channel.

Both operators run the effect once before the schedule makes a recurrence
decision. `times: 3` therefore means the initial execution plus up to three more
executions.

#### 2.4 Common beginner mistakes

Most early mistakes come from mixing three separate things: the success channel,
the error channel, and the schedule output.

##### Problem

`Effect.repeat` schedules successes. `Effect.retry` schedules typed failures.
Count-based policies count recurrences after the first execution. The raw
schedule overload of `Effect.repeat` returns the schedule output, not the effect
value.

Those rules are small, but confusing them changes behavior and types.

Beginner note: Channel choice — if a recipe surprises you, first ask which
channel the schedule is observing, then ask what value the operator returns.

##### Mistakes to avoid

| Mistake                                              | Consequence                                     |
| ---------------------------------------------------- | ----------------------------------------------- |
| Using `repeat` to recover from failure               | The first failure is returned immediately.      |
| Using `retry` for a successful polling state         | The first success ends the retry.               |
| Counting `times` as total executions                 | The effect may run one more time than expected. |
| Expecting raw `repeat(schedule)` to return the value | It returns the schedule output.                 |
| Putting predicates on the wrong operator             | The predicate inspects the wrong channel.       |
| Forgetting a schedule is unbounded                   | The loop runs until failure or interruption.    |

##### Example

This small program shows three of the common surprises:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

const program = Effect.gen(function*() {
  let repeatRuns = 0

  const lastValue = yield* Effect.sync(() => {
    repeatRuns += 1
    return `repeat run ${repeatRuns}`
  }).pipe(
    Effect.repeat({ times: 2 })
  )

  yield* Console.log(
    `repeat ran ${repeatRuns} times and returned "${lastValue}"`
  )

  let retryAttempts = 0

  const retryExit = yield* Effect.failSync(() => {
    retryAttempts += 1
    return "temporary"
  }).pipe(
    Effect.retry({ times: 2 }),
    Effect.exit
  )

  yield* Console.log(
    `retry attempted ${retryAttempts} times and ended with ${retryExit._tag}`
  )

  const rawScheduleOutput = yield* Effect.succeed("done").pipe(
    Effect.repeat(Schedule.recurs(2))
  )

  yield* Console.log(
    `raw schedule repeat returned ${rawScheduleOutput}`
  )

  const repeatExit = yield* Effect.fail("temporary").pipe(
    Effect.repeat(Schedule.recurs(2)),
    Effect.exit
  )

  yield* Console.log(
    `repeat over failure ended with ${repeatExit._tag}`
  )
})

Effect.runPromise(program)
// Output:
// repeat ran 3 times and returned "repeat run 3"
// retry attempted 3 times and ended with Failure
// raw schedule repeat returned 2
// repeat over failure ended with Failure
```

`times: 2` allows two recurrences after the initial run. The retry example also
attempts three executions total. The raw schedule repeat returns the final
`Schedule.recurs` output.

##### Predicate placement

Predicates in `repeat` options inspect successful values:
`Effect.repeat({ until: (value) => ... })`.

Predicates in `retry` options inspect typed failures:
`Effect.retry({ while: (error) => ... })`.

Use `until` when the predicate describes the stopping condition. Use `while`
when it describes the condition for continuing.

##### Practical guidance

Use this checklist before choosing the operator:

| If you mean...                                 | Prefer...                                                   |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Try again after a typed failure                | `Effect.retry`                                              |
| Run again after a success                      | `Effect.repeat`                                             |
| Keep the last successful value from repetition | `Effect.repeat({ times })` or `Effect.repeat({ schedule })` |
| Use the schedule's output as the result        | `Effect.repeat(schedule)`                                   |
| Limit a retry or repeat to `n` more runs       | `Schedule.recurs(n)` or `{ times: n }`                      |

For an external requirement like "try three times total", subtract the initial
run from the recurrence count. That means `times: 2` or `Schedule.recurs(2)`.

#### 2.5 Choosing the right entry point

Choose the entry point by the channel the policy must observe. Timing comes
after that choice.

##### Problem

The same schedule value can often be passed to `Effect.repeat` or
`Effect.retry`, but the two operators feed it different inputs. A policy that
should inspect successful statuses belongs on `repeat`. A policy that should
inspect transient typed failures belongs on `retry`.

##### Decision table

| Question                                     | Entry point     |
| -------------------------------------------- | --------------- |
| Should the policy inspect successful values? | `Effect.repeat` |
| Should another run follow a success?         | `Effect.repeat` |
| Should the first failure stop the loop?      | `Effect.repeat` |
| Should the policy inspect typed failures?    | `Effect.retry`  |
| Should another run follow a typed failure?   | `Effect.retry`  |
| Should the first success stop the loop?      | `Effect.retry`  |

##### Schedule shape

Both entry points accept an options object, a `Schedule`, or a schedule builder.

Use the options form when the policy is local:

- `times` limits recurrences after the first execution.
- `while` continues while the observed value satisfies a predicate.
- `until` continues until the observed value satisfies a predicate.
- `schedule` adds an explicit schedule policy.

The observed value depends on the entry point. In `repeat`, `while` and `until`
inspect successful values. In `retry`, they inspect typed failures.

Use a named `Schedule` when the policy is reusable or composed from several
concerns. Use the builder form when the schedule needs to inspect its input and
you want that input type inferred from the effect.

Return values are different. `Effect.retry` succeeds with the original effect's
successful value. The raw schedule overload of `Effect.repeat` succeeds with the
schedule output. The options form of `Effect.repeat` keeps the repeated effect's
final successful value.

##### Example

This program uses both entry points for their intended channels:

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

type Status = "starting" | "ready"

let statusChecks = 0

const readStatus = Effect.sync((): Status => {
  statusChecks += 1
  return statusChecks < 3 ? "starting" : "ready"
}).pipe(
  Effect.tap((status) => Console.log(`status check: ${status}`))
)

class ServiceError extends Data.TaggedError("ServiceError")<{
  readonly retryable: boolean
}> {}

let serviceCalls = 0

const callService = Effect.gen(function*() {
  serviceCalls += 1
  yield* Console.log(`service call ${serviceCalls}`)

  if (serviceCalls < 3) {
    return yield* Effect.fail(new ServiceError({ retryable: true }))
  }

  return "service response"
})

const retryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(4))
)

const program = Effect.gen(function*() {
  const finalStatus = yield* readStatus.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (status) => status === "ready"
    })
  )
  yield* Console.log(`repeat returned: ${finalStatus}`)

  const response = yield* callService.pipe(
    Effect.retry({
      schedule: retryPolicy,
      while: (error) => error.retryable
    })
  )
  yield* Console.log(`retry returned: ${response}`)
})

Effect.runPromise(program)
// Output:
// status check: starting
// status check: starting
// status check: ready
// repeat returned: ready
// service call 1
// service call 2
// service call 3
// retry returned: service response
```

`"starting"` is a successful state, so it drives `repeat`. `ServiceError` is a
typed failure, so it drives `retry`.

##### When not to use each entry point

Do not choose `repeat` to recover from failures. It propagates the first failure
unless the repeated effect handles that failure itself.

Do not choose `retry` for ordinary successful states. If `"pending"` or
`"starting"` is a valid response, model it as a success and repeat until it
becomes terminal.

Do not use either operator to hide unsafe duplication. Keep the repeated or
retried effect scoped to work that is safe to run more than once.

##### Practical guidance

Ask these questions in order:

1. Is the recurrence triggered by success or typed failure?
2. Should the policy inspect the successful value or the error value?
3. Is the first execution part of the external budget?
4. Should the caller receive the effect value or the schedule output?
5. What bound stops the recurrence if the predicate never changes?

When exhaustion needs recovery, use `Effect.repeatOrElse` for repeated effects
that fail before completion and `Effect.retryOrElse` for retries that exhaust
while the effect is still failing.

### 3. Minimal Building Blocks

#### 3.1 Repeat a fixed number of times

Use `Schedule.recurs(n)` when a successful effect should run once now and then
repeat at most `n` more times. The schedule is the rule for running again; the
effect itself is still executed by `Effect.repeat`.

##### Problem

You need a count-only repeat: no delay, predicate, or elapsed-time window.

##### When to use it

Use this for small, bounded successful repeats:

- Running a setup probe a known number of times.
- Taking a fixed number of samples.
- Starting with a count limit before adding spacing or backoff.

Do not use it when the next run depends on the previous value. In that case,
use `Effect.repeat` options such as `until` or `while`.

##### Schedule shape

`Effect.repeat` runs the effect once before the schedule is stepped. Therefore
`Schedule.recurs(4)` means four recurrences after the first run, for five total
executions.

Beginner note: Recurrence counts — count the first run separately, then use the
schedule for the additional runs.

| Desired total executions | Policy               |
| ------------------------ | -------------------- |
| 1                        | `Schedule.recurs(0)` |
| 2                        | `Schedule.recurs(1)` |
| 5                        | `Schedule.recurs(4)` |

The `times` option follows the same rule: `Effect.repeat({ times: 4 })` also
means one initial run plus four repeats.

##### Example

```ts runnable deterministic
import { Console, Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function*() {
  const runs = yield* Ref.make(0)

  yield* Ref.updateAndGet(runs, (n) => n + 1).pipe(
    Effect.tap((run) => Console.log(`run ${run}`)),
    Effect.repeat(Schedule.recurs(4))
  )

  const total = yield* Ref.get(runs)
  yield* Console.log(`total runs: ${total}`)
})

Effect.runPromise(program)
// Output:
// run 1
// run 2
// run 3
// run 4
// run 5
// total runs: 5
```

This prints five runs: the first execution plus four scheduled recurrences.

##### Variant

Use `times` when you only need a local fixed repeat and want the final effect
value back:

```ts runnable deterministic
import { Console, Effect, Ref } from "effect"

const program = Effect.gen(function*() {
  const runs = yield* Ref.make(0)

  const lastValue = yield* Ref.updateAndGet(runs, (n) => n + 1).pipe(
    Effect.tap((run) => Console.log(`run ${run}`)),
    Effect.repeat({ times: 4 })
  )

  yield* Console.log(`last value: ${lastValue}`)
})

Effect.runPromise(program)
// Output:
// run 1
// run 2
// run 3
// run 4
// run 5
// last value: 5
```

With a schedule, `Effect.repeat` succeeds with the schedule output. With
`times`, it succeeds with the last successful value produced by the repeated
effect.

##### Notes

The main mistake is counting total executions instead of recurrences. If a
requirement says "run five times total", use `Schedule.recurs(4)` or
`times: 4`.

#### 3.2 Retry a fixed number of times

Use `Schedule.recurs(n)` with `Effect.retry` when the whole policy is "retry at
most `n` more times". A retry receives typed failures. These are failures in the
Effect error channel, not defects or interruptions.

##### Problem

An effect can fail transiently, and a small immediate retry budget is enough.
There is no delay, backoff, or error-specific filtering yet.

##### When to use it

Use this for cheap, idempotent work where retrying immediately is acceptable.
Idempotent means running the operation more than once has the same external
effect as running it once, or the duplicates are safely ignored.

This is also a useful count limit inside a larger policy that later adds timing.

##### When not to use it

Do not use immediate retries against overloaded dependencies, rate-limited APIs,
or slow remote calls. Those usually need spacing, backoff, jitter, or a narrower
error predicate.

Do not use retry to handle defects or fiber interruptions. `Effect.retry` only
retries typed failures.

##### Schedule shape

`Effect.retry` runs the effect once before the schedule is stepped. Each typed
failure is offered to the schedule:

- `Schedule.recurs(0)` allows no retries.
- `Schedule.recurs(1)` allows one retry, for two attempts total.
- `Schedule.recurs(3)` allows three retries, for four attempts total.

If a later attempt succeeds, retrying stops immediately. If the schedule stops
while the effect is still failing, the last typed failure is returned.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class RequestError extends Data.TaggedError("RequestError")<{
  readonly attempt: number
}> {}

let attempt = 0

const fetchUser = Effect.gen(function*() {
  attempt += 1
  yield* Console.log(`attempt ${attempt}`)

  if (attempt < 4) {
    return yield* Effect.fail(new RequestError({ attempt }))
  }

  return { id: "user-1", name: "Ada" }
})

const program = fetchUser.pipe(
  Effect.retry(Schedule.recurs(3)),
  Effect.tap((user) => Console.log(`loaded ${user.name}`))
)

Effect.runPromise(program)
// Output:
// attempt 1
// attempt 2
// attempt 3
// attempt 4
// loaded Ada
```

The first three attempts fail. The policy permits exactly three retries, so the
fourth attempt can succeed.

##### Variant

For one local call site, `Effect.retry({ times: 3 })` has the same retry-count
meaning as `Schedule.recurs(3)`. Prefer the schedule form when you want to name
the policy, pass it around, or compose it with timing.

##### Notes

The retry count is not the total attempt count. If an external requirement says
"try three times total", use `Schedule.recurs(2)` or `times: 2`.

Keep the retry boundary small. Retry the operation that may transiently fail,
not a larger workflow that also performs side effects that should not be
repeated.

#### 3.3 Add a delay between recurrences

Use `Schedule.spaced(duration)` when the next recurrence should wait for a
constant delay instead of running immediately.

##### Problem

The effect should recur, but a tight loop would be too aggressive. Each
scheduled recurrence needs the same pause.

##### When to use it

Use fixed spacing for simple pacing:

- Polling a resource every few milliseconds or seconds.
- Emitting a heartbeat.
- Adding a small delay between retry attempts.
- Making a count-only example closer to production behavior.

Do not use an unbounded spaced schedule accidentally. `Schedule.spaced("1 second")`
continues until another condition stops it, so pair it with a count, predicate,
or external interruption when the workflow must be finite.

Beginner note: Bounds — adding a delay makes a loop slower, not finite.

##### Schedule shape

`Schedule.spaced(duration)` keeps recurring and requests the same delay on each
step. With `Effect.repeat`, the first effect execution still happens
immediately; the delay applies before each later recurrence.

Limit a spaced schedule with `Schedule.take(n)`:

```ts runnable deterministic
import { Console, Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function*() {
  const runs = yield* Ref.make(0)

  yield* Ref.updateAndGet(runs, (n) => n + 1).pipe(
    Effect.tap((run) => Console.log(`run ${run}`)),
    Effect.repeat(Schedule.spaced("25 millis").pipe(Schedule.take(3)))
  )

  const total = yield* Ref.get(runs)
  yield* Console.log(`total runs: ${total}`)
})

Effect.runPromise(program)
// Output:
// run 1
// run 2
// run 3
// run 4
// total runs: 4
```

This runs four times total: one initial execution plus three spaced
recurrences.

##### Retry example

The same schedule can pace retries. In retry, typed failures drive the schedule
instead of successful values.

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class RequestError extends Data.TaggedError("RequestError")<{
  readonly attempt: number
}> {}

let attempt = 0

const request = Effect.gen(function*() {
  attempt += 1
  yield* Console.log(`attempt ${attempt}`)

  if (attempt < 3) {
    return yield* Effect.fail(new RequestError({ attempt }))
  }

  return "ok"
})

const program = request.pipe(
  Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.take(2))),
  Effect.tap((value) => Console.log(`result: ${value}`))
)

Effect.runPromise(program)
// Output:
// attempt 1
// attempt 2
// attempt 3
// result: ok
```

Here the policy allows two retries and waits 25 milliseconds before each retry.

##### Notes

`Schedule.spaced` is a schedule, not a sleep before the first attempt. The first
`repeat` or `retry` attempt is immediate.

Use `Schedule.addDelay` when you already have a schedule and want to add an
extra computed delay to whatever delay that schedule already chose. The delay
function returns an `Effect`, so any failure or service requirement from that
function becomes part of the schedule.

#### 3.4 Stop after a limit

Use a limit whenever a rule for running again must not continue forever. The
limit can be the whole policy, or it can cap another policy such as spacing or
backoff.

##### Problem

The recurrence needs a clear stopping rule.

The common building blocks are:

- `Schedule.recurs(n)` for a count-only limit.
- `Schedule.take(n)` for limiting another schedule.
- `Schedule.during(duration)` for an elapsed recurrence window.

Each limit controls recurrences after the initial execution.

##### When to use it

Use a limit for retry budgets, finite sampling, bounded tests, and caps on
otherwise unbounded schedules such as `Schedule.spaced("1 second")`.

Use `Schedule.recurs(n)` when the count is the policy. Use
`schedule.pipe(Schedule.take(n))` when another schedule already describes the
delay or output and only needs a cap.

##### When not to use it

Do not use a schedule limit for value-based stopping. If a successful value
decides whether to continue, use `Effect.repeat` with `until` or `while`. If a
typed failure decides whether to retry, use `Effect.retry` with `until` or
`while`.

Do not use `Schedule.during` as a timeout for a single slow run. A schedule is
consulted between runs; it does not interrupt an effect that is already running.

Beginner note: Bounds — schedule limits bound future recurrences, not the body
of the current effect. Use an effect timeout when one execution must be
interrupted.

##### Schedule shape

`Effect.repeat` and `Effect.retry` run once before stepping the schedule:

| Limit                             | Meaning after the first run            |
| --------------------------------- | -------------------------------------- |
| `Schedule.recurs(0)`              | No additional recurrences              |
| `Schedule.recurs(3)`              | At most three additional recurrences   |
| `schedule.pipe(Schedule.take(3))` | At most three outputs from `schedule`  |
| `Schedule.during("30 seconds")`   | Recur while the elapsed window is open |

For retry, "three additional recurrences" means up to three retries. For
repeat, it means up to three additional successful executions.

##### Example

```ts runnable deterministic
import { Console, Effect, Ref, Schedule } from "effect"

const countOnly = Effect.gen(function*() {
  const runs = yield* Ref.make(0)

  yield* Ref.updateAndGet(runs, (n) => n + 1).pipe(
    Effect.tap((run) => Console.log(`count-only run ${run}`)),
    Effect.repeat(Schedule.recurs(2))
  )

  return yield* Ref.get(runs)
})

const spacedAndLimited = Effect.gen(function*() {
  const runs = yield* Ref.make(0)

  yield* Ref.updateAndGet(runs, (n) => n + 1).pipe(
    Effect.tap((run) => Console.log(`spaced run ${run}`)),
    Effect.repeat(Schedule.spaced("20 millis").pipe(Schedule.take(2)))
  )

  return yield* Ref.get(runs)
})

const program = Effect.gen(function*() {
  const countTotal = yield* countOnly
  const spacedTotal = yield* spacedAndLimited

  yield* Console.log(`count-only total: ${countTotal}`)
  yield* Console.log(`spaced total: ${spacedTotal}`)
})

Effect.runPromise(program)
// Output:
// count-only run 1
// count-only run 2
// count-only run 3
// spaced run 1
// spaced run 2
// spaced run 3
// count-only total: 3
// spaced total: 3
```

Both policies allow two recurrences after the first run, so both examples run
three times total.

##### Time window

Use `Schedule.during` for a best-effort elapsed window, usually with spacing so
the loop does not spin.

```ts runnable
import { Console, Effect, Ref, Schedule } from "effect"

const program = Effect.gen(function*() {
  const runs = yield* Ref.make(0)

  yield* Ref.updateAndGet(runs, (n) => n + 1).pipe(
    Effect.tap((run) => Console.log(`windowed run ${run}`)),
    Effect.repeat(
      Schedule.spaced("10 millis").pipe(
        Schedule.both(Schedule.during("30 millis"))
      )
    )
  )

  const total = yield* Ref.get(runs)
  yield* Console.log(`windowed total: ${total}`)
})

Effect.runPromise(program)
// Output may vary: elapsed timing can cross the budget boundary differently under load
// windowed run 1
// windowed run 2
// windowed run 3
// windowed run 4
// windowed total: 4
```

The window is checked at recurrence boundaries. It is not a deadline for the
body of the effect.

##### Notes

The off-by-one rule is the main caveat: external requirements often count total
executions, but schedule limits count recurrences after the first execution. If
a requirement says "try three times total", use a limit of `2`.

#### 3.5 Build intuition before composing policies

A `Schedule` is a policy value. It receives an input, produces an output,
requests a delay, and decides whether another run is allowed.

##### What this section is about

This section is about reading one schedule before combining it with another.
A schedule is not the effect being repeated or retried. It is stepped after
`Effect.repeat` sees a success or after `Effect.retry` sees a typed failure.

Once that model is clear, composition is easier: combined schedules are still
made from inputs, outputs, delays, and stop conditions.

##### Four questions

Ask these questions for any schedule:

- What input does it observe?
- What output does it produce?
- What delay does it request?
- When does it stop?

For `Schedule.recurs(n)`, the important axis is stopping. It permits `n`
recurrences after the first execution and outputs the zero-based recurrence
count.

For `Schedule.spaced(duration)`, the important axis is delay. It keeps recurring
and asks for the same delay between completed runs.

For `Schedule.fixed(interval)`, the important axis is clock alignment. It aims
at regular interval boundaries instead of simply waiting a fixed pause after
each run.

For `Schedule.exponential(base, factor)` and `Schedule.fibonacci(one)`, the
important axis is delay growth. They keep recurring until another policy or
entry-point condition stops them.

##### Common mistakes

Do not treat "repeat three times" and "run three times total" as the same
requirement. `Effect.repeat` and `Effect.retry` run once before the schedule
controls additional recurrences.

Do not assume timing policies are bounded. `Schedule.spaced`,
`Schedule.fixed`, `Schedule.exponential`, `Schedule.fibonacci`, and
`Schedule.forever` can continue indefinitely unless another condition stops
them.

Do not assume all delays mean the same thing. A spaced policy waits between
runs, a fixed policy aims at interval boundaries, and a backoff policy changes
the delay from step to step.

##### Practical guidance

Before composing policies, describe each one in a short sentence:

- A count policy says how many recurrences are allowed after the first run.
- A timing policy says whether the delay is spacing, clock alignment, or growth.
- An output-producing policy says whether the useful value is a count, duration,
  input, or transformed value.

Prefer the smallest schedule that states the behavior you need now. Add
composition only when there is a second policy to express, such as "retry three
times and wait between attempts."

## Part II — Retry Recipes

### 4. Retry Limits and Simple Delays

#### 4.1 Retry up to 3 times

Use `Effect.retry({ times: 3 })` when a typed failure should get up to three
more attempts before the final failure is returned.

##### Problem

The operation may fail briefly, and immediate retry is acceptable. The original
attempt runs once; the policy allows up to three retries after that.

##### When to use it

Use this for cheap, idempotent work where a short burst is useful: a local
resource conflict, a dependency warming up, or a read that can fail during a
brief restart.

Use a delay or backoff instead when retrying immediately would increase pressure
on a remote or overloaded dependency.

##### Schedule shape

The options form is the smallest expression:

| Policy                       | Maximum total executions |
| ---------------------------- | ------------------------ |
| `Effect.retry({ times: 0 })` | 1                        |
| `Effect.retry({ times: 1 })` | 2                        |
| `Effect.retry({ times: 3 })` | 4                        |

`Schedule.recurs(3)` has the same retry-count meaning when used with
`Effect.retry`.

Beginner note: Recurrence counts — retry budgets count follow-up attempts, not
the original attempt.

If an attempt succeeds, retrying stops immediately. If every permitted attempt
fails, `Effect.retry` returns the last typed failure.

##### Example

```ts runnable deterministic
import { Console, Data, Effect } from "effect"

class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly attempt: number
}> {}

let attempt = 0

const callService = Effect.gen(function*() {
  attempt += 1
  yield* Console.log(`attempt ${attempt}`)

  if (attempt < 4) {
    return yield* Effect.fail(new ServiceUnavailable({ attempt }))
  }

  return "service response"
})

const program = callService.pipe(
  Effect.retry({ times: 3 }),
  Effect.tap((response) => Console.log(`completed: ${response}`))
)

Effect.runPromise(program)
// Output:
// attempt 1
// attempt 2
// attempt 3
// attempt 4
// completed: service response
```

Attempts 1, 2, and 3 fail. Attempt 4 is the third retry, so it is still inside
the budget and can succeed.

##### Variants

Use `Schedule.recurs(3)` when the retry policy should be named or composed with
timing later. Use `Effect.retry(callService, Schedule.recurs(3))` when the
two-argument style reads better at the call site.

Add `while` or `until` when only some typed failures should be retried. The
retry count still caps the number of retries.

##### Notes

The first execution is not counted as a retry. If a requirement says "try this
at most three times total", use `times: 2` or `Schedule.recurs(2)`.

`Effect.retry` retries typed failures from the error channel. It does not retry
defects or interruptions.

#### 4.2 Retry with a small constant delay

Combine `Schedule.spaced(duration)` with a count limit when immediate retries
are too aggressive but full backoff is unnecessary.

##### Problem

The retry policy needs two constraints: wait a fixed amount before each retry,
and stop after a small number of retries.

##### When to use it

Use this for short-lived failures where a tiny pause helps: local service
startup, brief lock contention, or an idempotent request to a dependency that
usually recovers quickly.

Do not use a constant delay as the default for overloaded or rate-limited
systems. Those usually need backoff, jitter, or error-specific handling.

##### Schedule shape

`Schedule.spaced(duration)` keeps recurring with the same delay. `Schedule.recurs(n)`
caps the retry count. `Schedule.both` combines them with intersection semantics:
both schedules must continue, and the combined delay is the maximum of their
delays.

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class TemporaryRequestError extends Data.TaggedError("TemporaryRequestError")<{
  readonly attempt: number
}> {}

let attempt = 0

const request = Effect.gen(function*() {
  attempt += 1
  yield* Console.log(`attempt ${attempt}`)

  if (attempt < 4) {
    return yield* Effect.fail(new TemporaryRequestError({ attempt }))
  }

  return { id: "user-1", name: "Ada" }
})

const retryPolicy = Schedule.spaced("25 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const program = request.pipe(
  Effect.retry(retryPolicy),
  Effect.tap((user) => Console.log(`loaded ${user.name}`))
)

Effect.runPromise(program)
// Output:
// attempt 1
// attempt 2
// attempt 3
// attempt 4
// loaded Ada
```

The policy allows three retries and waits 25 milliseconds before each retry.
The first execution is not delayed.

##### Variants

For a local policy, `Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 3 })`
expresses the same count and delay. Use the explicit schedule composition when
you want to name, reuse, or extend the policy.

Changing the duration changes only the pause between attempts; the retry count
is still controlled by `Schedule.recurs(3)`.

##### Notes

`Effect.retry` stops at the first success. The combined schedule output is not
the final success value; it only controls whether and when another retry should
happen.

Keep the retried effect small and safe to run more than once.

#### 4.3 Retry immediately, but only briefly

Use `Schedule.recurs(n)` when a failure is likely to disappear right away and
only a small retry burst is acceptable.

##### Problem

The policy should retry without delay, but it still needs a hard cap. The count
limit prevents an immediate retry loop from continuing indefinitely.

##### When to use it

Use this when the operation is cheap, safe to repeat, and likely failing because
of a short local race or momentary unavailability. One or two immediate retries
is often enough.

Do not use this against dependencies that may be overloaded. Remote calls,
database reconnects, queue consumers, and rate-limited APIs usually need delay
or backoff.

##### Schedule shape

`Schedule.recurs(times)` ignores its input and outputs a zero-based recurrence
count. With `Effect.retry`, the input is the typed error from the failed
attempt, but the successful result is still the value produced by the retried
effect.

The count is a retry count:

- `Schedule.recurs(0)` allows no retries.
- `Schedule.recurs(1)` allows one retry.
- `Schedule.recurs(2)` allows two retries.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Ref, Schedule } from "effect"

class CacheBusy extends Data.TaggedError("CacheBusy")<{
  readonly attempt: number
}> {}

const readSnapshot = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`attempt ${attempt}`)

  if (attempt <= 2) {
    return yield* Effect.fail(new CacheBusy({ attempt }))
  }

  return { version: "v1", entries: 42 }
})

const retryBriefly = Schedule.recurs(2)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)

  const snapshot = yield* readSnapshot(attempts).pipe(
    Effect.retry(retryBriefly)
  )

  yield* Console.log(`snapshot ${snapshot.version}: ${snapshot.entries} entries`)
})

Effect.runPromise(program)
// Output:
// attempt 1
// attempt 2
// attempt 3
// snapshot v1: 42 entries
```

The first two attempts fail, and the second retry succeeds. If the third attempt
failed too, `Effect.retry` would return that final `CacheBusy` failure.

##### Variants

For a local policy, `Effect.retry({ times: 2 })` has the same retry-count
meaning. Keep `Schedule.recurs(2)` when the policy should be named, shared, or
combined with timing later.

##### Notes

The first attempt always runs. If it succeeds, no retry happens.

This recipe deliberately avoids delay, backoff, and jitter. Once the operation
crosses a process, network, or rate-limit boundary, use a paced retry policy.

#### 4.4 Retry until the first success

`Effect.retry` stops as soon as one attempt succeeds. The schedule is only
consulted after typed failures.

##### Problem

The operation may fail a few times, but the first success should complete the
whole workflow and leave any remaining retry budget unused.

##### When to use it

Use this when success means the work is done: connecting to a service, reading a
temporarily unavailable value, or retrying an idempotent request after transient
typed failures.

Use `Effect.repeat` instead when successful values should drive more executions.

##### Schedule shape

For `Effect.retry`, each typed failure is offered to the schedule:

- If the schedule continues, the effect is run again.
- If the schedule stops, the last typed failure is returned.
- If the next attempt succeeds, the whole retried effect succeeds immediately.

`Schedule.recurs(4)` permits up to five total executions, but fewer executions
happen when an earlier attempt succeeds.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Ref, Schedule } from "effect"

class TemporaryError extends Data.TaggedError("TemporaryError")<{
  readonly attempt: number
}> {}

const flakyRequest = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`attempt ${attempt}`)

  if (attempt < 3) {
    return yield* Effect.fail(new TemporaryError({ attempt }))
  }

  return `success on attempt ${attempt}`
})

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)

  const value = yield* flakyRequest(attempts).pipe(
    Effect.retry(Schedule.recurs(4))
  )

  const totalAttempts = yield* Ref.get(attempts)
  yield* Console.log(`${value}; total attempts: ${totalAttempts}`)
})

Effect.runPromise(program)
// Output:
// attempt 1
// attempt 2
// attempt 3
// success on attempt 3; total attempts: 3
```

The schedule allows four retries, but attempts 4 and 5 never run because
attempt 3 succeeds.

##### Variants

`Effect.retry({ times: 4 })` has the same count-only behavior. Add a schedule,
such as `Schedule.spaced("200 millis").pipe(Schedule.take(4))`, when failures
should be paced. Add `while` or `until` when only some typed failures should be
retried.

The first success still wins. Predicates and schedules only decide what happens
after failures.

##### Notes

Plain `Effect.retry` does not run a fallback when the policy is exhausted. Use
`Effect.retryOrElse` when final failure should trigger recovery.

Prefer a bounded or otherwise controlled schedule when unbounded retry is risky.
For production dependencies, that usually means combining a retry count with a
delay or backoff policy.

#### 4.5 Retry with a delay suitable for external APIs

For simple external API calls, combine a modest fixed delay with a retry limit
and an error predicate. The schedule answers "when"; the predicate answers
"whether this failure is safe to retry."

##### Problem

External APIs can fail transiently at the network or service boundary, but
retrying every failure can hammer the provider or repeat unsafe requests.

##### When to use it

Use this for idempotent external API calls where a short constant pause is
acceptable: reads, metadata lookups, status checks, or writes protected by an
idempotency key.

A one-second delay with a small retry budget is a readable default when the API
does not publish a more specific retry policy.

##### When not to use it

Do not retry client errors such as invalid input, authentication failure,
authorization failure, or most not-found responses. Those usually need to be
returned or handled directly.

Do not ignore provider guidance. If the API returns `Retry-After`, exposes
rate-limit reset metadata, or documents endpoint-specific retry rules, model
that policy instead of using a fixed delay.

##### Schedule shape

The options form keeps the three policy pieces together:

- `schedule: Schedule.spaced("1 second")` waits one second before each retry
- `times: 4` permits four retries after the original attempt
- `while: isRetryableApiError` retries only selected typed failures

If an attempt succeeds, retrying stops immediately. If a non-retryable error is
returned, the retry budget is not spent.

##### Example

```ts
import { Console, Data, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

class ExternalApiError extends Data.TaggedError("ExternalApiError")<{
  readonly attempt: number
  readonly status: number
}> {}

interface Customer {
  readonly id: string
  readonly name: string
}

const fetchCustomer = Effect.fnUntraced(function*(
  id: string,
  attempts: Ref.Ref<number>
) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`api attempt ${attempt}`)

  if (attempt < 3) {
    return yield* Effect.fail(new ExternalApiError({ attempt, status: 503 }))
  }

  return { id, name: "Ada" } satisfies Customer
})

const isRetryableApiError = (error: ExternalApiError) =>
  error.status === 408 ||
  error.status === 429 ||
  error.status >= 500

const retryExternalApi = {
  schedule: Schedule.spaced("1 second"),
  times: 4,
  while: isRetryableApiError
}

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* fetchCustomer("customer-123", attempts).pipe(
    Effect.retry(retryExternalApi),
    Effect.forkScoped
  )

  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("1 second")

  const customer = yield* Fiber.join(fiber)
  yield* Console.log(`customer: ${customer.id} ${customer.name}`)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program).then(() => undefined)
```

The API fails twice with a retryable `503`, waits one virtual second before
each retry, and then returns the customer.

##### Notes

`times: 4` means four retries after the original attempt, so the API can be
called at most five times. If a provider says "four total attempts", use
`times: 3`.

A fixed delay is intentionally simple. It does not inspect headers, adapt to
congestion, add jitter, or cap long-running retry behavior.

Keep the retry boundary around the single idempotent API call. Avoid wrapping
local writes, notifications, or other effects that should not run more than
once.

#### 4.6 Retry with different fixed delays for different environments

Keep the retry shape stable and select only the delay from configuration. The
operation, retry budget, and retryability rules should not drift just because
the program is running locally, in staging, or in production.

##### Problem

Development often benefits from shorter retry delays, while production should
avoid fast retry pressure. You need the environment to choose the fixed delay
without changing the rest of the policy.

##### When to use it

Use this when the operation is safe to retry and timing is the only
environment-specific difference. It fits idempotent service calls, reconnects,
and dependency probes where local responsiveness and production restraint are
both useful.

##### When not to use it

Do not use environment-specific delays to hide a different policy. If
production needs fewer retries, stricter error filtering, backoff, jitter, or a
fallback path, model that explicitly.

Do not make a non-idempotent operation safe by changing the delay. Duplicate
side effects still need a domain-level guarantee such as an idempotency key.

##### Schedule shape

The environment selects a `Duration.Input`, and `Schedule.spaced(delay)` uses
that same delay before each retry.

Combining it with `Schedule.recurs(3)` keeps the shape bounded: one original
attempt, then at most three retries. `Schedule.both` requires both schedules to
continue; the spaced schedule supplies the delay, and the recurrence schedule
supplies the limit.

##### Example

```ts
import { Console, Data, Duration, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

type Environment = "development" | "staging" | "production"

class RequestError extends Data.TaggedError("RequestError")<{
  readonly attempt: number
}> {}

const request = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`request attempt ${attempt}`)

  if (attempt < 3) {
    return yield* Effect.fail(new RequestError({ attempt }))
  }

  return "accepted"
})

const retryDelays: Record<Environment, Duration.Input> = {
  development: "50 millis",
  staging: "250 millis",
  production: "1 second"
}

const retryPolicy = (environment: Environment) =>
  Schedule.spaced(retryDelays[environment]).pipe(
    Schedule.both(Schedule.recurs(3))
  )

const runRequest = Effect.fnUntraced(function*(
  environment: Environment,
  attempts: Ref.Ref<number>
) {
  return yield* request(attempts).pipe(
    Effect.retry(retryPolicy(environment))
  )
})

const program = Effect.gen(function*() {
  const environment: Environment = "production"
  const attempts = yield* Ref.make(0)
  const fiber = yield* runRequest(environment, attempts).pipe(Effect.forkScoped)

  yield* TestClock.adjust(retryDelays[environment])
  yield* TestClock.adjust(retryDelays[environment])

  const result = yield* Fiber.join(fiber)
  yield* Console.log(`result in ${environment}: ${result}`)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program).then(() => undefined)
```

The example uses the production delay, so each retry waits one virtual second.
Changing `environment` to `"development"` keeps the same retry limit and uses
50 milliseconds instead.

##### Notes

`Schedule.spaced` is the usual fixed-delay constructor for retry policies. It
waits after a failure before the next attempt. `Schedule.fixed` is for
maintaining a recurring wall-clock cadence and is not the right default here.

The environment is selected when the policy is built. If configuration can
change at runtime, rebuild the policy at the boundary where `Effect.retry` is
called.

`Effect.retry` retries typed failures from the error channel. Defects and fiber
interruptions are not retried as typed failures.

### 5. Exponential and Capped Backoff

#### 5.1 Basic exponential backoff

`Schedule.exponential(base)` starts with `base` as the first retry delay and
multiplies later delays by the factor, which defaults to `2`.

##### Problem

A dependency may be unhealthy long enough that fixed-delay retries keep adding
pressure. You want early recovery to be quick, but repeated failures should
make the caller slow down.

##### When to use it

Use exponential backoff for idempotent operations whose failures are probably
temporary: network calls, brief service unavailability, short database
failovers, or dependency probes.

It is a better remote-call default than a tight loop because each failed retry
decision increases the pause before the next attempt.

##### When not to use it

Do not use backoff for operations that are unsafe to run more than once.
Retried writes need idempotency, deduplication, transactions, or another
domain-specific guarantee.

Do not leave the schedule unbounded unless retrying forever is intentional and
the fiber is supervised. Basic exponential backoff also has no jitter, so many
callers that fail together can still retry together.

##### Schedule shape

`Schedule.exponential("100 millis")` produces these retry delays with the
default factor:

- first retry: 100 milliseconds
- second retry: 200 milliseconds
- third retry: 400 milliseconds
- fourth retry: 800 milliseconds

With `Effect.retry`, the original attempt is immediate. The schedule is
consulted only after a typed failure. Pair it with `Schedule.recurs(5)` or
`times: 5` when the caller needs a final failure after five retries.

##### Example

```ts
import { Console, Data, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

class RequestError extends Data.TaggedError("RequestError")<{
  readonly attempt: number
}> {}

const fetchUser = Effect.fnUntraced(function*(id: string, attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`fetch user attempt ${attempt}`)

  if (attempt < 4) {
    return yield* Effect.fail(new RequestError({ attempt }))
  }

  return { id, name: "Ada" }
})

const retryWithBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(5))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* fetchUser("user-123", attempts).pipe(
    Effect.retry(retryWithBackoff),
    Effect.forkScoped
  )

  yield* TestClock.adjust("100 millis")
  yield* TestClock.adjust("200 millis")
  yield* TestClock.adjust("400 millis")

  const user = yield* Fiber.join(fiber)
  yield* Console.log(`loaded user: ${user.name}`)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program).then(() => undefined)
```

The example fails three times, then succeeds on the fourth attempt. The virtual
clock advances through the 100, 200, and 400 millisecond backoff delays, so the
snippet terminates immediately.

##### Notes

The first execution is not delayed. Backoff begins only after the effect fails
with a typed error.

`Schedule.recurs(5)` means five retries after the original attempt, so the
effect can run up to six times.

`Schedule.exponential` outputs the current delay. After `Schedule.both`, the
combined output is a tuple of the exponential delay and the recurrence count.
Plain `Effect.retry` uses that output for scheduling and returns the successful
value of the retried effect.

#### 5.2 Backoff for transient network failures

Network failures are often temporary, but repeated retry attempts should slow
down. Use exponential backoff with a finite retry budget and retry only the
typed failures that are plausibly transient.

##### Problem

Remote calls can fail because of connection resets, timeouts, temporary DNS
failures, or gateway errors. Retrying immediately can turn a small transport
problem into extra load on both the service and the client.

##### When to use it

Use this for idempotent network calls: reads, status checks, reconnects, and
writes protected by an idempotency key.

It is useful when the request itself is valid and the failure is about the
transport path or temporary gateway behavior. A timeout may succeed later; an
invalid request usually will not.

##### When not to use it

Do not retry permanent request problems such as invalid input, authentication
failure, authorization failure, or response decoding failures.

Do not ignore server guidance. If an API returns `Retry-After` or explicit
rate-limit metadata, prefer a policy that honors it.

##### Schedule shape

`Schedule.exponential("100 millis")` starts at 100 milliseconds and doubles
after each failed retry decision. `Schedule.recurs(5)` limits the policy to
five retries after the original attempt.

In the options form, `while` filters the typed error before spending another
retry. If the predicate returns `false`, `Effect.retry` fails with that error
immediately.

##### Example

```ts
import { Console, Data, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

class NetworkFailure extends Data.TaggedError("NetworkFailure")<{
  readonly reason: "ConnectionReset" | "Timeout" | "TemporaryDnsFailure"
}> {}

class HttpFailure extends Data.TaggedError("HttpFailure")<{
  readonly status: number
}> {}

class DecodeFailure extends Data.TaggedError("DecodeFailure")<{
  readonly message: string
}> {}

type FetchUserError = NetworkFailure | HttpFailure | DecodeFailure

const fetchUser = Effect.fnUntraced(function*(id: string, attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`network attempt ${attempt}`)

  if (attempt === 1) {
    return yield* Effect.fail(new NetworkFailure({ reason: "Timeout" }))
  }
  if (attempt === 2) {
    return yield* Effect.fail(new HttpFailure({ status: 502 }))
  }

  return { id, name: "Ada" }
})

const isRetryableNetworkFailure = (error: FetchUserError): boolean => {
  switch (error._tag) {
    case "NetworkFailure":
      return true
    case "HttpFailure":
      return error.status === 408 || error.status === 502 || error.status === 504
    case "DecodeFailure":
      return false
  }
}

const networkBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(5))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* fetchUser("user-123", attempts).pipe(
    Effect.retry({
      schedule: networkBackoff,
      while: isRetryableNetworkFailure
    }),
    Effect.forkScoped
  )

  yield* TestClock.adjust("100 millis")
  yield* TestClock.adjust("200 millis")

  const user = yield* Fiber.join(fiber)
  yield* Console.log(`loaded user: ${user.name}`)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program).then(() => undefined)
```

The first failure is a timeout, the second is a retryable gateway failure, and
the third attempt succeeds. A `DecodeFailure` would stop immediately because
the predicate returns `false`.

##### Notes

The first request is not delayed. Backoff begins only after the effect fails
with a typed error.

`Schedule.exponential` is unbounded by itself. Pair it with `Schedule.recurs`,
`times`, a deadline, or another stopping condition unless unbounded retry is
intentional.

For many concurrent callers, add jitter later so callers do not all retry on
the same exponential intervals.

#### 5.3 Backoff for overloaded downstream services

When a dependency reports overload, each failed retry should reduce this
caller's pressure on that dependency. Exponential backoff gives that behavior
for one call site.

##### Problem

A downstream service may return overload errors, reject requests, or fail
because a pool is saturated. Retrying at a fixed rate keeps adding traffic
while the dependency is least able to handle it.

##### When to use it

Use this when the failure is a typed retryable overload signal, such as `503
Service Unavailable`, `429 Too Many Requests`, queue saturation, or short-lived
connection pool exhaustion.

The retried operation must be idempotent or otherwise duplicate-safe.

##### When not to use it

Do not use backoff to hide permanent failures such as invalid input, missing
authorization, or a request shape the downstream will never accept.

Do not treat per-request backoff as the whole overload strategy for a busy
client. If many fibers can call the same service concurrently, also consider
admission control such as queues, rate limits, or concurrency limits.

##### Schedule shape

`Schedule.exponential("100 millis")` yields retry delays of 100 milliseconds,
200 milliseconds, 400 milliseconds, 800 milliseconds, and so on. Combining it
with `Schedule.recurs(5)` permits at most five retries after the original
attempt.

`Schedule.both` requires both schedules to continue. The exponential schedule
contributes the growing delay, and the recurrence schedule contributes the
limit.

##### Example

```ts
import { Console, Data, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

class DownstreamOverloaded extends Data.TaggedError("DownstreamOverloaded")<{
  readonly service: string
  readonly attempt: number
}> {}

const callInventory = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`inventory attempt ${attempt}`)

  if (attempt < 4) {
    return yield* Effect.fail(
      new DownstreamOverloaded({ service: "inventory", attempt })
    )
  }

  return { sku: "sku-123", available: true }
})

const overloadBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(5))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* callInventory(attempts).pipe(
    Effect.retry(overloadBackoff),
    Effect.forkScoped
  )

  yield* TestClock.adjust("100 millis")
  yield* TestClock.adjust("200 millis")
  yield* TestClock.adjust("400 millis")

  const result = yield* Fiber.join(fiber)
  yield* Console.log(`available: ${result.available}`)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program).then(() => undefined)
```

The first three calls fail with `DownstreamOverloaded`. The retry delays grow
from 100 to 200 to 400 milliseconds, then the fourth call succeeds.

##### Notes

Backoff only affects retry attempts after typed failures. It does not delay the
original request.

Keep the retried effect narrow. Retry the downstream request itself, not a
larger workflow that may already have performed local writes or sent
notifications.

In high fan-out clients, add a cap and jitter so many callers do not retry at
the same growing intervals.

#### 5.4 Backoff for startup dependency readiness

Startup often races with nearby services. A bounded exponential retry can wait
for a dependency to become ready without turning startup into an endless loop.

##### Problem

A database may accept connections a few seconds after the app process starts,
or a local cache may still be warming. The app should wait briefly, with
increasing pauses, and then fail startup clearly if readiness never arrives.

##### When to use it

Use this for idempotent readiness checks: opening a connection, pinging a
service, or verifying that a required endpoint accepts requests.

It fits local development, tests, containers, and deployments where process
ordering is not the same thing as dependency readiness.

##### When not to use it

Do not retry misconfiguration. Bad credentials, invalid host names, missing
schemas, and authorization errors should usually fail startup immediately.

Do not wrap non-idempotent setup work in this policy. Migrations, table
creation, message publication, and external registration need their own
duplicate-safe design before they can be retried.

##### Schedule shape

`Schedule.exponential("200 millis")` produces 200 millisecond, 400
millisecond, 800 millisecond, and 1.6 second delays with the default factor.

`Schedule.recurs(8)` allows eight retries after the original readiness check.
Combined with `Schedule.both`, the exponential schedule supplies the delay and
the recurrence schedule stops the policy after the retry budget is exhausted.

##### Example

```ts
import { Console, Data, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

class DependencyNotReady extends Data.TaggedError("DependencyNotReady")<{
  readonly dependency: string
  readonly attempt: number
}> {}

const waitForDatabase = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`database readiness attempt ${attempt}`)

  if (attempt < 4) {
    return yield* Effect.fail(
      new DependencyNotReady({ dependency: "database", attempt })
    )
  }
})

const startApplication = Console.log("application started")

const startupDependencyBackoff = Schedule.exponential("200 millis").pipe(
  Schedule.both(Schedule.recurs(8))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* Effect.gen(function*() {
    yield* waitForDatabase(attempts).pipe(
      Effect.retry(startupDependencyBackoff)
    )
    yield* startApplication
  }).pipe(Effect.forkScoped)

  yield* TestClock.adjust("200 millis")
  yield* TestClock.adjust("400 millis")
  yield* TestClock.adjust("800 millis")

  yield* Fiber.join(fiber)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program).then(() => undefined)
```

The readiness check fails three times, backs off through 200, 400, and 800
milliseconds, then starts the application.

##### Notes

The first readiness check runs immediately. Only retry attempts are delayed.

`Schedule.recurs(8)` means eight retries after the original attempt, so this
policy allows up to nine readiness checks.

Retry the readiness check itself, not the entire startup workflow. Initialization
steps that already succeeded should not be run again because a later dependency
probe failed.

#### 5.5 Backoff with a practical base interval

The `base` passed to `Schedule.exponential(base, factor?)` is the first retry
delay. Choose it from the operation's real latency and recovery expectations,
not from the later delays you eventually want.

##### Problem

A base interval that is too small behaves like immediate retry for the first
few failures. A base interval that is too large can make recoverable
user-facing failures feel slow.

##### When to use it

Use this when retries should start soon, but repeated failures should become
less frequent. A base of a few hundred milliseconds is often practical for
idempotent remote calls where immediate retry is too aggressive and a
multi-second first retry is too slow.

It is also useful when moving from fixed delays to backoff: keep the first
retry near the fixed delay that already worked, then let the exponential shape
reduce pressure if failures continue.

##### When not to use it

Do not use tiny base intervals such as 1 millisecond for remote dependencies.
They can add load before the dependency has had time to recover.

Do not make the base large only because later retries need to be far apart. If
the first retry should be quick but later retries need a ceiling, add a cap as
a separate policy choice.

##### Schedule shape

`Schedule.exponential(base, factor?)` always recurs and returns the current
delay. The default factor is `2`, so `Schedule.exponential("500 millis")`
produces approximately 500 milliseconds, 1 second, 2 seconds, and 4 seconds.

With `Effect.retry`, the original attempt runs immediately. The base interval
is the first pause after a typed failure.

##### Example

```ts
import { Console, Data, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

class ServiceError extends Data.TaggedError("ServiceError")<{
  readonly attempt: number
  readonly status: number
}> {}

const loadAccount = Effect.fnUntraced(function*(id: string, attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`account attempt ${attempt}`)

  if (attempt < 4) {
    return yield* Effect.fail(new ServiceError({ attempt, status: 503 }))
  }

  return { id, balance: 100 }
})

const isRetryableServiceError = (error: ServiceError) =>
  error.status === 408 ||
  error.status === 429 ||
  error.status >= 500

const retryWithPracticalBackoff = {
  schedule: Schedule.exponential("500 millis"),
  times: 4,
  while: isRetryableServiceError
}

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* loadAccount("account-123", attempts).pipe(
    Effect.retry(retryWithPracticalBackoff),
    Effect.forkScoped
  )

  yield* TestClock.adjust("500 millis")
  yield* TestClock.adjust("1 second")
  yield* TestClock.adjust("2 seconds")

  const account = yield* Fiber.join(fiber)
  yield* Console.log(`balance: ${account.balance}`)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program).then(() => undefined)
```

The first retry waits 500 milliseconds, then the next retries wait about 1
second and 2 seconds. The example advances virtual time so the full backoff
shape runs immediately.

##### Notes

`Schedule.exponential(base, factor?)` does not stop on its own. For
request/response work, combine it with `times`, `Schedule.recurs`, a predicate,
or another stopping condition.

Choose the base from the operation's timing. Local coordination may only need
tens of milliseconds. External APIs often need a few hundred milliseconds or a
full second. Slow recovery paths should start larger.

Caps and jitter are common production refinements, especially for large fleets
or rate-limited services, but they are separate choices from the base interval.

#### 5.6 Exponential backoff with a maximum delay

Use capped exponential backoff when early retries should spread out quickly, but
no single wait should exceed a known maximum.

##### Problem

Plain `Schedule.exponential` keeps growing. That is useful at first, but later
delays can exceed the request budget, worker lease, or supervisor timeout.

Cap the delay by combining exponential backoff with `Schedule.spaced(maxDelay)`
using `Schedule.either`. `either` continues while either schedule continues and
uses the smaller delay. Add `Schedule.recurs(n)` with `Schedule.both` when the
policy also needs a retry limit.

##### When to use it

Use this shape for transient failures in idempotent calls: external APIs,
databases, queues, caches, and service clients. The first retries happen soon,
then the delay settles at the cap instead of growing without bound.

The cap is a per-retry maximum. It is not a total timeout and does not interrupt
an attempt that is already running.

##### When not to use it

Do not retry operations that are unsafe to run more than once unless the call is
made idempotent with a key, transaction, de-duplication, or another domain
guarantee.

Do not use capped backoff alone for high fan-out clients. If many callers can
fail together, combine the policy with jitter, admission control, or rate
limits.

##### Schedule shape

With a base of 10 milliseconds and a cap of 40 milliseconds, the delay sequence
is 10 milliseconds, 20 milliseconds, 40 milliseconds, 40 milliseconds, and so
on. The exponential side wants to continue forever, and the spaced side also
wants to continue forever, so `Schedule.recurs(n)` supplies the stopping point.

`Schedule.both(Schedule.recurs(n))` keeps the capped delay because `recurs`
adds no meaningful wait. It only contributes the retry budget. `Schedule.recurs(4)`
means four retries after the original attempt, so the effect can run up to five
times total.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number
}> {}

let attempts = 0

const request = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`request attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(new ApiError({ status: 503 }))
  }

  return "response body"
})

const cappedBackoff = Schedule.exponential("10 millis").pipe(
  Schedule.either(Schedule.spaced("40 millis")),
  Schedule.both(Schedule.recurs(4))
)

const program = request.pipe(
  Effect.retry(cappedBackoff),
  Effect.tap((body) => Console.log(`success: ${body}`))
)

Effect.runPromise(program).then(() => undefined, console.error)
// Output:
// request attempt 1
// request attempt 2
// request attempt 3
// request attempt 4
// success: response body
```

The first call is immediate. If it fails with a typed `ApiError`, the next waits
10 milliseconds. Later failures wait 20 milliseconds, then 40 milliseconds, and
the cap prevents longer waits. If all four retries fail, `Effect.retry`
propagates the last `ApiError`.

##### Variants

For interactive work, use a small base, a small cap, and a short retry budget,
for example a 50 millisecond base capped at 1 second with three to five
retries.

For background work, use a larger base and cap, such as 500 milliseconds capped
at 30 seconds, but still keep an explicit retry count unless retrying forever is
intentional.

When only some typed failures are retryable, keep the capped schedule and pass
`Effect.retry({ schedule, while })`. The `while` predicate decides which errors
may consume retry budget; the schedule still decides timing and count.

##### Notes and caveats

There is no dedicated cap constructor in this recipe. The cap comes from
`Schedule.either(Schedule.spaced(maxDelay))`.

Do not replace `either` with `both` for the cap. `Schedule.both` uses the larger
delay, so pairing exponential backoff directly with fixed spacing would wait at
least the fixed duration from the first retry.

The composed schedule output is nested composition data. Plain `Effect.retry`
uses it for timing and stopping, then returns the successful value produced by
the retried effect.

#### 5.7 Preventing excessively long waits

Use a capped schedule when exponential growth is useful, but very long waits are
not useful to the caller.

##### Problem

After enough failures, exponential backoff can wait longer than the operation is
worth. The caller may need a failure result, the job may need to release its
lease, or an operator may expect the workflow to stop within a known window.

Use `Schedule.either` with a fixed `Schedule.spaced` schedule to cap each delay,
then add a separate retry limit. The cap and retry count solve different
problems and usually belong together.

##### When to use it

Use this policy for idempotent calls to services that may be overloaded,
rate-limited, restarting, or briefly unavailable. Short early waits absorb
small interruptions. The cap prevents later waits from becoming operationally
surprising.

Choose the cap from the caller's budget, not from the downstream service alone.
A web request, queue job, and supervisor loop often need different caps for the
same dependency.

##### When not to use it

Do not retry permanent failures such as invalid input, missing authorization, or
a request the downstream will never accept. Those should fail fast or be handled
by domain logic.

Do not treat the delay cap as an attempt timeout. A schedule controls the delay
between attempts; it does not stop an attempt that is currently running.

##### Schedule shape

`Schedule.exponential("10 millis")` produces 10 milliseconds, 20 milliseconds,
40 milliseconds, 80 milliseconds, and so on. `Schedule.spaced("50 millis")`
always contributes 50 milliseconds. `Schedule.either` chooses the smaller delay,
so the effective sequence is 10 milliseconds, 20 milliseconds, 40 milliseconds,
50 milliseconds, 50 milliseconds, and so on.

`Schedule.both(Schedule.recurs(5))` makes the policy finite. `both` continues
only while both schedules continue, so the retry count stops the otherwise
unbounded capped backoff.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly service: string
  readonly status: number
}> {}

interface AccountSummary {
  readonly id: string
  readonly balance: number
}

let attempts = 0

const loadAccountSummary = (id: string): Effect.Effect<AccountSummary, ServiceUnavailable> =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`load ${id}: attempt ${attempts}`)

    if (attempts < 4) {
      return yield* Effect.fail(
        new ServiceUnavailable({
          service: "accounts",
          status: 503
        })
      )
    }

    return { id, balance: 125 }
  })

const cappedBackoff = Schedule.exponential("10 millis").pipe(
  Schedule.either(Schedule.spaced("50 millis")),
  Schedule.both(Schedule.recurs(5))
)

const program = loadAccountSummary("account-123").pipe(
  Effect.retry(cappedBackoff),
  Effect.tap((account) => Console.log(`balance: ${account.balance}`))
)

Effect.runPromise(program).then(() => undefined, console.error)
// Output:
// load account-123: attempt 1
// load account-123: attempt 2
// load account-123: attempt 3
// load account-123: attempt 4
// balance: 125
```

The first attempt runs immediately. If it fails, retries use the capped delay
sequence and stop after at most five retries. If every permitted attempt fails,
`Effect.retry` returns the last `ServiceUnavailable`.

##### Variants

For user-facing flows, use a low cap and a small retry count so the UI can move
to an error state quickly.

For background workflows, a higher cap can be acceptable, but keep the retry
budget explicit unless another layer owns the stopping condition.

When only some typed failures are retryable, use `Effect.retry({ schedule,
while })` and keep the predicate close to the boundary where the error is
known.

##### Notes and caveats

`Schedule.either` gives union-style continuation semantics and uses the minimum
delay. The minimum-delay rule is what creates the cap.

`Schedule.both` applies the finite retry budget. Pairing the capped schedule
with `Schedule.recurs(n)` preserves the capped delay while adding the stopping
condition.

A cap prevents excessive individual waits. It does not add jitter, read
provider-specific retry headers, or make non-idempotent work safe to retry.

#### 5.8 Backoff with both cap and retry limit

Most production retry policies need two bounds: the largest delay between
attempts and the maximum number of retries.

##### Problem

Exponential backoff alone controls pacing, not total retry effort. A cap keeps
one delay from growing too large. A retry limit stops the operation when the
dependency remains unavailable.

Compose the two bounds explicitly: `Schedule.either` caps the delay, and
`Schedule.both(Schedule.recurs(n))` adds the finite retry budget.

##### When to use it

Use this for idempotent calls to HTTP APIs, queues, caches, databases, and
service clients where unlimited retrying would hold resources too long.

This policy is easy to review because the important operational choices are
visible: base delay, maximum delay, and maximum retry count.

##### When not to use it

Do not use this for non-idempotent writes unless repeated execution is safe.

Do not treat the cap as a total timeout. A policy capped at one second and
limited to five retries can still spend several seconds retrying.

Do not rely on this alone when many clients may retry together. Add jitter or
another load-shaping mechanism for large caller populations.

##### Schedule shape

`Schedule.exponential("10 millis")` grows by the default factor of `2`.
Combining it with `Schedule.spaced("40 millis")` through `Schedule.either`
gives a maximum delay of 40 milliseconds. Combining that capped schedule with
`Schedule.recurs(5)` through `Schedule.both` stops after at most five retries.

The original effect still runs immediately. The schedule is consulted only
after a typed failure.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly status: number
}> {}

let attempts = 0

const submitRequest: Effect.Effect<string, GatewayError> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`gateway attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(new GatewayError({ status: 503 }))
  }

  return "accepted"
})

const cappedBackoffWithLimit = Schedule.exponential("10 millis").pipe(
  Schedule.either(Schedule.spaced("40 millis")),
  Schedule.both(Schedule.recurs(5))
)

const program = submitRequest.pipe(
  Effect.retry({
    schedule: cappedBackoffWithLimit,
    while: (error) => error.status === 429 || error.status >= 500
  }),
  Effect.tap((value) => Console.log(`result: ${value}`))
)

Effect.runPromise(program).then(() => undefined, console.error)
// Output:
// gateway attempt 1
// gateway attempt 2
// gateway attempt 3
// gateway attempt 4
// result: accepted
```

The retryable failures wait 10 milliseconds, 20 milliseconds, then at most 40
milliseconds. If the original attempt and all five retries fail, the program
fails with the last `GatewayError`.

##### Variants

For an interactive request, use a smaller cap and fewer retries. For background
work, use a larger cap and budget only when the owning worker or supervisor can
afford the total time.

When only some typed failures should be retried, keep the same schedule and
change the `while` predicate in `Effect.retry`.

##### Notes and caveats

Use `Schedule.either(Schedule.spaced(maxDelay))` for the cap. Use
`Schedule.both(Schedule.recurs(n))` for the retry limit.

`Schedule.recurs(n)` counts retries after the original attempt, not total
attempts.

The schedule output is nested composition data from `either` and `both`. Plain
`Effect.retry` uses that output for retry decisions and returns the successful
value of the retried effect.

### 6. Retry Budgets and Deadlines

#### 6.1 Retry for at most 10 seconds

Use a short elapsed retry window when the caller can tolerate brief recovery
work, but not an open-ended retry loop. The schedule controls retry timing and
stopping. Error classification still belongs in the surrounding `Effect.retry`
options.

##### Problem

Retry transient typed failures with exponential backoff while a 10 second
schedule window remains open. The first attempt runs immediately; the window is
consulted only after a typed failure.

##### When to use it

Use this for idempotent service calls, gateway requests, and short dependency
recovery windows where elapsed retry time matters more than an exact retry
count. It is a good fit for temporary unavailability, overload, and network
failures that often clear quickly.

##### When not to use it

Do not use this as a hard timeout. `Schedule.during("10 seconds")` does not
interrupt the original attempt or any later attempt already in progress.

Do not retry unsafe writes unless the operation has an idempotency key,
transaction boundary, de-duplication, or another guarantee that repeated
execution is safe.

Do not use `Schedule.during` by itself for real retry traffic. It supplies a
time window, not a useful delay.

##### Schedule shape

`Schedule.exponential("100 millis")` produces the retry delays. With the
default factor of `2`, the delays are 100 milliseconds, 200 milliseconds, 400
milliseconds, and so on.

`Schedule.during("10 seconds")` supplies the elapsed schedule window. In a
retry policy, that window starts when the schedule is first stepped after the
first typed failure.

`Schedule.both` requires both schedules to continue and uses the maximum delay.
Here the exponential schedule supplies the wait, and `during` supplies the
stopping condition. A retry decision made just inside the window may still
sleep and run the next attempt after the nominal 10 second boundary.

##### Example

```ts
import { Console, Data, Effect, Schedule } from "effect"

class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly reason: "Unavailable" | "Overloaded" | "BadRequest"
}> {}

interface GatewayResponse {
  readonly body: string
}

let attempts = 0

const callGateway: Effect.Effect<GatewayResponse, GatewayError> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`gateway attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail(
      new GatewayError({
        reason: attempts === 1 ? "Unavailable" : "Overloaded"
      })
    )
  }

  return { body: "ok" }
})

const isRetryableGatewayError = (error: GatewayError): boolean =>
  error.reason === "Unavailable" || error.reason === "Overloaded"

const retryForAtMost10Seconds = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.during("10 seconds"))
)

const program = Effect.gen(function*() {
  const response = yield* callGateway.pipe(
    Effect.retry({
      schedule: retryForAtMost10Seconds,
      while: isRetryableGatewayError
    })
  )

  yield* Console.log(`gateway response: ${response.body}`)
})

Effect.runPromise(program)
```

`BadRequest` would stop immediately because the `while` predicate returns
`false`. If retryable failures continue until the schedule window closes,
`Effect.retry` propagates the last `GatewayError`.

##### Variants and caveats

Use `Schedule.spaced("500 millis").pipe(Schedule.both(Schedule.during("10 seconds")))`
when a fixed cadence is easier on the dependency than exponential backoff.

Add `Schedule.recurs(8)` with another `Schedule.both` when eight retries is
also a real operational cap. The policy then stops when either the time budget
or the retry count is exhausted.

Plain `Effect.retry` uses the schedule for timing and stopping. The successful
value is still the value produced by the retried effect; the composed schedule
output is not returned.

#### 6.2 Retry for at most 1 minute

Use a one-minute retry window when a dependency deserves a bounded recovery
period, but the caller must eventually get a result or the last typed failure.

##### Problem

Run the operation once immediately, then retry typed failures on a one-second
cadence while the one-minute retry window remains open.

##### When to use it

Use this for idempotent reads, service discovery, startup probes, short
reconnect loops, and other boundary calls where a temporary outage may clear
within a minute.

A time window is often clearer than a retry count. Slow failed attempts produce
fewer retries inside the same minute; fast failures may produce more, but both
cases stay bounded by elapsed retry time.

##### When not to use it

Do not use this as an attempt timeout. `Schedule.during("1 minute")` is checked
at retry decision points and does not cancel in-flight work.

Do not use a fixed one-second cadence for many clients that can fail together
unless synchronized retries are acceptable. Add jitter or backoff when a fleet
may retry against the same dependency.

##### Schedule shape

`Schedule.spaced("1 second")` supplies the retry delay. It is unbounded by
itself.

`Schedule.during("1 minute")` supplies the elapsed retry window. It does not
add spacing.

`Schedule.both` keeps retrying only while both sides continue and uses the
maximum delay, so the composed policy preserves the one-second cadence and
stops when the one-minute window closes.

##### Example

```ts
import { Console, Data, Effect, Schedule } from "effect"

class RegistryUnavailable extends Data.TaggedError("RegistryUnavailable")<{
  readonly service: string
}> {}

interface Endpoint {
  readonly host: string
  readonly port: number
}

let attempts = 0

const discoverEndpoint: Effect.Effect<Endpoint, RegistryUnavailable> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`discovery attempt ${attempts}`)

  if (attempts === 1) {
    return yield* Effect.fail(new RegistryUnavailable({ service: "registry" }))
  }

  return { host: "api.internal", port: 443 }
})

const retryForAtMost1Minute = Schedule.spaced("1 second").pipe(
  Schedule.both(Schedule.during("1 minute"))
)

const program = Effect.gen(function*() {
  const endpoint = yield* discoverEndpoint.pipe(
    Effect.retry(retryForAtMost1Minute)
  )

  yield* Console.log(`endpoint: ${endpoint.host}:${endpoint.port}`)
})

Effect.runPromise(program)
```

If every attempt keeps failing until the one-minute retry window closes,
`Effect.retry` propagates the last `RegistryUnavailable`.

##### Variants and caveats

Use `Schedule.exponential("100 millis").pipe(Schedule.both(Schedule.during("1 minute")))`
when repeated failures should slow down over the same one-minute budget.

Add a `while` predicate when only some typed failures should consume the retry
window. The predicate decides eligibility; the schedule still controls cadence
and duration.

The first attempt is not delayed. The elapsed budget starts when the schedule
is first stepped after a typed failure, and a retry scheduled near the end of
the window may begin after the nominal minute.

#### 6.3 Retry until a startup deadline

Use this for startup gates that should wait briefly for a required dependency
before the process begins serving traffic.

##### Problem

Retry a readiness check with exponential backoff while a startup retry window
remains open. If readiness succeeds, startup continues. If the window closes,
startup fails with the last typed readiness error.

##### When to use it

Use this for databases, caches, queues, service endpoints, or local companion
processes that often become reachable shortly after the application starts.

The readiness effect should be safe to repeat: a ping, connection probe, or
idempotent "are you ready?" call.

##### When not to use it

Do not use this as an ongoing health check or supervisor loop. This recipe is a
startup gate.

Do not retry failures that prove startup is misconfigured, such as bad
credentials, invalid hosts, missing schemas, incompatible versions, or
authorization failures.

Do not treat `Schedule.during` as a hard process deadline. It does not
interrupt a readiness attempt that is already running.

##### Schedule shape

`Schedule.exponential("200 millis")` supplies delays of 200 milliseconds, 400
milliseconds, 800 milliseconds, and so on.

`Schedule.during("30 seconds")` supplies the startup retry window. In a retry
policy, the window is checked after typed failures when the schedule decides
whether another retry is allowed.

`Schedule.both` gives intersection semantics: both schedules must continue,
and the retry delay is the maximum of their delays. Here that means backoff
controls waiting and `during` controls when retry scheduling stops.

##### Example

```ts
import { Console, Data, Effect, Schedule } from "effect"

class DependencyNotReady extends Data.TaggedError("DependencyNotReady")<{
  readonly dependency: string
  readonly detail: string
}> {}

class DependencyMisconfigured extends Data.TaggedError("DependencyMisconfigured")<{
  readonly dependency: string
  readonly detail: string
}> {}

type StartupDependencyError = DependencyNotReady | DependencyMisconfigured

let checks = 0

const waitForDatabase: Effect.Effect<void, StartupDependencyError> = Effect.gen(function*() {
  checks += 1
  yield* Console.log(`database readiness check ${checks}`)

  if (checks < 3) {
    return yield* Effect.fail(
      new DependencyNotReady({
        dependency: "database",
        detail: "connection refused"
      })
    )
  }
})

const startApplication = Console.log("application started")

const startupReadinessPolicy = Schedule.exponential("200 millis").pipe(
  Schedule.both(Schedule.during("30 seconds"))
)

const program = Effect.gen(function*() {
  yield* waitForDatabase.pipe(
    Effect.retry({
      schedule: startupReadinessPolicy,
      while: (error) => error._tag === "DependencyNotReady"
    })
  )

  yield* startApplication
})

Effect.runPromise(program)
```

`DependencyMisconfigured` would stop retrying immediately. It is a permanent
startup failure, not a readiness delay.

##### Variants and caveats

Use a gentler policy such as `Schedule.exponential("500 millis", 1.5).pipe(Schedule.both(Schedule.during("2 minutes")))`
when a dependency commonly needs longer to become ready.

Add `Schedule.recurs(12)` with another `Schedule.both` when startup should also
have an attempt cap.

If an individual readiness call can hang, put a timeout around that call. The
schedule bounds retry decisions; it does not cancel work already in progress.

#### 6.4 Retry within a fixed operational budget

Use this when retries must fit inside a known operational window while still
using a normal delay policy.

##### Problem

Retry with exponential backoff, but schedule more attempts only while a 30
second elapsed retry budget remains open.

##### When to use it

Use this for background jobs, webhook delivery, connection setup, cache
refresh, and service calls that should get a short recovery window without
continuing indefinitely.

This shape is useful when the caller cares more about total retry time than the
exact number of retries. Fast failures may get more attempts than slow
failures, but both are bounded by the same schedule window.

##### When not to use it

Do not use this as a hard deadline for an individual attempt. A schedule is
consulted after an attempt fails with a typed error; it does not interrupt
in-flight work.

Do not use a time budget to hide permanent failures. Invalid credentials, bad
input, forbidden tenants, and misconfiguration should usually stop through a
retry predicate.

##### Schedule shape

`Schedule.exponential("200 millis")` supplies the retry delay. With the default
factor of `2`, it grows as 200 milliseconds, 400 milliseconds, 800
milliseconds, 1.6 seconds, and so on.

`Schedule.during("30 seconds")` supplies the elapsed recurrence window and no
practical delay.

`Schedule.both` requires both sides to continue and uses the maximum delay, so
the backoff is preserved while the `during` side determines when retry
scheduling must stop.

##### Example

```ts
import { Console, Data, Effect, Schedule } from "effect"

class TemporaryGatewayError extends Data.TaggedError("TemporaryGatewayError")<{
  readonly status: 429 | 500 | 502 | 503 | 504
}> {}

let attempts = 0

const callGateway: Effect.Effect<string, TemporaryGatewayError> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`gateway call ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail(new TemporaryGatewayError({ status: 503 }))
  }

  return "accepted"
})

const retryWithinBudget = Schedule.exponential("200 millis").pipe(
  Schedule.both(Schedule.during("30 seconds"))
)

const program = Effect.gen(function*() {
  const result = yield* callGateway.pipe(
    Effect.retry({
      schedule: retryWithinBudget,
      while: (error) => error.status === 429 || error.status >= 500
    })
  )

  yield* Console.log(`gateway result: ${result}`)
})

Effect.runPromise(program)
```

If retryable failures continue until the 30 second window closes,
`Effect.retry` returns the last `TemporaryGatewayError`.

##### Variants and caveats

Use `Schedule.spaced("1 second").pipe(Schedule.both(Schedule.during("20 seconds")))`
when the dependency should see a steady retry cadence inside the budget.

Use `Schedule.exponential("50 millis").pipe(Schedule.both(Schedule.during("2 seconds")))`
for interactive paths that should retry only briefly.

Add a count guard with `Schedule.recurs` only when the retry count is itself an
operational requirement. The number of retries inside a time budget depends on
both the delay policy and the time spent in failed attempts.

#### 6.5 Prefer time-budget limits over attempt counts

Use a time budget when the requirement is about latency, not about the number
of times an operation may run.

##### What this section is about

An attempt count answers "how many retries may be scheduled after the original
attempt?" A time budget answers "how long may this retry window stay open?"
Those are related, but not interchangeable.

In Effect, the usual shape is a delay schedule combined with
`Schedule.during`. The delay schedule controls cadence. `Schedule.during`
controls the elapsed retry window.

##### Why it matters

Fixed retry counts are easy to read but weak as latency limits. Three retries
can finish almost immediately when failures are fast, or take much longer when
each failed attempt waits on a network boundary before returning a typed
failure.

Time budgets express the boundary most callers care about: how long they are
willing to keep retrying. A startup check may get two minutes. A background job
may get 30 seconds. A user-facing request may get only a brief recovery window.

##### Core idea

Start with the delay shape, then add the budget with `Schedule.both`. Because
`both` requires both schedules to continue, the policy stops when the elapsed
window closes. Because `both` uses the maximum delay, the retry cadence still
comes from `Schedule.spaced`, `Schedule.fixed`, or `Schedule.exponential`.

Use `Schedule.recurs` as a secondary guard only when the count itself is a real
requirement.

##### Example

```ts
import { Console, Data, Effect, Schedule } from "effect"

class RemoteBusy extends Data.TaggedError("RemoteBusy")<{
  readonly attempt: number
}> {}

let attempts = 0

const callRemote: Effect.Effect<string, RemoteBusy> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`remote attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(new RemoteBusy({ attempt: attempts }))
  }

  return "remote value"
})

const retryWithinLatencyBudget = Schedule.exponential("50 millis").pipe(
  Schedule.both(Schedule.during("1 second"))
)

const program = Effect.gen(function*() {
  const value = yield* callRemote.pipe(
    Effect.retry(retryWithinLatencyBudget)
  )

  yield* Console.log(`completed with: ${value}`)
})

Effect.runPromise(program)
```

This policy does not promise exactly three retries. It retries according to the
backoff schedule while the one-second retry window is open.

##### Common mistakes

Do not treat `Schedule.recurs(3)` as a latency budget. It limits retry count,
not elapsed time.

Do not use `Schedule.during` by itself for production retry policies. It has no
useful spacing on its own, so a fast-failing effect can retry aggressively
until the window closes.

Do not choose a time budget to hide the wrong retry predicate. Permanent
failures such as bad input, invalid credentials, forbidden access, and
misconfiguration should usually stop immediately.

##### Practical guidance

Use `Schedule.exponential` when repeated failures should slow down over time.
Use `Schedule.spaced` when the cadence should be steady. Use `Schedule.fixed`
when retries should align to a fixed-rate interval instead of waiting a fixed
duration after each failed attempt completes.

Add `Schedule.recurs` only as a secondary cap when the number of retries is
operationally meaningful. For most service-boundary code, the time budget is
the clearer primary limit because it matches the caller's waiting tolerance.

### 7. Error-Aware Retries

#### 7.1 Retry only transient failures

Use a retry predicate when only some typed failures should spend retry budget.
The schedule controls timing and limits; the predicate controls eligibility.

##### Problem

An operation can fail for temporary reasons and permanent reasons. Retry the
temporary cases, such as timeouts, rate limits, and service unavailability.
Return invalid input, authorization failures, and unsupported operations
immediately.

##### When to use it

Use this when the effect has a meaningful typed error channel and only part of
that channel is retryable. It fits HTTP clients, database calls, cache fills,
message publishing, and dependency probes.

The operation must still be safe to run again for the selected failures. Reads
are usually safe. Writes need an idempotency key, transaction boundary, or
another duplicate-safety guarantee.

##### When not to use it

Do not classify every operational failure as transient. Authentication,
authorization, validation, decoding, and unsupported-operation errors usually
need a different handler, not another attempt.

Do not retry a large workflow when only one boundary call is transient. Put
`Effect.retry` around the smallest effect that can safely run more than once.

##### Schedule shape

With `Effect.retry`, the schedule input is the typed failure from the effect.
The options form accepts `while` and `until` predicates over that same error
type.

`while` means "continue while this predicate is true." `until` means "continue
until this predicate becomes true." If a predicate and a finite schedule are
both present, both must allow another attempt.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class Timeout extends Data.TaggedError("Timeout")<{
  readonly operation: string
}> {}

class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly retryAfterMillis: number
}> {}

class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly status: 503 | 504
}> {}

class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly message: string
}> {}

class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly reason: "MissingToken" | "ExpiredToken"
}> {}

type ApiError =
  | Timeout
  | RateLimited
  | ServiceUnavailable
  | InvalidRequest
  | Unauthorized

interface ApiResponse {
  readonly id: string
  readonly status: "accepted"
}

const isTransientApiError = (error: ApiError): boolean =>
  error._tag === "Timeout" ||
  error._tag === "RateLimited" ||
  error._tag === "ServiceUnavailable"

const retryTransientFailures = Schedule.spaced("50 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const makeRequest = (
  label: string,
  failures: ReadonlyArray<ApiError>
): Effect.Effect<ApiResponse, ApiError> => {
  let attempt = 0

  return Effect.gen(function*() {
    attempt += 1
    yield* Console.log(`${label}: attempt ${attempt}`)

    const failure = failures[attempt - 1]
    if (failure !== undefined) {
      return yield* Effect.fail(failure)
    }

    return { id: label, status: "accepted" }
  })
}

const runRequest = (
  label: string,
  request: Effect.Effect<ApiResponse, ApiError>
) =>
  request.pipe(
    Effect.retry({
      schedule: retryTransientFailures,
      while: isTransientApiError
    }),
    Effect.matchEffect({
      onFailure: (error) => Console.log(`${label}: failed with ${error._tag}`),
      onSuccess: (response) => Console.log(`${label}: ${response.status}`)
    })
  )

const program = Effect.gen(function*() {
  yield* runRequest(
    "transient",
    makeRequest("transient", [
      new Timeout({ operation: "create-job" }),
      new ServiceUnavailable({ status: 503 })
    ])
  )

  yield* runRequest(
    "permanent",
    makeRequest("permanent", [
      new InvalidRequest({ message: "missing id" })
    ])
  )
})

Effect.runPromise(program)
// Output:
// transient: attempt 1
// transient: attempt 2
// transient: attempt 3
// transient: accepted
// permanent: attempt 1
// permanent: failed with InvalidRequest
```

The transient request retries and then succeeds. The permanent request stops
after the first `InvalidRequest`.

##### Variants and caveats

Use `until` when the stopping condition is clearer, for example "retry until a
permanent error is observed."

Without `schedule` or `times`, retry options built only from `while` or
`until` can retry indefinitely while the predicate allows it.

The predicate sees typed failures from the error channel. Defects and fiber
interruptions are not retried as typed failures.

#### 7.2 Do not retry validation errors

Retry can handle temporary failures, but it should not hide bad input. Keep
validation failures explicit in the typed error channel and exclude them from
the retry predicate.

##### Problem

One operation may fail with transient service errors or permanent request
errors. Retry the transient cases. Return validation and conflict errors
immediately.

##### When to use it

Use this for form submission, API clients, command handlers, queue consumers,
and service calls that validate payloads before or during a boundary request.

Use structured typed errors so the retry decision comes from tags and fields,
not from parsing error messages.

##### When not to use it

Do not retry invalid input in the hope that it becomes valid. Missing fields,
unsupported enum values, malformed payloads, and domain-rule failures require a
different request.

Do not wrap a large workflow in retry just to handle one transient call. Retry
the smallest idempotent operation that may safely run again.

##### Schedule shape

The schedule should still be finite. A common shape is exponential backoff plus
`Schedule.recurs`.

After each typed failure, `while` is checked first. If it returns `false`,
retrying stops with that failure. If it returns `true`, the schedule decides
whether another retry is available and how long to wait.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

interface RegistrationInput {
  readonly email: string
  readonly plan: "Free" | "Pro"
}

interface Registration {
  readonly id: string
  readonly email: string
}

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string
  readonly message: string
}> {}

class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly service: "Accounts" | "Billing"
}> {}

class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly retryAfterMillis: number
}> {}

class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly resource: "Email"
}> {}

type RegistrationError =
  | ValidationError
  | ServiceUnavailable
  | RateLimited
  | ConflictError

const isRetryableRegistrationError = (error: RegistrationError): boolean =>
  error._tag === "ServiceUnavailable" || error._tag === "RateLimited"

const retryTransientFailures = Schedule.exponential("50 millis").pipe(
  Schedule.both(Schedule.recurs(4))
)

const submitRegistration = (
  input: RegistrationInput
): Effect.Effect<Registration, RegistrationError> => {
  let attempt = 0

  return Effect.gen(function*() {
    attempt += 1
    yield* Console.log(`${input.email}: submit attempt ${attempt}`)

    if (!input.email.includes("@")) {
      return yield* Effect.fail(
        new ValidationError({
          field: "email",
          message: "must contain @"
        })
      )
    }

    if (attempt === 1) {
      return yield* Effect.fail(new ServiceUnavailable({ service: "Accounts" }))
    }

    return { id: `registration-${attempt}`, email: input.email }
  })
}

const runRegistration = (input: RegistrationInput) =>
  submitRegistration(input).pipe(
    Effect.retry({
      schedule: retryTransientFailures,
      while: isRetryableRegistrationError
    }),
    Effect.matchEffect({
      onFailure: (error) => Console.log(`${input.email}: failed with ${error._tag}`),
      onSuccess: (registration) => Console.log(`${input.email}: ${registration.id}`)
    })
  )

const program = Effect.gen(function*() {
  yield* runRegistration({ email: "ada@example.com", plan: "Pro" })
  yield* runRegistration({ email: "not-an-email", plan: "Free" })
})

Effect.runPromise(program)
// Output:
// ada@example.com: submit attempt 1
// ada@example.com: submit attempt 2
// ada@example.com: registration-2
// not-an-email: submit attempt 1
// not-an-email: failed with ValidationError
```

The valid registration retries a temporary account-service failure. The invalid
email fails once with `ValidationError` and does not spend retry budget.

##### Variants and caveats

Use `until` when the non-retryable cases are the smaller or clearer set.

Use an effectful predicate only when retryability genuinely depends on an
external policy, such as a feature flag or runtime service. If that predicate
fails, its failure is propagated instead of retrying.

`while` and `until` inspect typed failures after an attempt fails. They do not
inspect successful values, and they do not prevent the original attempt from
running.

#### 7.3 Retry only on timeouts

Use this when timeout is the only retryable typed failure for an operation.

##### Problem

Build a finite retry policy that accepts only the typed timeout failure. Other
failures, such as HTTP status errors or decode errors, should fail fast.

##### When to use it

Use this when the error channel distinguishes timeouts from other failures. The
timeout must be part of the typed error model, not a string embedded in a
generic exception.

This fits HTTP clients, database calls, RPC clients, queues, reconnect probes,
and idempotent writes protected by duplicate-safety guarantees.

##### When not to use it

Do not retry every typed error just because timeout is one possible case.
Passing only `Schedule.recurs(3)` or `Schedule.exponential("100 millis")` to
`Effect.retry` retries every typed failure from the effect.

Do not assume timeout means the remote side did nothing. A write timeout can
mean the response was lost after the remote side completed the operation.

##### Schedule shape

The schedule supplies the finite retry policy. The `while` predicate prevents
non-timeout failures from consuming that policy.

Read the policy as: run once immediately; after a typed timeout, back off and
retry while attempts remain; after any non-timeout typed failure, stop
immediately.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

interface Invoice {
  readonly id: string
  readonly total: number
}

class RequestTimeout extends Data.TaggedError("RequestTimeout")<{
  readonly operation: "lookup-invoice"
}> {}

class HttpFailure extends Data.TaggedError("HttpFailure")<{
  readonly status: number
}> {}

class DecodeFailure extends Data.TaggedError("DecodeFailure")<{
  readonly message: string
}> {}

type LookupInvoiceError = RequestTimeout | HttpFailure | DecodeFailure

const isRequestTimeout = (
  error: LookupInvoiceError
): error is RequestTimeout => error._tag === "RequestTimeout"

const timeoutRetryPolicy = Schedule.exponential("50 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const makeLookupInvoice = (
  label: string,
  failures: ReadonlyArray<LookupInvoiceError>
): Effect.Effect<Invoice, LookupInvoiceError> => {
  let attempt = 0

  return Effect.gen(function*() {
    attempt += 1
    yield* Console.log(`${label}: lookup attempt ${attempt}`)

    const failure = failures[attempt - 1]
    if (failure !== undefined) {
      return yield* Effect.fail(failure)
    }

    return { id: "inv-123", total: 42 }
  })
}

const runLookup = (
  label: string,
  lookup: Effect.Effect<Invoice, LookupInvoiceError>
) =>
  lookup.pipe(
    Effect.retry({
      schedule: timeoutRetryPolicy,
      while: isRequestTimeout
    }),
    Effect.matchEffect({
      onFailure: (error) => Console.log(`${label}: failed with ${error._tag}`),
      onSuccess: (invoice) => Console.log(`${label}: invoice ${invoice.id}`)
    })
  )

const program = Effect.gen(function*() {
  yield* runLookup(
    "timeout-recovers",
    makeLookupInvoice("timeout-recovers", [
      new RequestTimeout({ operation: "lookup-invoice" }),
      new RequestTimeout({ operation: "lookup-invoice" })
    ])
  )

  yield* runLookup(
    "http-failure",
    makeLookupInvoice("http-failure", [
      new HttpFailure({ status: 403 })
    ])
  )
})

Effect.runPromise(program)
// Output:
// timeout-recovers: lookup attempt 1
// timeout-recovers: lookup attempt 2
// timeout-recovers: lookup attempt 3
// timeout-recovers: invoice inv-123
// http-failure: lookup attempt 1
// http-failure: failed with HttpFailure
```

The timeout case retries and succeeds. The HTTP failure stops after the first
attempt because the predicate returns `false`.

##### Variants and caveats

If the timeout comes from `Effect.timeout`, the typed timeout failure is
`Cause.TimeoutError`; use `Cause.isTimeoutError` as the predicate when the
effect can also fail with domain errors.

Keep timeout retry bounded with `Schedule.recurs`, `times`,
`Schedule.during`, or another stopping condition unless retrying forever is
intentional.

The first attempt is not delayed. Schedule delays apply only after a typed
failure has been accepted by the retry policy.

#### 7.4 Retry only on 5xx responses

Use this when an HTTP adapter should retry temporary server responses but
return client-side failures immediately.

##### Problem

Keep the HTTP status in the typed error and retry only responses from 500
through 599. Server failures such as 500, 502, 503, and 504 may be temporary.
Most 4xx statuses need a different request, resource, or credential.

##### When to use it

Use this when the effect's error channel contains a structured HTTP response
error. It fits service clients, API adapters, webhooks, and gateway calls where
retryability follows the response class.

It is safest for idempotent reads and duplicate-safe writes. A 5xx response
does not prove the server skipped the side effect.

##### When not to use it

Do not retry all HTTP failures. Most 4xx statuses represent request,
authorization, missing-resource, or conflict failures.

Do not treat this as a rate-limit policy. `429 Too Many Requests` is not a 5xx
response and usually needs timing from `Retry-After`, caller budgets, or
admission control.

##### Schedule shape

`Effect.retry` feeds each typed HTTP failure to the `while` predicate. If the
predicate returns `false`, retrying stops with that failure. If it returns
`true`, the finite schedule decides whether another retry is available and how
long to wait.

For most clients, combine the predicate with a finite backoff schedule.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

type HttpStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 422
  | 500
  | 501
  | 502
  | 503
  | 504

class HttpResponseError extends Data.TaggedError("HttpResponseError")<{
  readonly method: "GET" | "POST"
  readonly url: string
  readonly status: HttpStatus
}> {}

interface User {
  readonly id: string
  readonly name: string
}

const is5xxResponse = (error: HttpResponseError): boolean => error.status >= 500 && error.status < 600

const retryWithBackoff = Schedule.exponential("50 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const makeRequestUser = (
  label: string,
  failures: ReadonlyArray<HttpResponseError>
): Effect.Effect<User, HttpResponseError> => {
  let attempt = 0

  return Effect.gen(function*() {
    attempt += 1
    yield* Console.log(`${label}: HTTP attempt ${attempt}`)

    const failure = failures[attempt - 1]
    if (failure !== undefined) {
      return yield* Effect.fail(failure)
    }

    return { id: "user-123", name: "Ada" }
  })
}

const runRequest = (
  label: string,
  request: Effect.Effect<User, HttpResponseError>
) =>
  request.pipe(
    Effect.retry({
      schedule: retryWithBackoff,
      while: is5xxResponse
    }),
    Effect.matchEffect({
      onFailure: (error) => Console.log(`${label}: failed with HTTP ${error.status}`),
      onSuccess: (user) => Console.log(`${label}: user ${user.name}`)
    })
  )

const program = Effect.gen(function*() {
  yield* runRequest(
    "server-recovers",
    makeRequestUser("server-recovers", [
      new HttpResponseError({ method: "GET", url: "/users/123", status: 503 }),
      new HttpResponseError({ method: "GET", url: "/users/123", status: 502 })
    ])
  )

  yield* runRequest(
    "client-error",
    makeRequestUser("client-error", [
      new HttpResponseError({ method: "GET", url: "/users/missing", status: 404 })
    ])
  )
})

Effect.runPromise(program)
// Output:
// server-recovers: HTTP attempt 1
// server-recovers: HTTP attempt 2
// server-recovers: HTTP attempt 3
// server-recovers: user Ada
// client-error: HTTP attempt 1
// client-error: failed with HTTP 404
```

The server-error case retries and succeeds. The 404 case stops immediately.

##### Variants and caveats

Use an allow-list when some 5xx responses are permanent for your API, for
example retrying 500, 502, 503, and 504 but not 501.

Use `status >= 500 && status < 600` unless your adapter intentionally treats
nonstandard status codes as server failures.

Keep rate limiting as a sibling policy. A `429` may be retryable, but it
usually needs different timing and admission-control behavior from generic 5xx
responses.

#### 7.5 Treat rate limits differently from server errors

Rate limits and server failures can both be transient, but they communicate
different operational signals. Preserve that difference in the typed error
model and choose a schedule for each case.

##### Problem

`503 Service Unavailable` usually means the server failed to handle the
request. `429 Too Many Requests` means the caller is applying too much
pressure. A single generic retry policy hides that distinction.

##### Why this comparison matters

For retryable 5xx responses, a short jittered backoff is often enough: probe
again, spread callers around each delay, and stop after a small budget.

For rate limits, prefer provider guidance. If the response carries a
`Retry-After` value or equivalent metadata, use that value instead of guessing
from a generic exponential sequence.

##### Schedule shape

Use a finite jittered backoff for server errors. Use a rate-limit-specific
schedule that can read the typed retry input when the error carries the wait
duration.

`Schedule.identity<A>()` outputs the retry input as the schedule output.
`Schedule.addDelay` can then derive the wait from that output.

##### Example

```ts runnable deterministic
import { Console, Data, Duration, Effect, Schedule } from "effect"

class ServerError extends Data.TaggedError("ServerError")<{
  readonly status: 500 | 502 | 503 | 504
}> {}

class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly retryAfterMillis: number
}> {}

let serverAttempts = 0

const callServer: Effect.Effect<string, ServerError> = Effect.gen(function*() {
  serverAttempts += 1
  yield* Console.log(`server attempt ${serverAttempts}`)

  if (serverAttempts < 3) {
    return yield* Effect.fail(new ServerError({ status: 503 }))
  }

  return "server value"
})

let rateLimitAttempts = 0

const callRateLimitedApi: Effect.Effect<string, RateLimited> = Effect.gen(function*() {
  rateLimitAttempts += 1
  yield* Console.log(`rate-limit attempt ${rateLimitAttempts}`)

  if (rateLimitAttempts === 1) {
    return yield* Effect.fail(new RateLimited({ retryAfterMillis: 100 }))
  }

  return "rate-limited value"
})

const retryServerErrors = Schedule.exponential("50 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3))
)

const retryRateLimits = Schedule.identity<RateLimited>().pipe(
  Schedule.both(Schedule.recurs(2)),
  Schedule.addDelay(([error]) => Effect.succeed(Duration.millis(error.retryAfterMillis)))
)

const program = Effect.gen(function*() {
  const serverValue = yield* callServer.pipe(
    Effect.retry({
      schedule: retryServerErrors,
      while: (error) => error.status >= 500 && error.status < 600
    })
  )
  yield* Console.log(`server result: ${serverValue}`)

  const rateLimitedValue = yield* callRateLimitedApi.pipe(
    Effect.retry({
      schedule: retryRateLimits,
      while: (error) => error._tag === "RateLimited"
    })
  )
  yield* Console.log(`rate-limit result: ${rateLimitedValue}`)
})

Effect.runPromise(program)
// Output:
// server attempt 1
// server attempt 2
// server attempt 3
// server result: server value
// rate-limit attempt 1
// rate-limit attempt 2
// rate-limit result: rate-limited value
```

The server policy retries quickly with jitter. The rate-limit policy waits from
the typed retry hint.

##### Tradeoffs

The 5xx policy works even when the server gives no retry hint, but it is only a
guess. Keep its retry budget small.

The rate-limit policy is more protocol-aware. It works best when the adapter
preserves `Retry-After` or equivalent quota metadata in the typed error.

##### Recommended default

Do not put `429` into the same predicate as generic 5xx failures. Use a
dedicated `RateLimited` error, preserve the retry delay when available, and use
a small retry count.

For retryable 5xx responses, use finite jittered exponential backoff. For rate
limits, prefer provider guidance first and fall back to a fixed or capped delay
only when no retry hint exists.

Retried writes still need idempotency, de-duplication, or a transaction
boundary. A better retry policy does not make duplicate side effects safe.

### 8. Idempotency and Retry Safety

#### 8.1 Safe retries for GET requests

GET requests are usually safe to retry because they are meant to read state, not
change it. This recipe keeps read retries bounded, typed, and explicit.

##### Problem

Retrying a GET rarely risks duplicate mutation. The real risks are unbounded
traffic, hidden persistent failures, and caller latency that grows past its
budget.

Keep the retry boundary around the single read. Use a finite `Schedule` for
delay and attempt budget, and use a predicate on the typed failure to retry only
transient errors.

##### When to use it

Use this recipe for read-only HTTP calls: fetching a resource, checking status,
looking up metadata, refreshing a view model, or filling a cache from a remote
source.

It also fits replaceable values. If the first attempt fails and a later attempt
succeeds, the caller observes only the final read result.

Keep the policy bounded even for safe reads. A GET can still consume connection
slots, server CPU, database capacity, and caller latency budget.

##### When not to use it

Do not use this section as a complete policy for writes, even if the endpoint is
named like a read. Duplicate-safe writes, idempotency keys, and mutation retry
safety belong in sibling sections.

Do not retry every GET failure. A malformed URL, authorization failure, missing
resource, or response decode error is unlikely to improve by waiting.

Do not wrap a large workflow in a retry only because one step is a GET. Retry
the read itself, before local state changes, notifications, or other effects are
performed.

##### Schedule shape

For GET requests, the usual shape is:

- a small initial delay, often with exponential backoff
- jitter, so many callers do not retry at the same instant
- a finite retry count, time budget, or both
- an error predicate that allows only transient failures

`Schedule.exponential("10 millis")` provides the backoff delays in the example
below; production values are usually larger.
`Schedule.jittered` randomly adjusts each delay between 80% and 120% of the
original delay. `Schedule.both(Schedule.recurs(3))` keeps the policy finite:
both schedules must continue, so the read gets at most three retries after the
original attempt.

With `Effect.retry`, the GET runs once immediately. Only failures from the typed
error channel are retried, and only while the predicate returns `true`.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class GetUserError extends Data.TaggedError("GetUserError")<{
  readonly reason: "Timeout" | "ConnectionReset" | "BadGateway" | "NotFound" | "Unauthorized" | "DecodeError"
}> {}

interface User {
  readonly id: string
  readonly name: string
}

let attempts = 0

const getUser = (id: string): Effect.Effect<User, GetUserError> =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`GET /users/${id} attempt ${attempts}`)

    if (attempts < 3) {
      return yield* Effect.fail(new GetUserError({ reason: "Timeout" }))
    }

    return { id, name: "Ada" }
  })

const isRetryableGetFailure = (error: GetUserError): boolean => {
  switch (error.reason) {
    case "Timeout":
    case "ConnectionReset":
    case "BadGateway":
      return true
    case "NotFound":
    case "Unauthorized":
    case "DecodeError":
      return false
  }
}

const safeGetRetryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3))
)

const program = getUser("user-123").pipe(
  Effect.retry({
    schedule: safeGetRetryPolicy,
    while: isRetryableGetFailure
  })
).pipe(
  Effect.tap((user) => Console.log(`loaded ${user.name}`))
)

Effect.runPromise(program)
// Output:
// GET /users/user-123 attempt 1
// GET /users/user-123 attempt 2
// GET /users/user-123 attempt 3
// loaded Ada
```

`program` performs the GET once, then retries only timeout, connection reset, or
bad gateway failures. A `NotFound`, `Unauthorized`, or `DecodeError` failure
stops immediately and is returned.

The same shape works for cache fills. Keep the cache write outside the retried
GET if the cache layer writes only after a successful read. That way each retry
is still just another attempt to obtain the same value.

##### Variants

For status lookups that are cheap and user-facing, use fewer retries and a
smaller delay. For background cache refreshes, use a slower base delay and a
slightly larger budget. The reads are still safe, but the downstream service may
already be under pressure.

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

const statusLookupRetryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(2))
)

const cacheRefreshRetryPolicy = Schedule.exponential("20 millis", 1.5).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

let statusAttempts = 0

const readStatus = Effect.gen(function*() {
  statusAttempts += 1
  yield* Console.log(`status attempt ${statusAttempts}`)
  if (statusAttempts < 2) return yield* Effect.fail("transient")
  return "ok"
})

const program = Effect.gen(function*() {
  const status = yield* readStatus.pipe(Effect.retry(statusLookupRetryPolicy))
  yield* Console.log(`status: ${status}`)
  yield* Console.log(`cache refresh policy ready: ${Schedule.isSchedule(cacheRefreshRetryPolicy)}`)
})

Effect.runPromise(program)
// Output:
// status attempt 1
// status attempt 2
// status: ok
// cache refresh policy ready: true
```

The status policy gives the caller a quick second and third chance. The cache
policy is slower and broader, which is appropriate only when the caller can
tolerate more latency.

For observability, attach logging or metrics around the retried GET rather than
changing the schedule into an unbounded one. Count attempts, final failures, and
latency separately so a safe retry policy remains visible in production.

##### Notes and caveats

Safe does not mean free. Retried GET requests can amplify traffic during an
incident, especially when many callers share the same policy.

The first GET is not delayed. The schedule is consulted only after the effect
fails with a typed error.

`Schedule.exponential` does not stop by itself. Pair it with `Schedule.recurs`, a
time budget, or another stopping condition.

`Schedule.recurs(3)` means three retries after the original attempt, not three
total attempts.

Jitter is usually appropriate for service calls and cache fills. It is less
important for a single local caller, but it becomes valuable as soon as many
fibers, processes, or hosts can fail at the same time.

Keep retry predicates explicit. A GET that returns `404 Not Found` for a real
missing resource should normally fail fast, while a timeout or gateway failure
may be worth another attempt.

#### 8.2 Retrying idempotent writes

An idempotent write is a write where repeating the same request has the same
effect as running it once. This recipe places `Schedule` around that
duplicate-safe boundary.

##### Problem

Ambiguous write failures are dangerous because the caller may see a timeout,
dropped connection, or temporary service error after the remote system has
already applied the change. Retrying an ordinary write can create a duplicate
charge, send a second notification, insert a second row, or publish the same
command twice.

Retry the write only when the operation is designed to be duplicate-safe. Then
use `Schedule` to make the retry policy finite, delayed, and visible.

The schedule is not the safety mechanism. It only says when to try again. The
write contract must make repeated attempts equivalent to one logical write.

##### When to use it

Use this recipe when the write is explicitly idempotent or duplicate-safe. Good
examples include setting a resource to a known value, upserting by a stable
identifier, acknowledging a message with broker-level deduplication, or writing
to an endpoint that treats repeated equivalent requests as the same logical
operation.

It also fits writes where the downstream system documents that a retry after a
transport failure is safe. In those cases, the schedule handles transient timing
problems while the protocol handles duplicate attempts.

Keep the retry around the smallest duplicate-safe write. If a workflow contains
reads, validation, and one idempotent write, retry the write effect itself.

##### When not to use it

Do not use retries to make non-idempotent writes safe. If repeating the operation
can create additional business effects, add a domain-level safety mechanism
before adding a schedule.

Do not retry ambiguous writes that depend on hidden server state unless the
server gives a documented duplicate-safe contract. A finite retry limit reduces
damage, but it does not change the semantics of the write.

Do not retry validation failures, authorization failures, malformed payloads, or
business-rule rejections. Those errors are usually permanent and should be
returned immediately.

##### Schedule shape

For duplicate-safe writes, prefer a bounded policy with backoff and jitter. The
example uses short demo delays; production values are usually larger.
`Schedule.exponential` spaces retries farther apart after repeated failures.
`Schedule.jittered` spreads concurrent callers around each computed delay.
`Schedule.recurs(4)` limits the policy to at most four retries after the original
attempt.

With `Effect.retry`, the write runs once immediately. If it fails with a typed
error, that error is fed to the schedule. The schedule decides whether another
attempt is allowed and how long to wait before that attempt. If all retries are
exhausted, `Effect.retry` returns the last typed failure.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class WriteTimeout extends Data.TaggedError("WriteTimeout")<{
  readonly operation: "SetAccountEmail"
}> {}

class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly status: 503 | 504
}> {}

class InvalidEmail extends Data.TaggedError("InvalidEmail")<{
  readonly email: string
}> {}

type WriteError = WriteTimeout | ServiceUnavailable | InvalidEmail

let attempts = 0

const setAccountEmail = (
  accountId: string,
  email: string
): Effect.Effect<void, WriteError> =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`set email attempt ${attempts} for ${accountId}`)

    if (!email.includes("@")) {
      return yield* Effect.fail(new InvalidEmail({ email }))
    }

    if (attempts < 3) {
      return yield* Effect.fail(new WriteTimeout({ operation: "SetAccountEmail" }))
    }

    yield* Console.log(`stored ${email}`)
  })

const retryDuplicateSafeWrite = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const updateEmail = (accountId: string, email: string) =>
  setAccountEmail(accountId, email).pipe(
    Effect.retry({
      schedule: retryDuplicateSafeWrite,
      while: (error) => error._tag === "WriteTimeout" || error._tag === "ServiceUnavailable"
    })
  )

const program = updateEmail("account-1", "ada@example.com")

Effect.runPromise(program)
// Output:
// set email attempt 1 for account-1
// set email attempt 2 for account-1
// set email attempt 3 for account-1
// stored ada@example.com
```

This example assumes `setAccountEmail(accountId, email)` is duplicate-safe:
running it more than once sets the same account to the same email address. A
timeout or temporary service failure can be retried. An `InvalidEmail` failure is
not retried because repeating the same invalid write will not make it valid.

##### Variants

Use a fixed delay when the downstream system prefers steady retry traffic, or a
larger background policy when the caller can tolerate more latency:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

const steadyWriteRetry = Schedule.spaced("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3))
)

const backgroundWriteRetry = Schedule.exponential("20 millis", 2).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

let attempts = 0

const writeAuditMarker = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`audit marker attempt ${attempts}`)
  if (attempts < 2) return yield* Effect.fail("service-unavailable")
  return "stored"
})

const program = Effect.gen(function*() {
  const result = yield* writeAuditMarker.pipe(Effect.retry(steadyWriteRetry))
  yield* Console.log(`steady policy result: ${result}`)
  yield* Console.log(`background policy ready: ${Schedule.isSchedule(backgroundWriteRetry)}`)
})

Effect.runPromise(program)
// Output:
// audit marker attempt 1
// audit marker attempt 2
// steady policy result: stored
// background policy ready: true
```

The fixed schedule still limits retries and adds jitter, but avoids exponential
growth. The longer background schedule is a throughput and latency choice, not
an idempotency guarantee.

##### Notes and caveats

Idempotency keys are one common way to make a write duplicate-safe, but they are
not the focus of this recipe. The important point here is the contract: repeated
attempts of the same logical write must not create additional business effects.

Retry only typed failures that plausibly mean the write outcome is unknown or
temporarily unavailable, such as timeouts, connection loss, rate limits, or 5xx
responses. Keep permanent failures out of the retry path with `while` or
`until`.

The first attempt is not delayed. The schedule controls only the waits between
failed attempts.

For user-facing writes, keep retry budgets small. If the operation may still be
running remotely after the caller gives up, expose a way to observe the final
state rather than asking the user to submit a second independent write.

#### 8.3 Why non-idempotent retries are dangerous

Non-idempotent work changes external state each time it runs. A retry schedule
can limit attempts, but it cannot make repeated charges, emails, shipments, or
webhooks semantically safe.

##### The anti-pattern

A retry policy is easy to attach to any failing effect:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let attempts = 0
let chargesAccepted = 0

const chargeCustomer = Effect.gen(function*() {
  attempts += 1
  chargesAccepted += 1
  yield* Console.log(`attempt ${attempts}: provider accepted charge #${chargesAccepted}`)

  if (attempts === 1) {
    return yield* Effect.fail("response-lost")
  }

  return "charged"
})

const retryWrites = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const program = chargeCustomer.pipe(
  Effect.retry(retryWrites),
  Effect.tap((result) => Console.log(`${result}; accepted charges: ${chargesAccepted}`))
)

Effect.runPromise(program)
// Output:
// attempt 1: provider accepted charge #1
// attempt 2: provider accepted charge #2
// charged; accepted charges: 2
```

This shape is technically valid, and the example terminates quickly, but it
models the danger: the first attempt can be accepted by the provider and still
fail from the caller's point of view. `Effect.retry` then runs the same
side-effecting operation again.

The same anti-pattern appears with email delivery, inventory updates, shipment
creation, ticket creation, one-way webhook calls, and external systems that do
not give the caller a reliable duplicate-suppression boundary.

##### Why it happens

Retries are driven by what the caller can observe. A timeout, dropped
connection, `503`, or connection reset tells the caller that it did not receive
a successful response. It does not prove that the downstream system did
nothing.

For a read, this uncertainty is usually acceptable. Running the same lookup
again normally produces another observation of the same resource. For a write,
the uncertainty crosses a boundary: the downstream service may have committed
the side effect and then failed before the response reached the caller.

`Schedule` controls when and how often the effect is attempted again. It does
not change the meaning of the side effect being retried. A careful schedule can
reduce load and limit attempts, but it cannot make a non-idempotent operation
safe by itself.

##### Why it is risky

Non-idempotent retries turn ambiguous failures into duplicate business actions.
A payment retry can double-charge a customer. An email retry can send the same
message multiple times. An inventory retry can decrement stock twice. A webhook
retry can trigger another system to create duplicate records.

The operational damage is often larger than the immediate failure. Duplicate
charges need refunds and support handling. Duplicate emails erode trust and may
trip abuse controls. Duplicate inventory updates can oversell products or block
valid orders. Duplicate one-way calls are hard to unwind because the caller may
not own the downstream state.

Attempt limits do not remove this risk:

```ts
import { Console, Effect, Schedule } from "effect"

const boundedButStillUnsafe = Schedule.spaced("1 second").pipe(
  Schedule.both(Schedule.recurs(2))
)

const program = Console.log(`bounded policy: ${Schedule.isSchedule(boundedButStillUnsafe)}`)

Effect.runPromise(program)
```

This policy limits the damage to two retries after the original attempt. It
does not answer the important question: is it safe for the external side effect
to happen three times?

##### A better approach

Place retries around effects that are safe to re-run, and keep unsafe writes
outside generic retry wrappers unless the external protocol provides a
duplicate-safe boundary.

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let reservationAttempts = 0

const reserveLocalOrderNumber = Effect.gen(function*() {
  reservationAttempts += 1
  yield* Console.log(`reserve order number attempt ${reservationAttempts}`)
  if (reservationAttempts < 2) return yield* Effect.fail("local-store-busy")
  return "order-1001"
})

const submitChargeOnce = (orderNumber: string) => Console.log(`submit one charge for ${orderNumber}`)

const retryTransientPreparation = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const program = Effect.gen(function*() {
  const orderNumber = yield* reserveLocalOrderNumber.pipe(
    Effect.retry(retryTransientPreparation)
  )

  yield* submitChargeOnce(orderNumber)
})

Effect.runPromise(program)
// Output:
// reserve order number attempt 1
// reserve order number attempt 2
// submit one charge for order-1001
```

Here the schedule is applied only to the preparation step that the application
has decided is safe to repeat. The external charge is a separate step. If that
charge returns an ambiguous failure, the program should surface the ambiguity,
record it, reconcile it, or hand it to a domain-specific safety mechanism
rather than blindly running the same one-way action again.

For non-idempotent work, first ask whether another attempt is semantically the
same operation or a new business action. If it is a new business action, a
retry schedule is the wrong boundary even when the failure looks transient.

##### Notes and caveats

`Effect.retry` retries typed failures from the error channel according to the
provided policy. It does not inspect the external system to determine whether a
side effect already happened.

`Schedule.recurs(n)` limits the number of retries after the original attempt.
It is useful for bounding operational cost, but it is not a duplicate-safety
mechanism.

Timeouts are especially ambiguous for writes. A timeout can mean "the service
did not receive the request," "the service committed the request but the
response was lost," or "the service is still processing the request."

Do not treat this as advice to never retry writes. Some writes are safe because
the operation is naturally idempotent, transactional, or protected by a
protocol-level duplicate check. The important point is that the safety comes
from the operation boundary, not from `Schedule` itself.

#### 8.4 Retrying with idempotency keys

An idempotency key is a stable token that tells a downstream service which
attempts belong to one logical command. This recipe shows where that key belongs
relative to `Effect.retry` and a bounded `Schedule`.

##### Problem

The failure mode is using a retry policy without preserving the same key across
attempts. If each attempt uses a different key, the downstream system may treat
them as independent writes.

The retry policy still matters. A key can prevent duplicate business effects,
but it does not make unbounded retry traffic harmless. Use `Schedule` to keep the
retry delayed, finite, and explicit.

The important boundary is: create or receive one idempotency key before the
retried write, then reuse that exact key for every attempt made by
`Effect.retry`.

##### When to use it

Use this recipe for external writes where the downstream API documents
idempotency-key behavior. Common examples include payment creation, order
submission, shipment creation, ticket creation, and API commands that accept a
header such as `Idempotency-Key`.

It is most useful for ambiguous failures: timeouts, dropped connections,
gateway errors, rate limits, or service unavailability. In those cases, the
caller may not know whether the first request was committed. Retrying with the
same key asks the server to return or complete the same logical result.

Keep the retry around the single keyed write. Generate the key outside that
retry boundary, store it with the local command or request record when needed,
and pass it into each attempt.

##### When not to use it

Do not generate a fresh idempotency key inside the retried effect. A new key per
attempt usually tells the downstream system that each retry is a new write.

Do not use this recipe for APIs that ignore idempotency keys or only deduplicate
for a shorter period than your operational workflow requires.

Do not retry permanent failures such as invalid payloads, authorization
failures, insufficient funds, or business-rule rejections. The key protects
against duplicate execution; it does not make an invalid command valid.

##### Schedule shape

For keyed external writes, start with a conservative bounded retry:

- exponential backoff, so repeated failures slow down
- jitter, so many callers do not retry together
- a finite recurrence limit, so the write cannot retry forever
- a predicate that retries only ambiguous or transient failures

The example uses `Schedule.exponential("10 millis")` so it terminates quickly.
Production values are usually larger. `Schedule.jittered` randomly adjusts each
delay between 80% and 120%. `Schedule.both(Schedule.recurs(4))` keeps the
schedule finite: both schedules must continue, so the write is retried at most
four times after the original attempt.

With `Effect.retry`, the write runs once immediately. The same effect is then
re-run only after a typed failure that the predicate allows and only while the
schedule continues.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class CreatePaymentError extends Data.TaggedError("CreatePaymentError")<{
  readonly reason: "Timeout" | "ConnectionReset" | "RateLimited" | "BadGateway" | "InvalidRequest" | "Declined"
}> {}

interface Payment {
  readonly id: string
  readonly status: "Created" | "AlreadyCreated"
}

interface PaymentInput {
  readonly customerId: string
  readonly amountCents: number
  readonly idempotencyKey: string
}

let attempts = 0

const createPayment = (input: PaymentInput): Effect.Effect<Payment, CreatePaymentError> =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`payment attempt ${attempts} with key ${input.idempotencyKey}`)

    if (attempts < 3) {
      return yield* Effect.fail(new CreatePaymentError({ reason: "Timeout" }))
    }

    return { id: "pay_123", status: "Created" }
  })

const retryKeyedWrite = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const isRetryablePaymentFailure = (error: CreatePaymentError): boolean => {
  switch (error.reason) {
    case "Timeout":
    case "ConnectionReset":
    case "RateLimited":
    case "BadGateway":
      return true
    case "InvalidRequest":
    case "Declined":
      return false
  }
}

const submitPayment = (
  customerId: string,
  amountCents: number,
  idempotencyKey: string
) =>
  createPayment({ customerId, amountCents, idempotencyKey }).pipe(
    Effect.retry({
      schedule: retryKeyedWrite,
      while: isRetryablePaymentFailure
    })
  ).pipe(
    Effect.tap((payment) => Console.log(`${payment.id} ${payment.status}`))
  )

const program = submitPayment("customer-1", 5000, "payment-command-42")

Effect.runPromise(program)
// Output:
// payment attempt 1 with key payment-command-42
// payment attempt 2 with key payment-command-42
// payment attempt 3 with key payment-command-42
// pay_123 Created
```

The `idempotencyKey` is an argument to `submitPayment`, not a value created
inside `createPayment` or inside the retry. Every retry attempt sends the same
`customerId`, `amountCents`, and `idempotencyKey`.

If the first request reaches the payment provider but the response is lost, a
later attempt with the same key should be treated by that provider as the same
logical payment. `Schedule` controls how many times the client asks again and
how long it waits between attempts.

##### Variants

For user-facing writes, keep the retry budget small. The idempotency key
reduces duplicate-write risk, but the user still waits for the retry sequence:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

const userFacingKeyedWrite = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(2))
)

const backgroundKeyedWrite = Schedule.exponential("20 millis", 1.5).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const program = Effect.gen(function*() {
  yield* Console.log(`user-facing policy: ${Schedule.isSchedule(userFacingKeyedWrite)}`)
  yield* Console.log(`background policy: ${Schedule.isSchedule(backgroundKeyedWrite)}`)
})

Effect.runPromise(program)
// Output:
// user-facing policy: true
// background policy: true
```

Use the smaller policy when the caller needs a prompt answer. Use the larger
policy for background workers that can tolerate more latency and where the key
is persisted with the job, command, or outbox record.

If the downstream service returns a "duplicate" or "already processed" response
for the same key, model that as a successful domain result when it represents
the same logical write. Do not turn it into a failure that triggers more
retries.

##### Notes and caveats

The idempotency key must identify one logical command. Reusing a key for a
different payload can be rejected by the downstream service or, worse, attach a
new local intent to an old remote result.

Persist the key before retrying when the operation may outlive the current
fiber, process, or HTTP request. A worker restart should resume the same
logical write with the same key, not invent a new one.

Check the downstream service's retention window. Some providers remember keys
for hours or days, not forever. Your retry and reconciliation workflow should
fit inside that documented window.

`Schedule.recurs(4)` means four retries after the original attempt. It does not
mean four total attempts.

The schedule is still a load-control tool, not the idempotency guarantee. The
duplicate-safety contract comes from the external API honoring the stable key.

#### 8.5 When not to retry at all

Sometimes the correct retry policy is no retry. Use that policy when another
attempt would be a new business action, when the failure is permanent, or when
the next step is reconciliation rather than repetition.

Beginner note: Bounds — a bounded retry policy can still be wrong. Timing and
limits do not make an unsafe operation safe to run again.

##### The anti-pattern

Some operations should not receive a retry policy at all. The anti-pattern is
to attach a reasonable-looking `Schedule` to an effect only because the failure
looks temporary:

<!-- no-check: intentionally unsafe anti-pattern; do not treat as a runnable cookbook example -->

```ts no-check
import { Console, Effect, Schedule } from "effect"

let attempts = 0
let providerCharges = 0

const chargeCardOnce = Effect.gen(function*() {
  attempts += 1
  providerCharges += 1
  yield* Console.log(`charge attempt ${attempts}; provider charge ${providerCharges}`)

  if (attempts === 1) {
    return yield* Effect.fail("response-lost")
  }
})

const retryTransientFailure = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

// Unsafe: do not attach a generic retry policy to a one-way charge.
const unsafeProgram = chargeCardOnce.pipe(
  Effect.retry(retryTransientFailure),
  Effect.tap(() => Console.log(`provider charges: ${providerCharges}`))
)

Effect.runPromise(unsafeProgram)
```

The schedule is finite and delayed, but that does not make the operation safe.
If the charge was accepted and the response was lost, retrying can create a new
business action.

##### Why it happens

Retries are often added near the transport boundary. A timeout, connection reset,
or `503` response feels like infrastructure noise, so it is tempting to reuse
the same schedule that works well for reads or duplicate-safe writes.

That reasoning skips the domain question: what happens if the operation already
partly or fully happened?

For unsafe writes, the caller may not know whether the remote system committed
the side effect. `Schedule` can decide when to try again, how long to wait, and
when to stop. It cannot decide whether another attempt is the same logical
operation or a second business event.

Permanent failures are another common source of accidental retries. Validation
errors, malformed requests, authorization failures, missing prerequisites, and
business-rule rejections usually require a different input, different caller
permissions, or an operator fix. Waiting does not change those facts.

##### Why it is risky

Retrying the wrong operation converts one failure into several possible
failures. A payment may be charged twice. A shipment may be created twice. An
email or webhook may be delivered multiple times. A state transition may advance
farther than the caller intended.

It also hides the information the caller needs. If a request is invalid, the
caller should correct it. If credentials are wrong, the caller should
reauthenticate or escalate. If a write has an unknown outcome, the system should
record that ambiguity and reconcile it instead of pretending another attempt is
automatically harmless.

A retry limit only bounds the number of additional attempts. It does not make an
unsafe operation safe:

```ts
import { Console, Effect, Schedule } from "effect"

const boundedButStillUnsafe = Schedule.spaced("1 second").pipe(
  Schedule.both(Schedule.recurs(1))
)

const program = Console.log(`bounded policy: ${Schedule.isSchedule(boundedButStillUnsafe)}`)

Effect.runPromise(program)
```

This policy allows only one retry after the original attempt, but that one retry
may still be one duplicate too many.

##### A better approach

Do not attach `Effect.retry` when the next correct action is correction,
escalation, or reconciliation.

```ts runnable deterministic
import { Console, Effect, Result } from "effect"

let providerCharges = 0

const submitPaymentOnce = Effect.gen(function*() {
  providerCharges += 1
  yield* Console.log(`submitted payment once; provider charge ${providerCharges}`)
  return yield* Effect.fail("unknown-payment-outcome")
})

const recordForReconciliation = (error: unknown) => Console.log(`recorded for reconciliation: ${String(error)}`)

const program = Effect.gen(function*() {
  const result = yield* Effect.result(submitPaymentOnce)

  if (Result.isFailure(result)) {
    return yield* recordForReconciliation(result.failure)
  }

  yield* Console.log("payment confirmed")
})

Effect.runPromise(program)
// Output:
// submitted payment once; provider charge 1
// recorded for reconciliation: unknown-payment-outcome
```

This program intentionally has no retry schedule around `submitPaymentOnce`. A
failure is treated as an outcome to record and resolve through a safer path.
That path might query the downstream system, notify an operator, expose an
"unknown" status to the caller, or hand the case to a reconciliation worker.

Use the same shape for permanent errors. Return validation failures to the
caller. Surface authorization failures to the authentication or permission
layer. Send malformed upstream responses to monitoring. Route irrecoverable
infrastructure failures to an operational fallback. In each case, the important
choice is to avoid spending retry attempts on work that cannot become correct by
waiting.

##### Notes and caveats

No retry policy is still a policy. It says the operation should be attempted
once and then handled by the domain-specific failure path.

Avoid retrying when the operation is a non-idempotent write, when the failure is
permanent, when success requires the caller to change the request, or when the
correct next step is human or automated reconciliation.

This does not mean every write must fail fast forever. Some writes are safe to
retry because they are explicitly duplicate-safe. That safety belongs to the
operation boundary, not to `Schedule`.

If only part of a workflow is retryable, put the schedule around that smallest
safe part. Do not wrap the whole workflow just because one internal call may
benefit from retry.

When in doubt, ask what a second attempt means in the business domain. If it
means "try the same logical operation again," a bounded schedule may be
appropriate. If it means "perform another business action," do not retry at that
boundary.

## Part III — Repeat Recipes

### 9. Repeat Successful Work

#### 9.1 Repeat 5 times

`Effect.repeat` repeats after success. This recipe covers count-bounded
repetition without adding timing or failure recovery.

##### Problem

The count is easy to misread. With `Effect.repeat`, the effect runs once before
the schedule is consulted. `Schedule.recurs(5)` therefore means five
recurrences after the original run, for six total executions if every run
succeeds.

##### When to use it

Use this when the original effect should execute immediately and a successful
result should be followed by at most five more executions.

This fits count-bounded sampling, repeating a successful maintenance action a
small number of times, or exercising a successful operation several more times
without adding timing.

##### When not to use it

Do not use this when "five times" means five total executions. For five total
executions, use four recurrences: `Schedule.recurs(4)` or
`Effect.repeat({ times: 4 })`.

Do not use `Effect.repeat` to recover from failures. If the effect fails,
repeating stops and the failure is returned. Use `Effect.retry` when failure
should trigger another attempt.

##### Schedule shape

`Schedule.recurs(5)` is the direct schedule shape. Read it as "after the
original successful run, allow five scheduled recurrences." The maximum execution
count is one original run plus five recurrences, for six total executions.

The schedule output is the recurrence count. When passed directly to
`Effect.repeat`, the repeated program returns the schedule's final output, not
the effect's final value.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let executions = 0

const writeMetric = Effect.gen(function*() {
  executions += 1
  yield* Console.log(`metric write ${executions}`)
  return executions
})

const program = writeMetric.pipe(
  Effect.repeat(Schedule.recurs(5)),
  Effect.tap((recurrenceCount) => Console.log(`schedule output: ${recurrenceCount}; total executions: ${executions}`))
)

Effect.runPromise(program)
// Output:
// metric write 1
// metric write 2
// metric write 3
// metric write 4
// metric write 5
// metric write 6
// schedule output: 5; total executions: 6
```

Here `writeMetric` runs once immediately. If it succeeds each time,
`Schedule.recurs(5)` allows five more runs, so the effect can execute six times
total.

If you want the repeated effect's final successful value instead of the schedule
output, use the options form:

```ts runnable deterministic
import { Console, Effect } from "effect"

let sampleNumber = 0

const readSample = Effect.gen(function*() {
  sampleNumber += 1
  yield* Console.log(`sample ${sampleNumber}`)
  return { sampleNumber }
})

const finalSample = readSample.pipe(
  Effect.repeat({ times: 4 }),
  Effect.tap((sample) => Console.log(`final sample: ${sample.sampleNumber}`))
)

Effect.runPromise(finalSample)
// Output:
// sample 1
// sample 2
// sample 3
// sample 4
// sample 5
// final sample: 5
```

This uses four recurrences for five total executions and returns the final
successful sample.

##### Variants

For five total executions, use four recurrences:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let executions = 0

const program = Effect.gen(function*() {
  executions += 1
  yield* Console.log(`execution ${executions}`)
}).pipe(
  Effect.repeat(Schedule.recurs(4)),
  Effect.tap(() => Console.log(`total executions: ${executions}`))
)

Effect.runPromise(program)
// Output:
// execution 1
// execution 2
// execution 3
// execution 4
// execution 5
// total executions: 5
```

Use `Schedule.recurs(5)` when you care about a composable schedule value. Use
`Effect.repeat({ times: 5 })` when you need five recurrences and want the final
successful value of the effect.

##### Notes and caveats

`Schedule.recurs(5)` means at most five recurrences. It reaches that count only
if the original run and all repeated runs succeed.

The original run is not delayed by the schedule. With `Schedule.recurs(5)` alone,
there is no added spacing between recurrences.

This recipe is only about a fixed recurrence count. Add timing, forever
repetition, or `while` / `until` predicates only when the repeat policy needs
those extra rules.

#### 9.2 Repeat forever with care

`Effect.repeat` can run successful work for the lifetime of a process, fiber, or
scope. This recipe focuses on using an explicit owner and spacing policy.

##### Problem

An unbounded repeat is easy to express, but it is also easy to make too
aggressive. `Schedule.forever` repeats with no delay. For most operational
loops, use an explicit spacing schedule so each successful run leaves room for
the rest of the system.

##### When to use it

Use this for long-lived background work where success means "do it again":
heartbeats, cache refreshes, lightweight health checks, and maintenance loops
owned by a supervised fiber or application scope.

Use a forever repeat only when the surrounding program has a clear lifetime. The
normal way to stop an unbounded repeat is interruption, cancellation of the
owning fiber, or shutdown of the scope that owns it.

Beginner note: Bounds — "forever" is acceptable only when ownership is explicit.
For request-response code, prefer a finite schedule or a timeout.

##### When not to use it

Do not use a forever repeat for a request-response path. If the effect keeps
succeeding and the schedule is unbounded, the repeated program does not complete
normally.

Do not use `Schedule.forever` for ordinary background polling unless a tight loop
is intentional. It has zero delay between successful executions and can consume
resources quickly.

Do not use `Effect.repeat` to recover from failures. A failure stops repetition.
Use `Effect.retry` when failures should trigger another attempt.

##### Schedule shape

The smallest forever schedule is `Schedule.forever`. It recurs forever and
outputs the current repetition count: `0`, `1`, `2`, and so on.

For operational code, prefer a spaced forever schedule:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

const repeatEveryTick = Schedule.spaced("10 millis").pipe(
  Schedule.take(2)
)

const program = Console.log(`spaced policy: ${Schedule.isSchedule(repeatEveryTick)}`)

Effect.runPromise(program)
// Output:
// spaced policy: true
```

`Schedule.spaced(duration)` is also unbounded by default, but it waits for the
duration after each successful run before starting the next recurrence. The first
run still happens immediately; the schedule controls only what happens after a
success. The `Schedule.take(2)` above is only there to keep the example finite.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let refreshes = 0

const refreshCache = Effect.gen(function*() {
  refreshes += 1
  yield* Console.log(`cache refresh ${refreshes}`)
})

const refreshPolicy = Schedule.spaced("10 millis").pipe(
  Schedule.tapOutput((repetition) => Console.log(`scheduled repetition ${repetition}`)),
  Schedule.take(3)
)

const program = refreshCache.pipe(
  Effect.repeat(refreshPolicy),
  Effect.tap((lastRepetition) => Console.log(`stopped demo after repetition ${lastRepetition}`))
)

Effect.runPromise(program)
// Output:
// cache refresh 1
// scheduled repetition 0
// cache refresh 2
// scheduled repetition 1
// cache refresh 3
// scheduled repetition 2
// cache refresh 4
// scheduled repetition 3
// stopped demo after repetition 3
```

This runs `refreshCache` once immediately. After each success, the schedule
records the repetition count, waits, and allows the next run. The `take` limit
keeps the snippet pasteable and quick to terminate; a real background worker
would normally rely on an owning fiber or scope to stop it.

Without the demo limit, this shape is intended for long-lived work. It completes
only if `refreshCache` fails, the schedule fails, or the fiber is interrupted.

##### Variants

Use `Schedule.forever` only when immediate repetition is deliberate:

```ts
import { Console, Effect, Schedule } from "effect"

let drains = 0

const drainLocalQueue = Effect.gen(function*() {
  drains += 1
  yield* Console.log(`drain pass ${drains}`)
})

const program = drainLocalQueue.pipe(
  Effect.repeat(Schedule.forever.pipe(Schedule.take(3))),
  Effect.tap((lastRepetition) => Console.log(`last repetition: ${lastRepetition}`))
)

Effect.runPromise(program)
```

This shape has no built-in spacing. It is appropriate only when the effect itself
blocks, waits, or consumes bounded local work. If the effect returns quickly,
prefer `Schedule.spaced`.

Add schedule-level observability with `Schedule.tapOutput` when the repeat policy
owns the operational signal. Add effect-level logging when the work itself owns
the signal. Keeping the count in the schedule makes it clear that the value is
about recurrence, not about the business result.

##### Notes and caveats

`Effect.repeat` runs the effect once before consulting the schedule. A forever
schedule therefore does not delay startup.

With a raw schedule, `Effect.repeat(schedule)` returns the schedule output if the
schedule completes. A forever schedule does not complete by exhaustion, so this
form is normally used for a long-lived effect rather than for its final value.

A forever repeat should have an owner. In application code, run it in a
supervised fiber, scoped resource, or runtime structure that will interrupt it
during shutdown.

Failures are not swallowed. If the repeated effect fails, repetition stops and
the failure is returned. If failure should be logged and then retried, model that
as retry behavior inside the repeated unit or use a retry policy at the
appropriate boundary.

#### 9.3 Repeat with a pause

`Effect.repeat` can add a deliberate pause between successful runs. This recipe
covers spacing recurrences without turning the repeat into failure recovery.

##### Problem

Without spacing, a successful queue check, cache refresh, or heartbeat can
immediately schedule the next run. Use the schedule to place a fixed pause
between successful recurrences.

##### When to use it

Use this when success is the trigger for another run and each recurrence should
wait the same amount of time.

This is useful when the repeated action is cheap enough to run more than once,
but immediate repetition would be noisy, wasteful, or hard to observe.

##### When not to use it

Do not use this to retry failures. `Effect.repeat` repeats after success; if the
effect fails, repetition stops with that failure. Use `Effect.retry` for
failure-driven attempts.

Do not use this when you need calendar-style periodic timing or alignment to
clock boundaries. A pause between successful recurrences is simpler than a full
periodic schedule.

Do not leave the schedule unbounded unless the surrounding workflow is intended
to keep running. Add a recurrence limit when the repeated action should stop
after a known number of pauses.

##### Schedule shape

The central shape is `Schedule.spaced(duration)`, for example
`Schedule.spaced("10 millis")` in the quick-running snippet below.

With `Effect.repeat`, the original effect runs once immediately. After a
successful run, the schedule decides whether to recur and how long to wait before
that recurrence.

`Schedule.spaced("10 millis").pipe(Schedule.take(3))` means three scheduled
recurrences after the original successful run. If every run succeeds, the effect
runs four times total, with a pause before each recurrence.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let refreshes = 0

const refreshCache = Effect.gen(function*() {
  refreshes += 1
  yield* Console.log(`cache refresh ${refreshes}`)
})

const program = refreshCache.pipe(
  Effect.repeat(Schedule.spaced("10 millis").pipe(Schedule.take(3))),
  Effect.tap((lastRepetition) => Console.log(`last repetition: ${lastRepetition}`))
)

Effect.runPromise(program)
// Output:
// cache refresh 1
// cache refresh 2
// cache refresh 3
// cache refresh 4
// last repetition: 3
```

Here `refreshCache` runs immediately. If it succeeds, Effect waits before the
first recurrence. The same pause is used before each later recurrence, up to
three scheduled recurrences.

The program returned by `Effect.repeat(schedule)` succeeds with the schedule's
final output. With `Schedule.spaced`, that output is the recurrence count.

##### Variants

If you already have a count schedule and want to add a pause to it, use `Schedule.addDelay`:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

const repeatWithPause = Schedule.recurs(3).pipe(
  Schedule.addDelay(() => Effect.succeed("10 millis"))
)

let runs = 0

const program = Effect.gen(function*() {
  runs += 1
  yield* Console.log(`run ${runs}`)
}).pipe(
  Effect.repeat(repeatWithPause),
  Effect.tap((lastRepetition) => Console.log(`last repetition: ${lastRepetition}`))
)

Effect.runPromise(program)
// Output:
// run 1
// run 2
// run 3
// run 4
// last repetition: 3
```

This keeps the recurrence count shape explicit and adds the fixed delay to each
scheduled recurrence.

Use `Schedule.spaced("10 millis").pipe(Schedule.take(3))` when the pause is the
main idea. Use `Schedule.recurs(3).pipe(Schedule.addDelay(...))` when you want to
start from a count policy and attach timing to it.

##### Notes and caveats

The pause is not before the first run. The first evaluation of the effect
happens immediately; the schedule controls only later recurrences.

The pause happens only after success. A failure from the repeated effect stops
the repeat and returns the failure.

`Schedule.spaced` by itself is unbounded. Pair it with a limit, another stopping
rule, or an enclosing lifetime when the workflow must end.

`Schedule.addDelay` adds to any delay the base schedule already chose. With
`Schedule.recurs(3)`, this effectively adds the fixed pause to each recurrence.

#### 9.4 Repeat until a condition becomes true

`Effect.repeat` can keep running successful work until the latest successful
value satisfies a condition. This recipe uses that value as the schedule input.

##### Problem

The condition is checked after each successful run, because the first run
happens before the schedule is consulted. When the condition is already true
after the first run, there are no recurrences.

##### When to use it

Use this when success is not enough by itself; the successful value must also
indicate that the repeated work is complete.

This is useful for short repeat loops such as reading a local status value,
advancing a small workflow step, or sampling a value until it reaches a desired
state.

##### When not to use it

Do not use this to retry failures. If the effect fails, `Effect.repeat` stops
and returns that failure. Use `Effect.retry` when failure should trigger another
attempt.

Do not use this as a full polling recipe for external systems with budgets,
observability, and terminal-state handling. Those concerns usually need
additional schedules, limits, and domain-specific result handling.

Do not leave the repeat unbounded unless the condition is guaranteed by the
surrounding workflow or the fiber has a clear owner that can interrupt it.

##### Schedule shape

Use a schedule whose input is the effect's successful output, then continue while
the condition is not yet true. `Schedule.identity<Result>()` makes each
successful `Result` both the schedule input and output. `Schedule.while` receives
schedule metadata after a successful run. Returning `true` allows another
recurrence; returning `false` stops the repeat.

Because the predicate is `!isDone(input)`, the repeat continues while the latest
successful value is not done and stops as soon as a successful value is done.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type JobStatus =
  | { readonly state: "running"; readonly progress: number }
  | { readonly state: "ready"; readonly resultId: string }

let checks = 0

const checkJob = Effect.gen(function*() {
  checks += 1

  const status: JobStatus = checks < 3
    ? { state: "running", progress: checks * 50 }
    : { state: "ready", resultId: "result-1" }

  yield* Console.log(`check ${checks}: ${status.state}`)
  return status
})

const untilReady = Schedule.identity<JobStatus>().pipe(
  Schedule.while(({ input }) => input.state !== "ready")
)

const finalStatus = checkJob.pipe(
  Effect.repeat(untilReady),
  Effect.tap((status) => Console.log(`final state: ${status.state}`))
)

Effect.runPromise(finalStatus)
// Output:
// check 1: running
// check 2: running
// check 3: ready
// final state: ready
```

`checkJob` runs once immediately. If it succeeds with `{ state: "ready", ... }`,
the schedule stops and `finalStatus` succeeds with that ready status. If it
succeeds with `{ state: "running", ... }`, the schedule allows another
recurrence.

The returned value is the schedule's final output. With
`Schedule.identity<JobStatus>()`, that output is the successful `JobStatus` that
made the condition false.

##### Variants

Add spacing when the next recurrence should wait after each non-terminal success:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type JobStatus =
  | { readonly state: "running"; readonly progress: number }
  | { readonly state: "ready"; readonly resultId: string }

let checks = 0

const checkJob = Effect.gen(function*() {
  checks += 1
  const status: JobStatus = checks < 2
    ? { state: "running", progress: 50 }
    : { state: "ready", resultId: "result-2" }
  yield* Console.log(`check ${checks}: ${status.state}`)
  return status
})

const untilReadyWithPause = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state !== "ready")
)

const finalStatus = checkJob.pipe(
  Effect.repeat(untilReadyWithPause),
  Effect.tap((status) => Console.log(`final state: ${status.state}`))
)

Effect.runPromise(finalStatus)
// Output:
// check 1: running
// check 2: ready
// final state: ready
```

`Schedule.spaced("10 millis")` supplies the pause.
`Schedule.satisfiesInputType<JobStatus>()` tells TypeScript that the schedule
will be stepped with successful `JobStatus` values. `Schedule.passthrough` keeps
that `JobStatus` as the schedule output, so the repeated effect still returns
the final status rather than the recurrence count.

If you do not need to keep the final successful value as the schedule output, you
can omit `Schedule.identity` or `Schedule.passthrough`. When a direct count or
timing schedule has `unknown` input and the predicate reads the successful
output, constrain the input first with `Schedule.satisfiesInputType<JobStatus>()`,
then use `Schedule.while`.

##### Notes and caveats

The condition is checked only after a successful run. A failure from the effect
does not reach the schedule predicate; it stops the repeat immediately.

This is "repeat until success output is good enough," not "retry until success."
The repeated effect must succeed for the condition to be inspected.

The first run is not delayed by the schedule. Any spacing applies only before
later recurrences.

Without a limit or external interruption, a condition that never becomes true can
repeat forever. Add a recurrence limit, time budget, or owning fiber lifetime
when that is not acceptable.

#### 9.5 Repeat while work remains to be done

`Effect.repeat` can keep draining work while each successful result says more
work remains. This recipe focuses on continuation signals such as remaining
counts, cursors, or `hasMore` flags.

##### Problem

The repeated effect should advance one unit of work and return the signal that
decides whether another run is needed. A queue drain may process one batch and
return the number of remaining messages; a paginated import may fetch one page
and return whether there is another page.

##### When to use it

Use this when each successful run advances external state and returns a
continuation signal such as `remaining > 0`, `hasMore: true`, or
`nextCursor !== undefined`.

This shape fits queue drains, local backlog processing, batch cleanup, and
page-by-page ingestion where every run should ask the work source for the next
unit.

##### When not to use it

Do not use this to recover from failures. `Effect.repeat` repeats after success;
if the effect fails, repetition stops with that failure. Use `Effect.retry` when
failures should trigger another attempt.

Do not use this when there is no natural work-complete signal in the successful
result. If the loop is meant to run for the lifetime of a process, use an
explicitly long-lived repeat policy instead.

Do not use this as a deep periodic polling recipe. This section is about draining
known work until the successful output says the drain is complete.

##### Schedule shape

The central shape is an unbounded schedule guarded by the latest successful
output. With `Effect.repeat(schedule)`, the successful value produced by the
effect becomes the schedule input. `Schedule.while` receives schedule metadata,
so `metadata.input` is the latest successful result.

If the predicate returns `true`, the schedule allows another recurrence. If it
returns `false`, the repeat stops.

##### Example

```ts
import { Console, Effect, Schedule } from "effect"

interface QueueDrainResult {
  readonly processed: number
  readonly remaining: number
}

let remainingMessages = 5

const drainOneBatch = Effect.gen(function*() {
  const processed = Math.min(2, remainingMessages)
  remainingMessages -= processed

  const result: QueueDrainResult = {
    processed,
    remaining: remainingMessages
  }

  yield* Console.log(`processed ${result.processed}; remaining ${result.remaining}`)
  return result
})

const whileQueueHasWork = Schedule.forever.pipe(
  Schedule.satisfiesInputType<QueueDrainResult>(),
  Schedule.while(({ input }) => input.remaining > 0)
)

const drainQueue = drainOneBatch.pipe(
  Effect.repeat(whileQueueHasWork),
  Effect.tap((lastRepetition) => Console.log(`last repetition: ${lastRepetition}`))
)

Effect.runPromise(drainQueue)
```

`drainOneBatch` runs once immediately. If it succeeds with `remaining > 0`, the
schedule permits another batch drain. When a successful batch reports
`remaining === 0`, the schedule stops and `drainQueue` completes.

The repeated program succeeds with the schedule output, not with the last
`QueueDrainResult`. With `Schedule.forever`, that output is the recurrence count.

##### Variants

Add a small pause between successful batches when the downstream system needs
breathing room:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

interface PageResult {
  readonly imported: number
  readonly hasMore: boolean
}

let nextPage = 1

const importNextPage = Effect.gen(function*() {
  const result: PageResult = {
    imported: 10,
    hasMore: nextPage < 3
  }
  yield* Console.log(`imported page ${nextPage}`)
  nextPage += 1
  return result
})

const whilePagesRemain = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<PageResult>(),
  Schedule.while(({ input }) => input.hasMore)
)

const importAllAvailablePages = importNextPage.pipe(
  Effect.repeat(whilePagesRemain),
  Effect.tap((lastRepetition) => Console.log(`last repetition: ${lastRepetition}`))
)

Effect.runPromise(importAllAvailablePages)
// Output:
// imported page 1
// imported page 2
// imported page 3
// last repetition: 2
```

Use `Schedule.forever.pipe(Schedule.satisfiesInputType<T>(), Schedule.while(...))`
when the next run should start immediately and the predicate reads the successful
output. Use
`Schedule.spaced(duration).pipe(Schedule.satisfiesInputType<T>(), Schedule.while(...))`
when each successful run should leave a deliberate pause before the next unit of
work.

If you also need a hard safety limit, combine the continuation predicate with a
bounded schedule:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

interface QueueDrainResult {
  readonly processed: number
  readonly remaining: number
}

const atMostOneHundredMoreBatches = Schedule.recurs(100).pipe(
  Schedule.satisfiesInputType<QueueDrainResult>(),
  Schedule.while(({ input }) => input.remaining > 0)
)

const program = Effect.gen(function*() {
  yield* Console.log(`bounded drain policy: ${Schedule.isSchedule(atMostOneHundredMoreBatches)}`)
})

Effect.runPromise(program)
// Output:
// bounded drain policy: true
```

This still stops when the queue reports no remaining work, but it also stops
after one hundred scheduled recurrences even if the result keeps saying that work
remains.

##### Notes and caveats

The first run is not controlled by the schedule. `Effect.repeat` evaluates the
effect once, then passes that successful output to the schedule to decide whether
to run again.

The predicate sees successful outputs only. Failures do not become schedule
inputs for `Effect.repeat`; a failure from the repeated effect stops the repeat.

Make sure the repeated effect advances the drain. If every successful run returns
the same `remaining` or `hasMore` value without consuming work, the schedule can
keep recurring forever.

When you care about the final business result, model that explicitly in the
repeated effect or surrounding workflow. The raw `Effect.repeat(schedule)` result
is the schedule's final output.

### 10. Periodic and Spaced Repeat

#### 10.1 Run every minute

Use this when successful background work should run now and then recur on a
one-minute cadence.

##### Problem

A cache refresh, metrics publisher, or local-state check needs an immediate
first run and later successful recurrences once per minute.

##### When to use it

Use `Schedule.fixed("1 minute")` when minute-level cadence matters and
second-level freshness would be unnecessary load.

This fits background work owned by a long-lived process, scope, or supervised
fiber.

##### When not to use it

Do not use this for failure recovery. If the effect fails, `Effect.repeat`
stops with that failure.

Do not use an unbounded minute loop in a request-response path that needs to
complete.

Do not use this as a cron replacement. A fixed one-minute interval is not the
same as "at the top of every minute" or "only during business hours."

##### Schedule shape

The core schedule is `Schedule.fixed("1 minute")`.

`fixed` schedules recurrences against interval boundaries. If a run takes
longer than a minute, the next recurrence may run immediately, but missed runs
do not pile up. Use `Schedule.spaced("1 minute")` when the gap after completion
is what matters.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let refreshes = 0

const refreshCache = Effect.gen(function*() {
  refreshes += 1
  yield* Console.log(`cache refresh ${refreshes}`)
})

const loop = refreshCache.pipe(
  Effect.repeat(Schedule.fixed("1 minute"))
)

const program = loop.pipe(
  Effect.timeoutOrElse({
    duration: "50 millis",
    orElse: () => Console.log(`demo stopped after ${refreshes} refresh`)
  })
)

Effect.runPromise(program)
// Output:
// cache refresh 1
// demo stopped after 1 refresh
```

The timeout keeps the example quick while still using the real one-minute
schedule.

##### Variants

Use `Schedule.spaced("1 minute")` when every completed run should be followed
by one quiet minute. Add `Schedule.take(n)` when a diagnostic or test should
stop after a fixed number of recurrences.

##### Notes and caveats

The schedule does not delay the first execution. It controls only later
successful recurrences.

`Schedule.fixed("1 minute")` runs one recurrence at a time. It does not start
concurrent catch-up runs.

If transient failures should not stop the loop, handle retry or recovery inside
the repeated effect before applying the periodic repeat.

#### 10.2 Run every hour

Use this when successful background work should run now and then recur on an
hourly cadence.

##### Problem

Slow-moving reference data, local compaction, summary metrics, or another
low-frequency task needs an immediate first run followed by successful hourly
recurrences.

##### When to use it

Use `Schedule.fixed("1 hour")` when the action should stay on a regular
hourly cadence.

This fits background work owned by a long-lived process, scope, or supervised
fiber.

##### When not to use it

Do not use `Effect.repeat` as failure recovery. If the action fails, the
repeated effect fails unless you handle or retry that failure inside the action.

Do not use this for calendar-aware scheduling, such as "run at the top of every
hour" or "run only during business hours." This recipe is about a periodic
one-hour interval.

Do not use a fixed hourly cadence when every run must be followed by one quiet
hour after it completes. Use `Schedule.spaced("1 hour")` for that shape.

##### Schedule shape

`Schedule.fixed("1 hour")` recurs on a fixed interval and outputs the number
of repetitions so far.

With `Effect.repeat`, the first run happens immediately. The schedule controls
successful recurrences after that first run.

If a run takes longer than one hour, the next run starts immediately when the
current run completes, but missed runs do not pile up.

By contrast, `Schedule.spaced("1 hour")` waits one full hour after each
successful run completes.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let syncs = 0

const syncReferenceData = Effect.gen(function*() {
  syncs += 1
  yield* Console.log(`reference-data sync ${syncs}`)
})

const loop = syncReferenceData.pipe(
  Effect.repeat(Schedule.fixed("1 hour"))
)

const program = loop.pipe(
  Effect.timeoutOrElse({
    duration: "50 millis",
    orElse: () => Console.log(`demo stopped after ${syncs} sync`)
  })
)

Effect.runPromise(program)
// Output:
// reference-data sync 1
// demo stopped after 1 sync
```

The timeout keeps the example quick. The hourly schedule itself is unbounded
and should be owned by the surrounding application.

##### Variants

Use `Schedule.spaced("1 hour")` when the requirement is "wait one hour after
finishing" rather than "keep an hourly cadence." Use a named schedule value for
shared hourly policies so the duration is not scattered through background
workers.

##### Notes and caveats

`Schedule.fixed("1 hour")` does not run actions concurrently by itself. A slow
run delays the next run.

Hourly background work often touches caches, snapshots, indexes, or external
state. Decide whether duplicate successful runs are harmless before making the
loop long-lived.

If transient failures should not stop the hourly loop, handle recovery inside
the repeated action before applying the periodic repeat.

#### 10.3 Enforce a pause between iterations

Use `Schedule.spaced` when each successful repeat should wait before the next
iteration starts.

##### Problem

After a refresh, heartbeat, or lightweight poll succeeds, an immediate recurrence
can be too aggressive. The loop should run again only after a known pause.

##### When to use it

Use this when the gap after completed work matters more than wall-clock
alignment.

`Schedule.spaced(duration)` runs the effect once immediately, then waits for the
duration after each successful run before allowing another recurrence.

##### When not to use it

Do not use this to retry failures. `Effect.repeat` is success-driven; a failure
from the effect stops the repeat. Use `Effect.retry` for failure-driven attempts.

Do not use this for fixed-rate cadence such as "run on each one-second
boundary." Use `Schedule.fixed(duration)` for interval alignment.

Do not use this when the first run itself must be delayed. The schedule controls
only recurrences after the first evaluation.

##### Schedule shape

The central shape is `Schedule.spaced("2 seconds")`: each scheduled recurrence
is separated from the previous successful run by a two-second pause.

This is different from `Schedule.fixed("2 seconds")`. `fixed` schedules recurrences against interval boundaries. If the effect takes longer than the interval, the next recurrence may happen immediately so the schedule can continue from the current time. `spaced` still waits the requested duration after the run completes.

When the repeat should stop after a known number of scheduled recurrences, add `Schedule.take`, as in `Schedule.spaced("2 seconds").pipe(Schedule.take(3))`. This allows three scheduled recurrences after the original successful run. If all runs succeed, the effect runs four times total.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let run = 0

const refresh = Effect.gen(function*() {
  run += 1
  yield* Console.log(`refresh ${run}`)
  return run
})

const program = Effect.gen(function*() {
  const finalRecurrence = yield* refresh.pipe(
    Effect.repeat(Schedule.spaced("10 millis").pipe(Schedule.take(2)))
  )
  yield* Console.log(`repeat returned schedule output ${finalRecurrence}`)
})

Effect.runPromise(program)
// Output:
// refresh 1
// refresh 2
// refresh 3
// repeat returned schedule output 2
```

This prints three refreshes: the initial run plus two scheduled recurrences. The
short delay keeps the example quick while still showing that the schedule waits
between successful runs.

##### Variants

Name the schedule when the same spacing policy is shared across a workflow, for
example `const everyTwoSeconds = Schedule.spaced("2 seconds").pipe(Schedule.take(5))`.

Use `Schedule.spaced(duration)` for "wait after completed work." Use
`Schedule.fixed(duration)` for "target this periodic interval."

##### Notes and caveats

The pause is not added before the first run. The schedule controls only recurrences after the first successful evaluation.

The pause happens only after success. A failure from the repeated effect stops the repeat and returns the failure.

`Schedule.spaced` is unbounded by itself. Combine it with `Schedule.take`, another stopping rule, or an enclosing lifetime when the workflow must end.

The repeated program succeeds with the schedule's final output when the schedule completes. With `Schedule.spaced`, that output is the recurrence count.

#### 10.4 Slow down a tight worker loop

Use `Schedule.spaced` when a worker can complete successfully without finding
work and should not immediately check again.

##### Problem

An empty queue, inbox, or table can make a worker complete almost instantly. If
that successful "nothing available" result repeats without a pause, the worker
spins and burns CPU.

##### When to use it

Use this when each successful worker iteration should leave a deliberate pause
before the next check.

This fits simple polling workers where "no work available" is a successful
observation, not an error.

##### When not to use it

Do not use this to recover from failures. `Effect.repeat` stops when the worker
effect fails. Use `Effect.retry` when failure should trigger the next attempt.

Do not use this when the worker must run on clock-aligned boundaries.
`Schedule.spaced` waits after a successful run completes, so start-to-start time
includes the work duration plus the spacing.

Do not treat this as a complete load-shedding policy. This recipe only prevents
a fast successful loop from spinning.

##### Schedule shape

The central shape is `Schedule.spaced("250 millis")`.

With `Effect.repeat`, the worker runs once immediately. After a successful iteration, `Schedule.spaced("250 millis")` waits 250 milliseconds before allowing the next recurrence.

The spacing is after success, not before the first run. If the worker fails, the
repeat fails immediately.

For a bounded worker loop, combine the spacing with `Schedule.take`:

`Schedule.spaced("250 millis").pipe(Schedule.take(100))` permits 100 scheduled
recurrences after the initial successful run. If every iteration succeeds, the
worker runs 101 times total.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let checks = 0

const pollOnce = Effect.gen(function*() {
  checks += 1
  yield* Console.log(`queue check ${checks}: empty`)
  return "empty" as const
})

const program = Effect.gen(function*() {
  const finalRecurrence = yield* pollOnce.pipe(
    Effect.repeat(Schedule.spaced("10 millis").pipe(Schedule.take(3)))
  )
  yield* Console.log(`worker stopped after recurrence ${finalRecurrence}`)
})

Effect.runPromise(program)
// Output:
// queue check 1: empty
// queue check 2: empty
// queue check 3: empty
// queue check 4: empty
// worker stopped after recurrence 3
```

The worker prints four checks: one initial check and three scheduled
recurrences. In a real worker, use a production interval such as 250
milliseconds or one second instead of the short example delay.

##### Variants

Use a named schedule when the worker policy is shared, for example
`const workerSpacing = Schedule.spaced("1 second").pipe(Schedule.take(60))`.
This keeps the worker from spinning and gives finite jobs a clear limit.

Use a shorter spacing when fast pickup matters and the empty loop is still too expensive. Use a longer spacing when empty checks are cheap to defer and CPU quietness matters more than immediate pickup.

##### Notes and caveats

`Schedule.spaced` is unbounded by itself. For finite examples, tests, command-line jobs, or short-lived workers, add `Schedule.take` or another stopping rule.

The pause is controlled by successful completion of the worker effect. A long-running iteration is not interrupted or shortened by the schedule.

A failure from the worker stops the repeat. The schedule does not turn failures into delayed successes.

The output of the repeated program is the schedule's final output when the schedule completes. With `Schedule.spaced`, that output is the recurrence count.

#### 10.5 Use spacing to smooth resource usage

Use `Schedule.spaced` when a successful repeat loop should spread resource use
over time instead of producing bursts.

##### Problem

Each run may consume CPU, database connections, queue visibility checks, cache
bandwidth, file handles, or external API quota. If the next iteration starts
immediately after each success, the loop can create bursts of usage even when every
individual run is correct.

##### When to use it

Use this when the loop should keep making progress, but each successful
iteration should leave a predictable gap before the next one starts.

This is useful for polling, periodic cleanup, small batch processing, and maintenance work where the exact wall-clock boundary is less important than avoiding back-to-back successful runs.

Use `Schedule.spaced(duration)` when the policy is "after a successful run completes, wait this long before the next recurrence."

##### When not to use it

Do not use this to retry failures. `Effect.repeat` stops when the effect fails.
Use `Effect.retry` for failure-driven recovery.

Do not use this as a full rate limiter. Spacing one repeat loop smooths that loop's own resource usage, but it does not coordinate with other fibers, processes, users, or services.

Do not use this when work must run on fixed interval boundaries. `Schedule.spaced` waits after completion, so the time between starts includes both the work duration and the configured spacing. Use `Schedule.fixed(duration)` for fixed-rate cadence.

##### Schedule shape

The central shape is `Schedule.spaced("1 second").pipe(Schedule.take(30))`.
`Schedule.spaced("1 second")` waits one second after each successful iteration
before allowing the next recurrence.

`Schedule.take(30)` bounds the repeat to 30 scheduled recurrences after the initial successful run. If every run succeeds, the effect runs 31 times total.

Together, the schedule says: run now, then keep repeating after success with a fixed gap between completed work items, and stop after a known recurrence limit.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let batch = 0

const processOneBatch = Effect.gen(function*() {
  batch += 1
  yield* Console.log(`processed batch ${batch}`)
  return batch
})

const smoothBatchSchedule = Schedule.spaced("10 millis").pipe(
  Schedule.take(3)
)

const program = Effect.gen(function*() {
  const finalRecurrence = yield* processOneBatch.pipe(
    Effect.repeat(smoothBatchSchedule)
  )
  yield* Console.log(`smoothing run stopped after recurrence ${finalRecurrence}`)
})

Effect.runPromise(program)
// Output:
// processed batch 1
// processed batch 2
// processed batch 3
// processed batch 4
// smoothing run stopped after recurrence 3
```

The example prints four batch runs with a short pause between successful
recurrences. Use a larger duration when smoothing real CPU, connection, cache,
or API pressure.

##### Variants

Use shorter spacing when responsiveness matters and each iteration is cheap.
Use longer spacing when repeated work competes with interactive traffic, keeps
connections open, or causes visible load on a dependency.

For finite jobs, keep the recurrence limit explicit with `Schedule.take` or
another stopping rule.

For long-lived services, the schedule can be unbounded, but the fiber running the repeat should still be tied to the service lifetime.

##### Notes and caveats

The spacing is applied after successful completion, not before the first run.

The duration of the work is not hidden by the schedule. If one iteration takes three seconds and the spacing is one second, the next start is roughly four seconds after the previous start.

Spacing smooths only this repeat loop. It does not provide a global request budget, distributed coordination, or fairness across callers.

Choose a spacing that matches the resource being protected. A database maintenance loop, a local cache refresh, and an external API poll usually need different gaps.

`Schedule.spaced` is unbounded by itself. Add `Schedule.take` or another stopping rule when the repeat belongs to a finite operation, test, or command-line program.

### 11. Repeat with Limits

#### 11.1 Repeat at most N times

Use this when a successful effect needs a count limit and the off-by-one
behavior of `Effect.repeat` must stay explicit.

##### Problem

The requirement is "run once now, then allow at most `N` more successful
recurrences."

With `Effect.repeat`, the effect runs once before the schedule is consulted.
`Schedule.recurs(n)` therefore means "after the original successful run, allow
at most `n` recurrences."

##### When to use it

Use this when the repeat limit is a recurrence budget: one original run now,
followed by at most `N` more successful runs.

This fits bounded sampling, short repeated maintenance actions, and repeat
loops where the count itself is the policy.

##### When not to use it

Do not use `Schedule.recurs(n)` unchanged when the requirement counts total
executions. If you want at most `N` total executions, use
`Schedule.recurs(N - 1)` for positive `N`.

Do not use repeat limits to recover from failures. `Effect.repeat` repeats only
after success; if the effect fails, repetition stops with that failure.

##### Schedule shape

The count belongs to the scheduled recurrences, not to the original run:

| Requirement                               | Schedule                 |
| ----------------------------------------- | ------------------------ |
| original run only                         | `Schedule.recurs(0)`     |
| original run plus at most 1 recurrence    | `Schedule.recurs(1)`     |
| original run plus at most `N` recurrences | `Schedule.recurs(N)`     |
| at most `N` total executions, for `N > 0` | `Schedule.recurs(N - 1)` |

`Schedule.recurs(n)` outputs a zero-based recurrence count. When used directly
with `Effect.repeat`, the repeated program returns the final schedule output.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

let runs = 0

const sample = Effect.gen(function*() {
  runs += 1
  yield* Console.log(`run ${runs}`)
  return runs
})

const program = Effect.gen(function*() {
  const scheduleOutput = yield* sample.pipe(
    Effect.repeat(Schedule.recurs(3))
  )

  yield* Console.log(`total executions: ${runs}`)
  yield* Console.log(`schedule output: ${scheduleOutput}`)
})

Effect.runPromise(program)
// Output:
// run 1
// run 2
// run 3
// run 4
// total executions: 4
// schedule output: 3
```

This can run four times total: one original run plus three scheduled
recurrences.

##### Variants

When the only policy is a repeat count and you want the final successful value
of the effect, use `Effect.repeat({ times: n })`. `times` also counts
recurrences after the original run.

Use `Schedule.recurs(n)` when you want a first-class schedule value that can be
named, reused, or composed with other schedule combinators.

##### Notes and caveats

`Schedule.recurs(n)` allows at most `n` recurrences. It reaches that limit only
if the original run and every repeated run succeed.

The original run is not part of the schedule count. This is the main
off-by-one point to check when translating requirements.

Passing `Schedule.recurs(n)` directly to `Effect.repeat` returns the schedule's
final output. Use `Effect.repeat({ times: n })` when the final value of the
effect is the value you want to keep.

#### 11.2 Repeat only within a time budget

Use this when successful recurrences should stay open only for an elapsed time
budget.

##### Problem

A worker needs to poll during a warm-up window, refresh a cache briefly after a
trigger, or sample an operation for at most a few seconds.

The effect should run immediately, then allow later successful recurrences only
while the elapsed budget remains open.

##### When to use it

Use this when the limit is naturally expressed as elapsed schedule time:
"repeat for up to 10 seconds" or "keep checking during this 1 minute window."

This is a good fit when each successful run may allow another recurrence, but
the loop must not remain open forever.

##### When not to use it

Do not use this to retry failures. `Effect.repeat` repeats after success; if
the effect fails, repetition stops with that failure.

Do not use a schedule budget as a hard timeout for a run that is already in
progress. The schedule is checked between successful runs; it does not interrupt
the currently running effect.

Do not use this when the limit is purely a count. Use `Schedule.recurs(n)` for
that, or combine count and time when both constraints matter.

##### Schedule shape

Combine a cadence with `Schedule.during(duration)`:

`Schedule.spaced("1 second").pipe(Schedule.both(Schedule.during("10 seconds")))`

`Schedule.spaced` chooses the delay between successful recurrences.
`Schedule.during` tracks elapsed schedule time. `Schedule.both` requires both
schedules to continue, so the repeat stops when the budget is exhausted.

##### Example

```ts runnable
import { Console, Effect, Schedule } from "effect"

let polls = 0

const pollOnce = Effect.gen(function*() {
  polls += 1
  yield* Console.log(`poll ${polls}`)
})

const repeatWithinBudget = Schedule.spaced("20 millis").pipe(
  Schedule.both(Schedule.during("75 millis"))
)

const program = Effect.gen(function*() {
  yield* pollOnce.pipe(Effect.repeat(repeatWithinBudget))

  yield* Console.log(`total polls: ${polls}`)
})

Effect.runPromise(program)
// Output may vary: elapsed timing can cross the budget boundary differently under load
// poll 1
// poll 2
// poll 3
// poll 4
// poll 5
// total polls: 5
```

The example uses millisecond durations so it terminates quickly. The same shape
works with larger production budgets.

##### Variants

Add a count cap when the repeat should stop at whichever limit is reached first:

Use the same cadence and budget, then add
`Schedule.both(Schedule.recurs(20))`.

If each individual run also needs a hard duration limit, apply
`Effect.timeout` to the repeated effect itself. The schedule budget still limits
only the recurrence window after successful runs.

##### Notes and caveats

The first run is not delayed. `Effect.repeat` evaluates the effect once, then
uses the schedule for later successful recurrences.

`Schedule.during(duration)` is a stopping condition, not a cadence. Combine it
with `Schedule.spaced`, `Schedule.fixed`, or another delay-producing schedule.

The elapsed budget is checked between successful runs. It is not a substitute
for `Effect.timeout` when a single run must be interrupted after a duration.

Because `Schedule.both` combines outputs, the resulting schedule output is a
tuple. Keep that output internal when callers only care that the loop finished.

#### 11.3 Repeat until a threshold is reached

Use this recipe when the successful output of each run decides whether repetition
should continue.

##### Problem

A progress read, backlog sample, score refresh, or other domain check returns a
successful value that can be compared with a threshold.

With `Effect.repeat`, the effect runs once before the schedule is consulted.
After each successful run, the successful output becomes the schedule input.
That is the value `Schedule.while` inspects when it decides whether another
recurrence is allowed.

##### When to use it

Use this when the repeated operation succeeds before the whole workflow is done,
and the successful output tells you how close the workflow is to completion.

Typical examples include sampling progress until it reaches `100`, processing
batches until the backlog falls below a target, or refreshing a score until it
is at least a required minimum.

##### When not to use it

Do not use this to retry failures. If the effect fails, `Effect.repeat` stops
with that failure before the schedule predicate can inspect anything.

Do not use this when the threshold is not visible in the successful output. In
that case, make the effect return the domain measurement you need, or move the
decision into the effect itself.

Do not use an unbounded threshold loop unless the threshold is guaranteed by the
surrounding workflow or the fiber has a clear lifetime owner.

##### Schedule shape

Make the successful output the schedule input, preserve it as the schedule
output, then continue while it is still below the threshold.

`Schedule.while` receives schedule metadata after a successful run. Returning
`true` allows another recurrence. Returning `false` stops the repeat.

The predicate above therefore means "repeat while the latest successful
`Progress` value is still below `100`." When a successful run returns
`percent >= 100`, the repeat stops.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

interface Progress {
  readonly percent: number
}

let percent = 0

const readProgress = Effect.gen(function*() {
  percent = Math.min(percent + 40, 100)
  yield* Console.log(`progress: ${percent}%`)
  return { percent }
})

const untilComplete = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<Progress>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.percent < 100)
)

const program = Effect.gen(function*() {
  const finalProgress = yield* readProgress.pipe(
    Effect.repeat(untilComplete)
  )

  yield* Console.log(`final progress: ${finalProgress.percent}%`)
})

Effect.runPromise(program)
// Output:
// progress: 40%
// progress: 80%
// progress: 100%
// final progress: 100%
```

`readProgress` runs once immediately. If it succeeds with `percent >= 100`, no
recurrence is scheduled. If it succeeds with `percent < 100`, the schedule
allows another run.

Because the schedule uses `Schedule.passthrough`, the repeated program succeeds
with the final successful `Progress` value that stopped the loop.

##### Variants

Add a recurrence limit or a pause when the threshold may take time to appear:

Use the same threshold schedule, then compose it with
`Schedule.bothLeft(Schedule.recurs(20).pipe(Schedule.satisfiesInputType<Progress>()))`.

The repeat then stops when either a successful output reaches `percent >= 100`
or twenty scheduled recurrences have been allowed.

##### Notes and caveats

The threshold predicate inspects only successful outputs, after each successful
run. It does not see failures.

The first run is not delayed by the schedule. Delays apply only before later
recurrences.

Use `<` for "repeat while below the threshold" and `<=` when the threshold must
be strictly exceeded. Make the boundary explicit in the predicate.

When composing a timing or count schedule with `Schedule.while`, constrain the
input type with `Schedule.satisfiesInputType<T>()` before reading
`metadata.input`, then use `Schedule.passthrough` when callers need the final
successful value.

#### 11.4 Repeat until output becomes stable

Use this recipe when repeated successful observations should stop once a named
stability comparison says the output is unchanged.

##### Problem

A read model may be stable when two consecutive reads have the same version. A
cache snapshot may be stable when its checksum stops changing. The repeat
should compare successful observations and stop when the named comparison says
the value is stable.

##### When to use it

Use this when success means "I observed the current state", not necessarily
"the workflow is finished".

The schedule should carry enough state to compare the latest successful output
with the previous successful output. The stability predicate should be explicit:
same version, same checksum, same count, or another domain comparison that
means "unchanged" for this workflow.

##### When not to use it

Do not use this to retry failures. `Effect.repeat` repeats after successful
results; if the effect fails, repetition stops with that failure.

Do not use this when one unchanged observation is too weak a signal. Some
systems can return the same value briefly and then change again. In that case,
require a stable streak or combine the stability check with a delay and a count
cap.

Do not hide an expensive or fuzzy comparison inside the schedule without naming
the criterion. Readers should be able to tell exactly what "stable" means.

##### Schedule shape

Start with a cadence, constrain it to accept the successful observation as
input, preserve that observation as output, then reduce it into comparison
state.

`Schedule.passthrough` keeps the latest successful observation as the schedule
output. `Schedule.reduce` remembers the previous observation and computes a
stability state. `Schedule.while` stops when that state is stable.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

interface Snapshot {
  readonly version: string
  readonly itemCount: number
}

interface StabilityState {
  readonly previous: Snapshot | undefined
  readonly current: Snapshot | undefined
  readonly stable: boolean
}

const snapshots: ReadonlyArray<Snapshot> = [
  { version: "v1", itemCount: 10 },
  { version: "v2", itemCount: 12 },
  { version: "v2", itemCount: 12 }
]

let index = 0

const readSnapshot = Effect.gen(function*() {
  const lastSnapshot = snapshots[snapshots.length - 1]!
  const snapshot = snapshots[index] ?? lastSnapshot
  index += 1
  yield* Console.log(
    `snapshot ${snapshot.version} with ${snapshot.itemCount} items`
  )
  return snapshot
})

const sameSnapshot = (left: Snapshot, right: Snapshot) =>
  left.version === right.version && left.itemCount === right.itemCount

const initialState: StabilityState = {
  previous: undefined,
  current: undefined,
  stable: false
}

const untilStable = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<Snapshot>(),
  Schedule.passthrough,
  Schedule.reduce(
    () => initialState,
    (state, current): StabilityState => ({
      previous: state.current,
      current,
      stable: state.current !== undefined && sameSnapshot(state.current, current)
    })
  ),
  Schedule.while(({ output }) => !output.stable)
)

const program = Effect.gen(function*() {
  const state = yield* readSnapshot.pipe(Effect.repeat(untilStable))
  yield* Console.log(`stable version: ${state.current?.version}`)
})

Effect.runPromise(program)
// Output:
// snapshot v1 with 10 items
// snapshot v2 with 12 items
// snapshot v2 with 12 items
// stable version: v2
```

`readSnapshot` runs once before the schedule is consulted. The first successful
snapshot cannot be stable because there is no previous successful snapshot to
compare with. After each later success, the schedule compares the latest
snapshot with the previous one. When `sameSnapshot` returns `true`, the
`Schedule.while` predicate returns `false`, and the repeat stops.

The returned value is the final `StabilityState`. Its `current` field is the
snapshot that matched `previous`.

##### Variants

Require several consecutive stable observations when a single match is not
strong enough. Carry a streak count in the reduced state and stop only after the
count reaches the required number of unchanged comparisons.

##### Notes and caveats

The stability predicate sees only successful outputs. Failures do not become
schedule inputs for `Effect.repeat`.

Decide whether stability means "same as the immediately previous output" or
"within a tolerance". For numeric observations, exact equality is often the
wrong criterion; prefer an explicit tolerance such as an absolute delta.

The first run is not delayed by the schedule. Delays apply only before later
recurrences.

A stability schedule can run forever if the output never becomes stable. Add a
count limit, time budget, or external interruption when the surrounding workflow
does not already provide one.

#### 11.5 Repeat until a terminal state is observed

Use this when successful status observations should repeat until the observed
domain state is terminal.

##### Problem

A job observer, workflow monitor, or similar status check returns domain states
such as queued, running, succeeded, failed, or canceled.

With `Effect.repeat`, the effect runs once before the schedule is consulted.
After each successful observation, the successful status value becomes the
schedule input. `Schedule.while` can allow another recurrence only while that
status is non-terminal.

##### When to use it

Use this when the repeated effect succeeds with a domain status even while the
domain workflow is still in progress.

This is a good fit for small status-observation loops where states such as
`"queued"` and `"running"` mean "observe again", while states such as
`"succeeded"`, `"failed"`, or `"canceled"` mean "stop repeating".

##### When not to use it

Do not use this to retry failed observations. If the observation effect fails,
`Effect.repeat` stops with that failure before the schedule predicate can inspect
a status.

Do not use this as a full polling recipe for external systems with deadlines,
logging, cancellation strategy, and failure classification. This recipe covers
only the repeat condition based on successful status observations.

Do not leave the repeat unbounded unless the status is guaranteed to become
terminal or the fiber has a clear owner that can interrupt it.

##### Schedule shape

Make the successful status the schedule input, preserve it as the schedule
output, and continue while the latest status is not terminal.

`Schedule.while` receives schedule metadata after a successful run. In
`Effect.repeat`, `metadata.input` is the successful output from the repeated
effect. Returning `true` allows another recurrence. Returning `false` stops the
repeat.

The predicate above therefore repeats after successful non-terminal statuses and
stops as soon as a successful terminal status is observed.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type JobStatus =
  | { readonly state: "queued" }
  | { readonly state: "running"; readonly percent: number }
  | { readonly state: "succeeded"; readonly resultId: string }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "canceled" }

const isTerminal = (status: JobStatus): boolean =>
  status.state === "succeeded" ||
  status.state === "failed" ||
  status.state === "canceled"

const statuses: ReadonlyArray<JobStatus> = [
  { state: "queued" },
  { state: "running", percent: 40 },
  { state: "running", percent: 80 },
  { state: "succeeded", resultId: "result-123" }
]

let index = 0

const observeJob = Effect.gen(function*() {
  const lastStatus = statuses[statuses.length - 1]!
  const status = statuses[index] ?? lastStatus
  index += 1
  yield* Console.log(`observed ${status.state}`)
  return status
})

const untilTerminal = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminal(input))
)

const program = Effect.gen(function*() {
  const terminalStatus = yield* observeJob.pipe(
    Effect.repeat(untilTerminal)
  )

  yield* Console.log(`final state: ${terminalStatus.state}`)
})

Effect.runPromise(program)
// Output:
// observed queued
// observed running
// observed running
// observed succeeded
// final state: succeeded
```

`observeJob` runs once immediately. If it succeeds with a terminal status, there
are no recurrences. If it succeeds with a non-terminal status, the schedule
allows another observation.

Because the schedule uses `Schedule.passthrough`, the repeated program succeeds
with the final successful `JobStatus` that made the predicate return `false`.

##### Variants

Add a pause and a recurrence cap when terminal status may take time but the loop
must still have a limit:

Use the same terminal-status schedule, then compose it with
`Schedule.bothLeft(Schedule.recurs(20).pipe(Schedule.satisfiesInputType<JobStatus>()))`.

The repeat stops when either a successful terminal status is observed or the
recurrence cap is reached. `Schedule.recurs(20)` permits up to 20 recurrences
after the initial observation.

##### Notes and caveats

The terminal-state predicate inspects successful outputs only, after each
successful run. Failures from the observed effect do not become schedule inputs.

The first observation is not delayed by the schedule. Spacing applies only
before later recurrences.

Model terminal domain states as successful values when they are normal outcomes
of the observed workflow. Reserve the failure channel for failures of the
observation itself.

When composing a count or timing schedule with `Schedule.while`, constrain the
input type with `Schedule.satisfiesInputType<T>()` before reading
`metadata.input`.

## Part IV — Polling Recipes

### 12. Poll Until Completion

#### 12.1 Poll a background job until done

Use `Effect.repeat` with a spaced schedule when a submitted job exposes a
read-only status endpoint and should be observed until it reaches a terminal
domain state.

##### Problem

After submission returns a job id, a successful status check can still report
`"queued"` or `"running"`. Those are ordinary job states, not failures of the
status request. Polling should continue until a terminal state is observed.

##### When to use it

Use this when polling is driven by successful observations of a remote job's
state.

This is a good fit for APIs that expose statuses such as `"queued"`,
`"running"`, `"succeeded"`, `"failed"`, or `"canceled"`, where the terminal
states are ordinary successful responses from the status endpoint.

##### When not to use it

Do not use this to retry a failing status endpoint. With `Effect.repeat`, a
failure from the status-check effect stops the repeat immediately. Use retry
around the status check when transport or decoding failures should be retried.

Do not use this section as a timeout recipe. This recipe shows the basic polling
shape and a small recurrence cap. Deadline-oriented polling belongs in the
timeout recipes.

Do not treat a domain `"failed"` job status as an effect failure unless your
caller explicitly wants job failure to fail the effect after polling completes.

##### Schedule shape

Use a timing schedule for the pause between status checks, constrain its input
to the status type, pass the latest status through as the schedule output, and
continue only while that status is not terminal.

`Schedule.spaced("2 seconds")` supplies the delay before each recurrence.
`Schedule.satisfiesInputType<JobStatus>()` constrains the timing schedule before
the predicate reads `metadata.input`. `Schedule.passthrough` keeps the successful
`JobStatus` as the schedule output, so the repeated effect returns the final
observed status.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type JobStatus =
  | { readonly state: "queued" }
  | { readonly state: "running"; readonly percent: number }
  | { readonly state: "succeeded"; readonly resultId: string }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "canceled" }

type StatusCheckError = {
  readonly _tag: "StatusCheckError"
  readonly message: string
}

const isTerminal = (status: JobStatus): boolean =>
  status.state === "succeeded" ||
  status.state === "failed" ||
  status.state === "canceled"

let step = 0

const nextStatus = (): JobStatus => {
  step += 1
  switch (step) {
    case 1:
      return { state: "queued" }
    case 2:
      return { state: "running", percent: 40 }
    default:
      return { state: "succeeded", resultId: "result-123" }
  }
}

const checkJobStatus = (jobId: string): Effect.Effect<JobStatus, StatusCheckError> =>
  Effect.gen(function*() {
    const status = nextStatus()
    yield* Console.log(`${jobId}: ${status.state}`)
    return status
  })

const pollUntilTerminal = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminal(input))
)

const program = Effect.gen(function*() {
  const finalStatus = yield* checkJobStatus("job-123").pipe(
    Effect.repeat(pollUntilTerminal)
  )
  yield* Console.log(`final status: ${finalStatus.state}`)
})

Effect.runPromise(program)
// Output:
// job-123: queued
// job-123: running
// job-123: succeeded
// final status: succeeded
```

The example checks immediately, logs two non-terminal statuses, waits briefly
between recurrences, and stops when `"succeeded"` is observed.

The resulting effect succeeds with the terminal `JobStatus` when a terminal
status is observed. It fails with `StatusCheckError` only when a status check
effect fails.

##### Variants

Add a recurrence cap when the caller wants to stop after a small number of
observations even if the job is still non-terminal, for example by combining the
status schedule with `Schedule.recurs(30)` using `Schedule.bothLeft`. The result
is still a `JobStatus`: either terminal, or the last non-terminal status before
the cap stopped the repeat.

If a terminal domain state should fail the caller, keep polling until the
terminal status is observed, then handle the final successful value in a
separate step. That keeps polling failures and job-domain failures distinct.

##### Notes and caveats

`Schedule.while` sees only successful outputs from the status check. It does not
classify effect failures.

The first status check is not delayed. The schedule controls recurrences after
the first run.

Use `Schedule.passthrough` when composing timing or counting schedules and the
caller needs the final observed status.

When a timing or count schedule is combined with `Schedule.while`, apply
`Schedule.satisfiesInputType<T>()` before reading `metadata.input`.

#### 12.2 Poll payment status until settled

Use polling when a payment provider reports in-flight and terminal states
through a read-only status endpoint.

##### Problem

The status request can succeed while the payment is still in flight, returning
domain states such as `"pending"` or `"processing"`. You want to poll successful
observations until the payment reaches a settled terminal state, such as
`"settled"`, `"failed"`, or `"canceled"`.

##### When to use it

Use this when polling is an observation loop: each request reads the current
payment status, and non-settled states mean "wait and observe again".

This is a good fit when the payment provider clearly models in-progress and
terminal states, and those terminal states are normal business outcomes rather
than transport failures.

##### When not to use it

Do not use this to retry failed status requests. If the status effect fails,
`Effect.repeat` stops with that failure before the schedule can inspect a
payment status.

Do not use this as the complete safety policy for payment writes. Creating,
capturing, refunding, or otherwise mutating a payment needs separate protection
around idempotency, duplicate submissions, and provider-specific guarantees.

Do not leave production polling unbounded unless the fiber has an owner that can
interrupt it and the external system can tolerate the polling rate.

##### Schedule shape

Make the successful payment status the schedule input, preserve it as the
schedule output, and continue only while it is not settled.

With `Effect.repeat`, the first status request runs immediately. After each
successful observation, the observed `PaymentStatus` becomes the schedule input.
`Schedule.while` returns `true` to allow another recurrence and `false` to stop.

`Schedule.satisfiesInputType<PaymentStatus>()` is applied before reading
`metadata.input`, because `Schedule.spaced` is a timing schedule and is not
constructed from `PaymentStatus` values. `Schedule.passthrough` keeps the final
observed status as the value returned by the repeated effect.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type PaymentStatus =
  | { readonly state: "pending"; readonly paymentId: string }
  | { readonly state: "processing"; readonly paymentId: string }
  | { readonly state: "requires_review"; readonly paymentId: string }
  | { readonly state: "settled"; readonly paymentId: string; readonly settlementId: string }
  | { readonly state: "failed"; readonly paymentId: string; readonly reason: string }
  | { readonly state: "canceled"; readonly paymentId: string }

const isSettled = (status: PaymentStatus): boolean =>
  status.state === "settled" ||
  status.state === "failed" ||
  status.state === "canceled"

let step = 0

const nextPaymentStatus = (): PaymentStatus => {
  step += 1
  switch (step) {
    case 1:
      return { state: "pending", paymentId: "pay_123" }
    case 2:
      return { state: "processing", paymentId: "pay_123" }
    default:
      return {
        state: "settled",
        paymentId: "pay_123",
        settlementId: "set_456"
      }
  }
}

const observePaymentStatus = Effect.gen(function*() {
  const status = nextPaymentStatus()
  yield* Console.log(`payment ${status.paymentId}: ${status.state}`)
  return status
})

const pollUntilSettled = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<PaymentStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isSettled(input))
)

const program = Effect.gen(function*() {
  const finalStatus = yield* observePaymentStatus.pipe(
    Effect.repeat(pollUntilSettled)
  )
  yield* Console.log(`final payment status: ${finalStatus.state}`)
})

Effect.runPromise(program)
// Output:
// payment pay_123: pending
// payment pay_123: processing
// payment pay_123: settled
// final payment status: settled
```

`observePaymentStatus` runs once before any delay. If the first successful
status is already settled, there are no recurrences. If the status is
`"pending"`, `"processing"`, or `"requires_review"`, the schedule waits two
seconds in production before observing again. The snippet uses a shorter delay
so it finishes quickly.

The repeated effect succeeds with the terminal `PaymentStatus` that made
`isSettled` return `true`.

##### Variants

Use `Schedule.identity<PaymentStatus>().pipe(Schedule.while(...))` only when
you want to demonstrate the stop condition without a delay. Real payment
polling should include spacing so successful non-terminal observations do not
turn into a tight loop.

##### Notes and caveats

Treat in-progress states as successful observations. `"pending"`,
`"processing"`, and similar states usually mean the provider accepted the status
request and the payment workflow is still moving.

Treat terminal business states as successful observations too. A failed or
canceled payment can be the final answer from the payment domain, not a failure
of the status request itself.

Keep the polling effect read-only. This recipe is about observing status until a
terminal state appears, not about repeating payment mutations.

The first observation is not delayed by the schedule. Spacing applies only
before later recurrences.

Choose a polling interval that is acceptable for the provider and for your
users. Time budgets, deadlines, and fallback behavior are separate recipes.

#### 12.3 Poll an export job until ready

Use polling when an export service returns an id before the exported file is
ready.

##### Problem

For a CSV or report export, the status request can succeed while the export is
still `"running"`. That is a domain state, not an effect failure. The effect
should fail only when the status request itself cannot be performed or decoded.

##### When to use it

Use this when an export API separates job creation from file readiness, and the
status endpoint returns ordinary business states such as `"running"`, `"ready"`,
or `"failed"`.

This is a good fit when the caller wants the final observed export status and
can decide what to do with a ready download URL or a failed export reason.

##### When not to use it

Do not use this to retry failed status requests. With `Effect.repeat`, a failure
from the status-check effect stops the repeat immediately. If transport failures
should be retried, put retry behavior around the status check separately.

Do not model an export-domain `"failed"` status as an effect failure inside the
polling schedule. Poll until the terminal domain state is observed, then decide
whether that final status should fail the caller.

Do not use this as a timeout recipe. This section shows a polling loop with a
small recurrence cap. Deadline-oriented polling belongs in Chapter 17.

##### Schedule shape

Use a spaced schedule for the pause between status checks, preserve the latest
successful export status, and continue only while the export is still running.

`Effect.repeat` runs the first status check immediately. After each successful
check, the resulting `ExportStatus` becomes the schedule input.
`Schedule.while` returns `true` for `"running"` so another check is scheduled,
and returns `false` for `"ready"` or `"failed"` so polling stops.

`Schedule.satisfiesInputType<ExportStatus>()` is applied before reading
`metadata.input`, because `Schedule.spaced` is a timing schedule rather than a
schedule constructed from export statuses. `Schedule.passthrough` keeps the
latest `ExportStatus` as the value returned by the repeated effect.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type ExportStatus =
  | { readonly state: "running"; readonly exportId: string; readonly percent: number }
  | { readonly state: "ready"; readonly exportId: string; readonly downloadUrl: string }
  | { readonly state: "failed"; readonly exportId: string; readonly reason: string }

type ExportStatusError = {
  readonly _tag: "ExportStatusError"
  readonly message: string
}

let step = 0

const nextExportStatus = (exportId: string): ExportStatus => {
  step += 1
  switch (step) {
    case 1:
      return { state: "running", exportId, percent: 25 }
    case 2:
      return { state: "running", exportId, percent: 80 }
    default:
      return {
        state: "ready",
        exportId,
        downloadUrl: "https://example.com/report.csv"
      }
  }
}

const checkExportStatus = (
  exportId: string
): Effect.Effect<ExportStatus, ExportStatusError> =>
  Effect.gen(function*() {
    const status = nextExportStatus(exportId)
    yield* Console.log(`export ${exportId}: ${status.state}`)
    return status
  })

const pollUntilReadyOrFailed = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<ExportStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "running")
)

const program = Effect.gen(function*() {
  const finalStatus = yield* checkExportStatus("export-123").pipe(
    Effect.repeat(pollUntilReadyOrFailed)
  )
  yield* Console.log(`final export status: ${finalStatus.state}`)
})

Effect.runPromise(program)
// Output:
// export export-123: running
// export export-123: running
// export export-123: ready
// final export status: ready
```

The program succeeds with the first non-running status observed. That value may
be `"ready"` with a `downloadUrl`, or `"failed"` with a domain failure reason.

It fails with `ExportStatusError` only when a status check effect fails. A
successful response whose state is `"failed"` is still a successful observation
from the status endpoint.

##### Variants

Add a recurrence cap when the caller wants to stop after a bounded number of
status checks even if the export is still running, for example by combining the
status schedule with `Schedule.recurs(40)` using `Schedule.bothLeft`. The final
value can be `"ready"`, `"failed"`, or the last `"running"` status if the cap
stops the repeat first.

If the caller wants ready exports to succeed and failed exports to fail, keep
that decision after polling. The polling schedule should only decide whether to
observe again.

##### Notes and caveats

`Schedule.while` inspects successful status values. It does not see effect
failures from `checkExportStatus`.

The first status request is not delayed. `Schedule.spaced("3 seconds")` controls
the delay before later recurrences.

Keep export job creation outside this loop. This recipe repeats read-only status
checks, not the operation that starts the export.

If a capped polling schedule returns a final `"running"` status, the export may
still complete later. Decide separately whether to surface that as "still
pending", enqueue a follow-up check, or escalate to a timeout policy from the
next chapter.

#### 12.4 Poll cloud provisioning until ready

Use polling when a cloud resource has been accepted for creation but is not
usable yet.

##### Problem

After a create request returns a resource id for a database, bucket, cluster,
VM, or service account, the provider exposes a read-only status endpoint.
Successful responses can say that provisioning is still `"pending"` or
`"creating"`, that the resource is `"ready"`, or that provisioning reached a
domain failure such as `"provisioning_failed"`.

Those statuses are part of the cloud resource domain. They are not the same as
effect failures. The status-check effect should fail only when the status could
not be requested, authenticated, parsed, or decoded.

##### When to use it

Use this when the status endpoint returns ordinary domain states and the caller
needs the final observed provisioning state.

This is a good fit for workflows where the resource id is already known, polling
is read-only, and `"ready"` and `"provisioning_failed"` are both terminal
answers from the provider.

##### When not to use it

Do not use this to repeat the create request. Provisioning APIs often require
idempotency keys or provider-specific conflict handling, and that belongs around
the submit step, not the polling loop.

Do not use this to retry a failing status endpoint by itself. With
`Effect.repeat`, a failure from the status effect stops the repeat immediately.
If transport failures should be retried, apply retry policy inside the status
check or around it before the repeat.

Do not turn a domain status like `"provisioning_failed"` into an effect failure
inside the polling schedule. Poll until the terminal status is observed, then
decide how the caller should handle that final successful value.

##### Schedule shape

Poll on a spaced schedule, preserve the latest successful status as the
schedule output, and continue only while the resource is still provisioning.

`Schedule.spaced("5 seconds")` controls the delay before each recurrence.
`Schedule.satisfiesInputType<ProvisioningStatus>()` constrains the timing
schedule before the predicate reads `metadata.input`. `Schedule.passthrough`
keeps the final observed status as the result of `Effect.repeat`.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type ProvisioningStatus =
  | { readonly state: "pending"; readonly resourceId: string }
  | { readonly state: "creating"; readonly resourceId: string }
  | { readonly state: "configuring"; readonly resourceId: string }
  | { readonly state: "ready"; readonly resourceId: string; readonly endpoint: string }
  | { readonly state: "provisioning_failed"; readonly resourceId: string; readonly reason: string }

type StatusCheckError = {
  readonly _tag: "StatusCheckError"
  readonly message: string
}

const isProvisioning = (status: ProvisioningStatus): boolean =>
  status.state === "pending" ||
  status.state === "creating" ||
  status.state === "configuring"

let step = 0

const nextProvisioningStatus = (resourceId: string): ProvisioningStatus => {
  step += 1
  switch (step) {
    case 1:
      return { state: "pending", resourceId }
    case 2:
      return { state: "creating", resourceId }
    default:
      return {
        state: "ready",
        resourceId,
        endpoint: "https://db.example.com"
      }
  }
}

const describeResource = (
  resourceId: string
): Effect.Effect<ProvisioningStatus, StatusCheckError> =>
  Effect.gen(function*() {
    const status = nextProvisioningStatus(resourceId)
    yield* Console.log(`resource ${resourceId}: ${status.state}`)
    return status
  })

const pollUntilReadyOrFailed = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<ProvisioningStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => isProvisioning(input))
)

const program = Effect.gen(function*() {
  const finalStatus = yield* describeResource("db-123").pipe(
    Effect.repeat(pollUntilReadyOrFailed)
  )
  yield* Console.log(`final provisioning status: ${finalStatus.state}`)
})

Effect.runPromise(program)
// Output:
// resource db-123: pending
// resource db-123: creating
// resource db-123: ready
// final provisioning status: ready
```

The program performs the first status check immediately. If the first
successful response is `"ready"` or `"provisioning_failed"`, the schedule stops
without another request. If the resource is still provisioning, the schedule
waits before checking again.

The returned effect succeeds with the final `ProvisioningStatus`. It fails with
`StatusCheckError` only when `describeResource` fails.

##### Variants

Add a recurrence cap when the caller wants to stop after a bounded number of
successful observations, for example by combining the status schedule with
`Schedule.recurs(40)` using `Schedule.bothLeft`. The returned value may be
terminal, or it may be the last non-terminal status observed when the cap
stopped the repeat.

After polling, map the final successful status into the shape your application
needs. For example, a caller may return the ready endpoint, surface a
provisioning failure as a domain error, or store the last non-terminal status
for an operator to inspect.

##### Notes and caveats

`Schedule.while` sees successful status values. It does not inspect or recover
effect failures from the status request.

Keep provisioning statuses distinct from request failures. `"ready"` and
`"provisioning_failed"` are terminal domain states; `StatusCheckError` means the
program could not observe the state.

The first status check is not delayed. The schedule controls only recurrences
after the first successful check.

Choose an interval that respects the provider's rate limits and expected
provisioning latency. Deadlines, startup budgets, and fallback behavior are
separate recipes.

#### 12.5 Poll until status becomes `Completed`

Polling for a desired output is not the same as polling until any terminal state
appears. The schedule decides when to ask again; the code after polling decides
whether the final status is the desired one.

##### Problem

A status endpoint may successfully return `"Queued"`, `"Running"`,
`"Completed"`, `"Failed"`, or `"Canceled"`. Only `"Completed"` is the result
the caller wants.

`"Failed"` and `"Canceled"` are terminal domain states: successful status
responses that mean the job will not complete. They should stop polling, but
they should not be treated as completed work. A failed status request is a
separate effect failure.

##### When to use it

Use this for job APIs where in-progress statuses mean "poll again", one status
means "return the completed result", and other terminal statuses must be
reported separately.

##### When not to use it

Do not retry transport, authorization, or decoding failures with this schedule.
With `Effect.repeat`, failures from the repeated effect stop the repeat unless
handled before repeating.

Do not continue while `status.state !== "Completed"` when the domain has other
terminal states. That would keep polling after a job has already failed or been
canceled.

Do not leave long-running jobs unbounded unless another owner controls the
fiber lifetime.

##### Schedule shape

Use `Schedule.spaced` for the delay, `Schedule.passthrough` to keep the latest
status, and `Schedule.while` to continue only while the status is still in
progress. After `Effect.repeat` returns, map `"Completed"` to success and map
other terminal statuses to domain errors.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type JobStatus =
  | { readonly state: "Queued" }
  | { readonly state: "Running"; readonly percent: number }
  | { readonly state: "Completed"; readonly resultId: string }
  | { readonly state: "Failed"; readonly reason: string }
  | { readonly state: "Canceled" }

type CompletedStatus = Extract<JobStatus, { readonly state: "Completed" }>

type CompletionError =
  | { readonly _tag: "JobFailed"; readonly reason: string }
  | { readonly _tag: "JobCanceled" }
  | { readonly _tag: "JobDidNotCompleteInTime"; readonly lastState: JobStatus["state"] }

const scriptedStatuses: ReadonlyArray<JobStatus> = [
  { state: "Queued" },
  { state: "Running", percent: 40 },
  { state: "Completed", resultId: "result-123" }
]

let readIndex = 0

const isInProgress = (status: JobStatus): boolean => status.state === "Queued" || status.state === "Running"

const checkJobStatus = (jobId: string): Effect.Effect<JobStatus> =>
  Effect.sync(() => {
    const status = scriptedStatuses[
      Math.min(readIndex, scriptedStatuses.length - 1)
    ]!
    readIndex += 1
    return status
  }).pipe(
    Effect.tap((status) => Console.log(`[${jobId}] ${status.state}`))
  )

const pollWhileInProgress = Schedule.spaced("20 millis").pipe(
  Schedule.satisfiesInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => isInProgress(input)),
  Schedule.take(10)
)

const requireCompleted = (
  status: JobStatus
): Effect.Effect<CompletedStatus, CompletionError> => {
  switch (status.state) {
    case "Completed":
      return Effect.succeed(status)
    case "Failed":
      return Effect.fail({ _tag: "JobFailed", reason: status.reason })
    case "Canceled":
      return Effect.fail({ _tag: "JobCanceled" })
    case "Queued":
    case "Running":
      return Effect.fail({
        _tag: "JobDidNotCompleteInTime",
        lastState: status.state
      })
  }
}

const program = checkJobStatus("job-1").pipe(
  Effect.repeat(pollWhileInProgress),
  Effect.flatMap(requireCompleted),
  Effect.tap((status) => Console.log(`completed with ${status.resultId}`))
)

Effect.runPromise(program).then((status) => {
  console.log("result:", status)
})
// Output:
// [job-1] Queued
// [job-1] Running
// [job-1] Completed
// completed with result-123
// result: { state: 'Completed', resultId: 'result-123' }
```

The first check runs immediately. The schedule repeats only while the latest
successful status is `"Queued"` or `"Running"`. The final interpretation is
kept outside the schedule so `"Failed"` and `"Canceled"` remain visible domain
outcomes.

##### Variants

Remove `Schedule.take` when another lifetime or timeout bounds the polling
fiber. Keep an explicit branch for in-progress statuses if you add any schedule
that can stop before completion.

If failed or canceled jobs should be returned as values instead of failures,
keep the same polling schedule and change only the final interpreter.

##### Notes and caveats

`Schedule.while` sees successful status values only. It does not inspect
failures from the status-check effect.

The first status check is not delayed. Delays apply only before recurrences.

Use `Schedule.satisfiesInputType<T>()` before `Schedule.while` when a timing
schedule reads the latest successful status from `metadata.input`.

### 13. Poll for Resource State

#### 13.1 Poll until a resource exists

Model "not found yet" as a successful observation when absence is expected to
be temporary. The schedule can then repeat on that observation without
confusing it with transport or decoding failure.

##### Problem

A lookup for a newly created object, uploaded file, provisioned endpoint, or
generated artifact may succeed and report either "missing" or "found." The loop
should wait between missing observations and stop as soon as the resource is
found.

Keep real lookup failures separate. Authorization errors, malformed responses,
network failures, and invalid identifiers should not be silently turned into
"missing" unless the domain explicitly says so.

##### When to use it

Use this when absence is a normal temporary state and the caller wants to wait
until the resource becomes visible.

This fits APIs where a lookup, `HEAD` request, or metadata read can distinguish
"missing for now" from an actual failed request.

##### When not to use it

Do not use this for rich status workflows with states such as `"Queued"`,
`"Running"`, `"Failed"`, and `"Completed"`. Poll the status model and handle
each terminal state instead.

Do not leave the poll unbounded when the resource may never appear. Add a cap,
time budget, or owning fiber lifetime.

##### Schedule shape

Use `Schedule.spaced` for the delay, `Schedule.passthrough` to return the latest
lookup result, and `Schedule.while` to continue only while the lookup is
`Missing`.

If a bounded schedule stops first, the final observation can still be
`Missing`; interpret that case explicitly.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

interface Resource {
  readonly id: string
  readonly url: string
}

type ResourceLookup =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Found"; readonly resource: Resource }

type WaitForResourceError = {
  readonly _tag: "ResourceNotFoundInTime"
  readonly resourceId: string
}

const scriptedLookups: ReadonlyArray<ResourceLookup> = [
  { _tag: "Missing" },
  { _tag: "Missing" },
  { _tag: "Found", resource: { id: "file-1", url: "https://example.test/file-1" } }
]

let readIndex = 0

const lookupResource = (resourceId: string): Effect.Effect<ResourceLookup> =>
  Effect.sync(() => {
    const lookup = scriptedLookups[
      Math.min(readIndex, scriptedLookups.length - 1)
    ]!
    readIndex += 1
    return lookup
  }).pipe(
    Effect.tap((lookup) => Console.log(`[${resourceId}] ${lookup._tag}`))
  )

const pollUntilFound = Schedule.spaced("15 millis").pipe(
  Schedule.satisfiesInputType<ResourceLookup>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Missing"),
  Schedule.take(10)
)

const requireFound = (
  resourceId: string,
  lookup: ResourceLookup
): Effect.Effect<Resource, WaitForResourceError> =>
  lookup._tag === "Found"
    ? Effect.succeed(lookup.resource)
    : Effect.fail({ _tag: "ResourceNotFoundInTime", resourceId })

const program = lookupResource("file-1").pipe(
  Effect.repeat(pollUntilFound),
  Effect.flatMap((lookup) => requireFound("file-1", lookup)),
  Effect.tap((resource) => Console.log(`resource url: ${resource.url}`))
)

Effect.runPromise(program).then((resource) => {
  console.log("result:", resource)
})
// Output:
// [file-1] Missing
// [file-1] Missing
// [file-1] Found
// resource url: https://example.test/file-1
// result: { id: 'file-1', url: 'https://example.test/file-1' }
```

The first lookup runs immediately. Missing observations wait before the next
lookup. A found observation stops the repeat and is returned as the resource.

##### Variants

Add `Schedule.jittered` when many callers may wait for the same dependency and
aligned lookups would be noisy.

If the underlying API reports a temporary 404 as an error, translate only that
specific case into `Missing` before `Effect.repeat`. Leave unrelated failures in
the effect error channel or retry them with a separate retry policy.

##### Notes and caveats

`Effect.repeat` repeats after success. A failed lookup stops the repeat unless
the lookup effect handles that failure first.

The first lookup is not delayed by the schedule.

Model only genuinely temporary absence as `Missing`. A permanently invalid id
or an unauthorized caller should fail or return a separate domain result.

#### 13.2 Poll until a cache entry appears

A cache miss can be an ordinary successful observation. When another process is
expected to populate the value soon, repeat on misses and stop on the first
present entry.

##### Problem

A background warm-up fiber, write-through path, or external producer may fill a
cache after the caller starts looking. The polling loop should wait between
cache reads, stop at the first present entry, and keep cache backend failures
separate from normal misses.

##### When to use it

Use this when a missing cache entry is expected to be temporary and the caller
wants a short wait for population.

This fits asynchronous warm-up, write-through propagation to an in-process
cache, or a shared cache that another worker fills after a known trigger.

##### When not to use it

Do not use this as a general resource-creation workflow. The recipe assumes a
cache population path is already in motion.

Do not treat cache backend failures as misses. Network errors, serialization
errors, permission errors, and unavailable cache servers should remain failures
unless the domain deliberately models them as successful misses.

Do not poll indefinitely for keys that may never be written.

##### Schedule shape

Use `Schedule.spaced` for a small delay between cache reads,
`Schedule.passthrough` to keep the latest lookup, and `Schedule.while` to repeat
only while the lookup is `Missing`.

For bounded waits, handle a final `Missing` value explicitly.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

interface CacheEntry {
  readonly key: string
  readonly value: string
  readonly version: number
}

type CacheLookup =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Present"; readonly entry: CacheEntry }

type WaitForCacheEntryError = {
  readonly _tag: "CacheEntryUnavailable"
  readonly key: string
}

const scriptedLookups: ReadonlyArray<CacheLookup> = [
  { _tag: "Missing" },
  { _tag: "Missing" },
  { _tag: "Present", entry: { key: "user:1", value: "Ada", version: 3 } }
]

let readIndex = 0

const lookupCacheEntry = (key: string): Effect.Effect<CacheLookup> =>
  Effect.sync(() => {
    const lookup = scriptedLookups[
      Math.min(readIndex, scriptedLookups.length - 1)
    ]!
    readIndex += 1
    return lookup
  }).pipe(
    Effect.tap((lookup) => Console.log(`[${key}] ${lookup._tag}`))
  )

const pollUntilPresent = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<CacheLookup>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Missing"),
  Schedule.take(10)
)

const requirePresent = (
  key: string,
  lookup: CacheLookup
): Effect.Effect<CacheEntry, WaitForCacheEntryError> =>
  lookup._tag === "Present"
    ? Effect.succeed(lookup.entry)
    : Effect.fail({ _tag: "CacheEntryUnavailable", key })

const program = lookupCacheEntry("user:1").pipe(
  Effect.repeat(pollUntilPresent),
  Effect.flatMap((lookup) => requirePresent("user:1", lookup)),
  Effect.tap((entry) => Console.log(`cache value: ${entry.value} v${entry.version}`))
)

Effect.runPromise(program).then((entry) => {
  console.log("result:", entry)
})
// Output:
// [user:1] Missing
// [user:1] Missing
// [user:1] Present
// cache value: Ada v3
// result: { key: 'user:1', value: 'Ada', version: 3 }
```

The first cache lookup runs immediately. Misses wait before the next read. The
first present entry stops the repeat and becomes the result.

##### Variants

Add `Schedule.jittered` when many callers may wait for the same key and aligned
reads would create avoidable cache traffic.

Use a small recurrence cap for user-facing waits. A cache should not become a
hidden unbounded dependency in the request path.

If a cache API represents a miss as an error, recover only that miss into
`Missing` before repeating. Keep backend failures as failures.

##### Notes and caveats

`Schedule.while` sees successful lookup results only.

`Effect.repeat` repeats after success. A failed cache read stops the repeat
unless handled before repeating.

A miss should be temporary for this recipe. If no population path is active,
return a separate domain result or fail instead of polling as if the entry will
appear.

#### 13.3 Poll until replication catches up

Replication-aware polling should ask a narrow question: has the lagging view
observed at least the version the caller already knows exists?

##### Problem

After writing to a primary system, the caller may receive a version, watermark,
or cursor. A follower, read model, replica, or search index can lag behind that
position for a short time.

Poll the replicated view until its observed position reaches the required
position. Treat "behind" as a successful observation, not as a failed read.

##### When to use it

Use this when the caller has a concrete target position and the downstream view
can report a comparable observed position.

This fits event stream versions, projection watermarks, indexing sequence
numbers, and read models that expose the cursor they have processed.

##### When not to use it

Do not use this when the follower cannot report a comparable position. Polling
for "maybe visible now" is a different shape.

Do not hide failed replica reads. Timeouts, authorization errors, decode
failures, and unavailable read models should remain effect failures unless your
domain explicitly recovers them.

Do not compare opaque cursor strings lexicographically unless the producer
defines that order.

##### Schedule shape

Use `Schedule.spaced` for the read interval, `Schedule.passthrough` to keep the
latest observation, and `Schedule.while` to continue only while the observed
version is below the required version.

If you add a bound, handle the final behind observation as "did not catch up in
time" instead of returning stale data.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

interface ReplicaObservation {
  readonly replica: "read-model"
  readonly observedVersion: number
}

type WaitForReplicaError = {
  readonly _tag: "ReplicaDidNotCatchUp"
  readonly requiredVersion: number
  readonly observedVersion: number
}

const scriptedObservations: ReadonlyArray<ReplicaObservation> = [
  { replica: "read-model", observedVersion: 41 },
  { replica: "read-model", observedVersion: 43 },
  { replica: "read-model", observedVersion: 45 }
]

let readIndex = 0

const hasCaughtUp = (
  observation: ReplicaObservation,
  requiredVersion: number
): boolean => observation.observedVersion >= requiredVersion

const readReplicaWatermark = (
  streamName: string
): Effect.Effect<ReplicaObservation> =>
  Effect.sync(() => {
    const observation = scriptedObservations[
      Math.min(readIndex, scriptedObservations.length - 1)
    ]!
    readIndex += 1
    return observation
  }).pipe(
    Effect.tap((observation) =>
      Console.log(
        `[${streamName}] ${observation.replica} at ${observation.observedVersion}`
      )
    )
  )

const pollUntilVersion = (requiredVersion: number) =>
  Schedule.spaced("10 millis").pipe(
    Schedule.satisfiesInputType<ReplicaObservation>(),
    Schedule.passthrough,
    Schedule.while(({ input }) => !hasCaughtUp(input, requiredVersion)),
    Schedule.take(10)
  )

const requireCaughtUp = (
  requiredVersion: number,
  observation: ReplicaObservation
): Effect.Effect<ReplicaObservation, WaitForReplicaError> =>
  hasCaughtUp(observation, requiredVersion)
    ? Effect.succeed(observation)
    : Effect.fail({
      _tag: "ReplicaDidNotCatchUp",
      requiredVersion,
      observedVersion: observation.observedVersion
    })

const requiredVersion = 45

const program = readReplicaWatermark("orders").pipe(
  Effect.repeat(pollUntilVersion(requiredVersion)),
  Effect.flatMap((observation) => requireCaughtUp(requiredVersion, observation)),
  Effect.tap((observation) => Console.log(`caught up at ${observation.observedVersion}`))
)

Effect.runPromise(program).then((observation) => {
  console.log("result:", observation)
})
// Output:
// [orders] read-model at 41
// [orders] read-model at 43
// [orders] read-model at 45
// caught up at 45
// result: { replica: 'read-model', observedVersion: 45 }
```

The first read runs immediately. Behind observations wait before the next read.
Once the replica reports the required version or later, the schedule stops.

##### Variants

Add `Schedule.jittered` when many clients may wait on the same replica and
aligned read bursts would add load.

For opaque cursors, keep the same schedule shape but replace the numeric
comparison with a domain comparison that knows whether the observed cursor has
reached the required cursor.

Use a target position from the write path or another authoritative source. A
guessed target can make polling report success for the wrong point in history.

##### Notes and caveats

`Schedule.while` sees successful replica observations only. It does not inspect
read failures.

`Effect.repeat` repeats successes. Retry transient failed reads separately when
that is appropriate.

The first read is not delayed by the schedule.

#### 13.4 Poll until eventual consistency settles

Eventually consistent reads can succeed while still showing an old view. Treat
those stale reads as observations and poll until a concrete condition says the
view has caught up.

##### Problem

After a write, the caller may know the expected revision, version, cursor, or
checksum. The read side may lag for a short time, so the first few reads can be
valid but stale.

The polling loop should stop when the expected state is visible, keep stale
observations separate from read failures, and avoid polling forever after the
view has advanced far enough to prove the expected data is absent.

##### When to use it

Use this when stale reads are normal temporary observations and the caller has a
specific condition for "settled."

This fits command acceptance followed by asynchronous projection updates, event
publication followed by a read model, or search indexing that exposes enough
state to verify the write has appeared.

##### When not to use it

Do not use polling to claim strict read-after-write consistency. It can wait for
an eventually consistent view; it does not make the dependency strongly
consistent.

Do not turn read failures into "not settled yet" unless the domain deliberately
models them that way.

Do not keep polling after the view revision has passed the expected revision but
the expected record is still missing. That is a domain inconsistency, not a
stale read.

##### Schedule shape

Represent each successful read as `Behind`, `Settled`, or `Inconsistent`. Use
`Schedule.spaced`, `Schedule.passthrough`, and `Schedule.while` to repeat only
while the latest observation is `Behind`.

After polling, interpret `Settled` as success, `Inconsistent` as a domain
failure, and a bounded final `Behind` as "not settled in time."

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

interface OrderSummary {
  readonly orderId: string
  readonly revision: number
  readonly totalCents: number
}

interface AccountOrdersView {
  readonly accountId: string
  readonly revision: number
  readonly orders: ReadonlyArray<OrderSummary>
}

type ProjectionObservation =
  | {
    readonly _tag: "Behind"
    readonly view: AccountOrdersView
    readonly expectedRevision: number
  }
  | {
    readonly _tag: "Settled"
    readonly view: AccountOrdersView
    readonly order: OrderSummary
  }
  | {
    readonly _tag: "Inconsistent"
    readonly view: AccountOrdersView
    readonly reason: string
  }

type ProjectionWaitError =
  | {
    readonly _tag: "ProjectionDidNotSettleInTime"
    readonly expectedRevision: number
    readonly observedRevision: number
  }
  | {
    readonly _tag: "ProjectionDidNotContainExpectedOrder"
    readonly reason: string
  }

const scriptedViews: ReadonlyArray<AccountOrdersView> = [
  { accountId: "account-1", revision: 8, orders: [] },
  { accountId: "account-1", revision: 9, orders: [] },
  {
    accountId: "account-1",
    revision: 10,
    orders: [{ orderId: "order-7", revision: 10, totalCents: 2599 }]
  }
]

let readIndex = 0

const findOrder = (
  view: AccountOrdersView,
  orderId: string
): OrderSummary | undefined => view.orders.find((order) => order.orderId === orderId)

const readAccountOrders = (
  accountId: string
): Effect.Effect<AccountOrdersView> =>
  Effect.sync(() => {
    const view = scriptedViews[
      Math.min(readIndex, scriptedViews.length - 1)
    ]!
    readIndex += 1
    return view
  }).pipe(
    Effect.tap((view) => Console.log(`[${accountId}] read revision ${view.revision}`))
  )

const observeAccountOrders = (
  accountId: string,
  expectedRevision: number,
  orderId: string
): Effect.Effect<ProjectionObservation> =>
  readAccountOrders(accountId).pipe(
    Effect.map((view): ProjectionObservation => {
      const order = findOrder(view, orderId)

      if (order !== undefined && view.revision >= expectedRevision) {
        return { _tag: "Settled", view, order }
      }

      if (view.revision < expectedRevision) {
        return { _tag: "Behind", view, expectedRevision }
      }

      return {
        _tag: "Inconsistent",
        view,
        reason: "Projection reached the expected revision without the order"
      }
    }),
    Effect.tap((observation) => Console.log(`observation: ${observation._tag}`))
  )

const pollUntilProjectionSettles = Schedule.spaced("15 millis").pipe(
  Schedule.satisfiesInputType<ProjectionObservation>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Behind"),
  Schedule.take(10)
)

const requireSettled = (
  expectedRevision: number,
  observation: ProjectionObservation
): Effect.Effect<OrderSummary, ProjectionWaitError> => {
  switch (observation._tag) {
    case "Settled":
      return Effect.succeed(observation.order)
    case "Inconsistent":
      return Effect.fail({
        _tag: "ProjectionDidNotContainExpectedOrder",
        reason: observation.reason
      })
    case "Behind":
      return Effect.fail({
        _tag: "ProjectionDidNotSettleInTime",
        expectedRevision,
        observedRevision: observation.view.revision
      })
  }
}

const expectedRevision = 10

const program = observeAccountOrders(
  "account-1",
  expectedRevision,
  "order-7"
).pipe(
  Effect.repeat(pollUntilProjectionSettles),
  Effect.flatMap((observation) => requireSettled(expectedRevision, observation)),
  Effect.tap((order) => Console.log(`settled order total: ${order.totalCents}`))
)

Effect.runPromise(program).then((order) => {
  console.log("result:", order)
})
// Output:
// [account-1] read revision 8
// observation: Behind
// [account-1] read revision 9
// observation: Behind
// [account-1] read revision 10
// observation: Settled
// settled order total: 2599
// result: { orderId: 'order-7', revision: 10, totalCents: 2599 }
```

The first read runs immediately. While the projection is behind the expected
revision, later reads wait for the schedule delay. Once the expected order is
visible at the expected revision or later, polling stops.

##### Variants

Add `Schedule.jittered` when many callers may poll the same projection and
aligned reads would add load.

If you do not have an expected revision, use a stricter stability signal such
as the same projection version or checksum appearing in consecutive reads. That
is weaker than checking a known target, so keep the wait bounded.

If the view advances beyond the expected revision without the expected data,
return a domain inconsistency instead of continuing to poll.

##### Notes and caveats

`Schedule.while` sees successful observations only. It does not inspect read
failures.

`Effect.repeat` repeats successes. Retry transient failed reads separately when
that is appropriate.

Prefer a concrete expected revision, version, or checksum over vague "looks
settled" checks. The schedule should not encode replication internals.

### 14. Poll with Timeouts

#### 14.1 Poll every second for up to 30 seconds

Use this for a short status poll: run the check once immediately, then keep
checking roughly once per second while the last successful status is still
pending. The schedule controls recurrence; ordinary Effect code interprets the
final status.

##### Problem

The status endpoint can succeed with `"pending"`, `"ready"`, or `"failed"`.
Only `"pending"` should request another poll, and polling should stop once the
30-second recurrence budget is exhausted.

The budget is not a hard timeout for a request already in flight. It is checked
between successful status observations.

##### When to use it

Use it for readiness checks, job-status endpoints, and eventually consistent
projections where "not ready yet" is a successful domain value.

##### When not to use it

Do not use it to retry failed status requests. `Effect.repeat` stops when the
checked effect fails.

Do not rely on `Schedule.during("30 seconds")` to interrupt slow requests. Use
`Effect.timeout` on the status check, or around the whole workflow, when the
caller needs interruption semantics.

##### Schedule shape

Use `Schedule.spaced("1 second")` for the cadence, `Schedule.while` for the
pending-status predicate, and `Schedule.during("30 seconds")` for the elapsed
recurrence budget.

Beginner note: Schedule output — `Schedule.passthrough` is intentional here:
the repeat result is the last status observed by the schedule.

##### Example

```ts
import { Clock, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type Status =
  | { readonly state: "pending" }
  | { readonly state: "ready"; readonly resourceId: string }
  | { readonly state: "failed"; readonly reason: string }

const script: ReadonlyArray<Status> = [
  { state: "pending" },
  { state: "pending" },
  { state: "ready", resourceId: "resource-123" }
]

const pollEverySecondForUpTo30Seconds = Schedule.spaced("1 second").pipe(
  Schedule.satisfiesInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "pending"),
  Schedule.bothLeft(
    Schedule.during("30 seconds").pipe(
      Schedule.satisfiesInputType<Status>()
    )
  )
)

let checks = 0

const checkStatus = Effect.gen(function*() {
  const now = yield* Clock.currentTimeMillis
  const status = script[Math.min(checks, script.length - 1)]!
  checks += 1
  console.log(`t+${now}ms check ${checks}: ${status.state}`)
  return status
})

const program = Effect.gen(function*() {
  const fiber = yield* checkStatus.pipe(
    Effect.repeat(pollEverySecondForUpTo30Seconds),
    Effect.forkDetach
  )

  yield* TestClock.adjust("30 seconds")

  const finalStatus = yield* Fiber.join(fiber)
  console.log("final:", finalStatus)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

The example uses `TestClock` so it can run in `scratchpad/repro.ts` without
waiting for real seconds. The policy itself still uses a one-second interval and
a 30-second recurrence budget.

##### Variants

Apply `Effect.timeout("2 seconds")` to `checkStatus` when each individual
request needs its own deadline. That timeout can interrupt the request; the
schedule still only decides whether to poll again after a successful response.

Use `Schedule.fixed("1 second")` instead of `Schedule.spaced("1 second")` when
polls should target wall-clock boundaries rather than waiting one second after
each completed check.

##### Notes and caveats

The first check is immediate. `Schedule.during` is approximate for the whole
workflow because it is consulted between successful checks. `Schedule.while`
sees successful status values only, so transport and decoding failures remain in
the effect failure channel.

#### 14.2 Give up when the operation is clearly too slow

Use this when continuing to poll is no longer useful after a practical elapsed
budget. The operation may still finish later, but this caller should stop
waiting and make that outcome explicit.

##### Problem

A status check can keep succeeding with `"pending"`. The schedule should stop
polling after a budget even when no terminal status has appeared, and it should
still stop earlier for `"ready"` or `"failed"`.

##### When to use it

Use it when slowness is a domain or operational outcome, not a transport
failure. This fits user-facing waits, orchestration steps, readiness checks, and
integrations where continued polling would waste capacity.

##### When not to use it

Do not use it as a hard interruption timeout. `Schedule.during` is evaluated
between successful status checks; it does not cancel a status check already in
flight.

Do not collapse a domain `"failed"` status and a slow `"pending"` status into
the same case unless the caller truly handles them the same way. They usually
mean different things operationally.

##### Schedule shape

Use a spaced cadence, preserve the latest successful status with
`Schedule.passthrough`, continue only while that status is `"pending"`, and
combine the policy with `Schedule.during` to cap the recurrence window.

##### Example

```ts
import { Clock, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type OperationStatus =
  | { readonly state: "pending"; readonly operationId: string }
  | { readonly state: "ready"; readonly operationId: string; readonly resourceId: string }
  | { readonly state: "failed"; readonly operationId: string; readonly reason: string }

const giveUpWhenTooSlow = Schedule.spaced("2 seconds").pipe(
  Schedule.satisfiesInputType<OperationStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "pending"),
  Schedule.bothLeft(
    Schedule.during("8 seconds").pipe(
      Schedule.satisfiesInputType<OperationStatus>()
    )
  )
)

let checks = 0

const checkOperationStatus = Effect.gen(function*() {
  const now = yield* Clock.currentTimeMillis
  checks += 1

  const status: OperationStatus = {
    state: "pending",
    operationId: "operation-1"
  }

  console.log(`t+${now}ms check ${checks}: ${status.state}`)
  return status
})

const program = Effect.gen(function*() {
  const fiber = yield* checkOperationStatus.pipe(
    Effect.repeat(giveUpWhenTooSlow),
    Effect.forkDetach
  )

  yield* TestClock.adjust("12 seconds")

  const finalStatus = yield* Fiber.join(fiber)
  console.log("final:", finalStatus)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

The final status is still `"pending"`, which is the signal that the schedule
stopped because the operation was too slow for this caller.

##### Variants

If each check needs its own deadline, apply `Effect.timeout("3 seconds")` to the
checked effect. That can interrupt an in-flight check; the schedule cannot.

If the caller needs a typed timeout error, inspect the final status after
`Effect.repeat` and map final `"pending"` to a domain error. Section 17.5 shows
that shape.

Use `Schedule.fixed("2 seconds")` instead of `Schedule.spaced("2 seconds")`
when the polling loop should target fixed wall-clock boundaries rather than
waiting two seconds after each successful check completes.

##### Notes and caveats

The first check is immediate. The duration budget is approximate for the whole
workflow because it is checked between successful runs. Failed status-check
effects do not become schedule inputs.

#### 14.3 Distinguish “still running” from “failed permanently”

Use this when a status endpoint reports several successful domain states, but
only some of them mean work is still in progress. The schedule should continue
for in-progress states and stop for terminal states, including domain failures.

##### Problem

`"queued"` and `"running"` should poll again. `"succeeded"`, `"failed"`, and
`"canceled"` should stop. A status value of `"failed"` is different from a
failed status request: the request succeeded and reported a terminal domain
outcome.

##### Why this comparison matters

`Effect.repeat` repeats after successful effects. With polling, the status
check can succeed even when the remote job reports permanent failure. That
successful status becomes the schedule input, so the repeat predicate must be
about domain state, not request success.

If `"failed"` is treated like `"running"`, the caller keeps polling a job that
is already finished. If `"running"` is treated like an error, the caller stops
before the workflow has had a chance to complete.

Keep the repeat predicate narrow: continue only for statuses that are truly
in progress. After the repeat stops, interpret the final observed status.

##### Schedule shape

Classify in-progress statuses with a predicate such as `isStillRunning`, use it
from `Schedule.while`, and keep the final `JobStatus` with
`Schedule.passthrough`.

##### Example

```ts
import { Clock, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type JobStatus =
  | { readonly state: "queued"; readonly jobId: string }
  | { readonly state: "running"; readonly jobId: string; readonly progress: number }
  | { readonly state: "succeeded"; readonly jobId: string; readonly resultId: string }
  | { readonly state: "failed"; readonly jobId: string; readonly reason: string }
  | { readonly state: "canceled"; readonly jobId: string }

const isStillRunning = (status: JobStatus): boolean => status.state === "queued" || status.state === "running"

const pollWhileStillRunning = Schedule.spaced("2 seconds").pipe(
  Schedule.satisfiesInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => isStillRunning(input)),
  Schedule.bothLeft(
    Schedule.during("1 minute").pipe(Schedule.satisfiesInputType<JobStatus>())
  )
)

type PollResult =
  | { readonly _tag: "Completed"; readonly resultId: string }
  | { readonly _tag: "FailedPermanently"; readonly reason: string }
  | { readonly _tag: "Canceled" }
  | { readonly _tag: "StillRunning"; readonly status: Extract<JobStatus, { readonly state: "queued" | "running" }> }

const interpretFinalStatus = (status: JobStatus): PollResult => {
  switch (status.state) {
    case "succeeded":
      return { _tag: "Completed", resultId: status.resultId }
    case "failed":
      return { _tag: "FailedPermanently", reason: status.reason }
    case "canceled":
      return { _tag: "Canceled" }
    case "queued":
    case "running":
      return { _tag: "StillRunning", status }
  }
}

const script: ReadonlyArray<JobStatus> = [
  { state: "queued", jobId: "job-1" },
  { state: "running", jobId: "job-1", progress: 40 },
  { state: "failed", jobId: "job-1", reason: "validation failed" }
]

let checks = 0

const checkJobStatus = Effect.gen(function*() {
  const now = yield* Clock.currentTimeMillis
  const status = script[Math.min(checks, script.length - 1)]!
  checks += 1
  console.log(`t+${now}ms check ${checks}: ${status.state}`)
  return status
})

const program = Effect.gen(function*() {
  const fiber = yield* checkJobStatus.pipe(
    Effect.repeat(pollWhileStillRunning),
    Effect.map(interpretFinalStatus),
    Effect.forkDetach
  )

  yield* TestClock.adjust("1 minute")

  const result = yield* Fiber.join(fiber)
  console.log("result:", result)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

The final `"failed"` status stops polling because it is not still running. The
interpreter then maps it to a domain result.

##### Tradeoffs

Keeping terminal domain failures as successful statuses makes the repeat logic
clear: the schedule stops because the status is no longer in progress. The
caller can then decide whether `"failed"` should become a typed failure, a
return value, a log entry, or a user-facing message.

Mapping permanent domain failures into the effect failure channel before
`Effect.repeat` can be useful when the rest of the program already models them
as failures. The cost is that the schedule no longer sees those statuses. The
repeat stops because the effect failed, not because `Schedule.while` classified
the status as terminal.

For polling APIs, successful status values usually drive the schedule, while
transport, authorization, and decoding problems stay in the effect failure
channel.

##### Recommended default

Model ordinary workflow states as successful values. Use a predicate such as
`isStillRunning` for `Schedule.while`, and make that predicate return `true`
only for states that should cause another poll.

After `Effect.repeat` returns, interpret the final observed status. Treat a
permanent failed terminal status as a domain outcome at that boundary, not as a
reason to keep polling.

##### Notes and caveats

`Schedule.while` sees successful status values only. A schedule-side duration
limits recurrences but does not interpret the final status or interrupt an
in-flight status check. Keep the in-progress predicate explicit; a catch-all
such as `status.state !== "succeeded"` treats permanent failures as work that
is still running.

#### 14.4 Return a timeout error gracefully

Use this when a bounded polling loop should return a caller-friendly timeout
instead of exposing a final non-terminal status. The schedule stops recurrence;
Effect code maps the final status into the API contract.

##### Problem

The loop should stop when a terminal status is observed and also when its
schedule-side budget is exhausted. If the budget ends while the last observed
status is still non-terminal, return a domain timeout error instead of exposing
a raw `"pending"` value.

`Schedule.during` does not fail the effect. It only stops allowing future
recurrences, so the timeout error must be produced after `Effect.repeat`
returns.

Beginner note: Bounds — a schedule-side budget decides when to stop polling. It
does not automatically create a timeout error or interrupt an in-flight poll.

##### When to use it

Use it when `"pending"` is normal while polling is open, but a final
`"pending"` means the caller ran out of budget. This is common in job polling,
exports, provisioning, payment settlement, and readiness checks.

##### When not to use it

Do not use it to interrupt an in-flight status check. Add `Effect.timeout` to
the checked effect or to the whole workflow when interruption is required.

Sometimes `"pending"` at the end is still useful data. In that case, keep the
`Effect.repeat` result as the final observed status and let the caller decide
what to do with it.

Do not map every final status to the same timeout error. A terminal `"failed"`
status and an exhausted polling budget usually mean different things.

##### Schedule shape

Keep the latest successful status as the schedule output with
`Schedule.passthrough`, continue only while it is `"pending"`, and combine the
policy with `Schedule.during("30 seconds")`. After `Effect.repeat`, map a final
`"pending"` status to your timeout error.

##### Example

```ts
import { Clock, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type JobStatus =
  | { readonly state: "pending"; readonly jobId: string }
  | { readonly state: "done"; readonly jobId: string; readonly resultId: string }
  | { readonly state: "failed"; readonly jobId: string; readonly reason: string }

type JobTimedOut = {
  readonly _tag: "JobTimedOut"
  readonly jobId: string
}

type JobFailed = {
  readonly _tag: "JobFailed"
  readonly jobId: string
  readonly reason: string
}

const pollForUpTo30Seconds = Schedule.spaced("1 second").pipe(
  Schedule.satisfiesInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "pending"),
  Schedule.bothLeft(
    Schedule.during("30 seconds").pipe(
      Schedule.satisfiesInputType<JobStatus>()
    )
  )
)

let checks = 0

const checkJobStatus = Effect.gen(function*() {
  const now = yield* Clock.currentTimeMillis
  checks += 1

  const status: JobStatus = {
    state: "pending",
    jobId: "job-1"
  }

  if (checks <= 3 || now >= 30000) {
    console.log(`t+${now}ms check ${checks}: ${status.state}`)
  } else if (checks === 4) {
    console.log("additional pending checks omitted")
  }

  return status
})

const pollUntilDoneOrTimeout = checkJobStatus.pipe(
  Effect.repeat(pollForUpTo30Seconds),
  Effect.flatMap((status): Effect.Effect<
    Extract<JobStatus, { readonly state: "done" }>,
    JobFailed | JobTimedOut
  > => {
    switch (status.state) {
      case "done":
        return Effect.succeed(status)
      case "failed":
        return Effect.fail(
          {
            _tag: "JobFailed",
            jobId: status.jobId,
            reason: status.reason
          } satisfies JobFailed
        )
      case "pending":
        return Effect.fail(
          {
            _tag: "JobTimedOut",
            jobId: status.jobId
          } satisfies JobTimedOut
        )
    }
  })
)

const program = Effect.gen(function*() {
  const fiber = yield* pollUntilDoneOrTimeout.pipe(
    Effect.match({
      onFailure: (error) => ({ _tag: "Failed" as const, error }),
      onSuccess: (status) => ({ _tag: "Succeeded" as const, status })
    }),
    Effect.forkDetach
  )

  yield* TestClock.adjust("35 seconds")
  const result = yield* Fiber.join(fiber)
  console.log("result:", result)
}).pipe(Effect.scoped, Effect.provide(TestClock.layer()))

Effect.runPromise(program)
```

The logged result contains `JobTimedOut`. That error is produced by the final
`Effect.flatMap`, not by the schedule.

##### Variants

If timeout is an expected business value rather than a failure-channel error,
return a result union from the final mapping step, for example
`{ _tag: "TimedOut", lastStatus }`.

For strict request deadlines, add a timeout to the status-check effect itself.
That is separate from the schedule-side recurrence budget.

##### Notes and caveats

`Effect.repeat` returns the schedule output. With `Schedule.passthrough`, that
output is the final successful status observed by the schedule.

`Schedule.during("30 seconds")` does not throw, fail, or produce a timeout
error. It stops allowing future recurrences once the elapsed schedule budget is
used up. The budget is checked between successful status checks and does not
interrupt a check that is already running.

### 15. Adaptive and Fleet-Safe Polling

#### 15.1 Fast polling during the first few seconds

Use this for workflows that often settle quickly. The schedule gives the caller
a short responsive burst without making fast polling the steady-state policy.

##### Problem

Early completion is common, so waiting through a large interval would feel
unnecessarily slow. The fast cadence should still be bounded, because a
permanent tight loop creates load without adding much value.

##### When to use it

Use this when early completion is common and a fresh result is valuable enough
to justify a short burst of extra requests.

This fits status checks that often move from `"pending"` to `"ready"` shortly
after submission.

##### When not to use it

Do not use this as an unbounded polling loop. Fast polling is most useful as an
initial burst, not as the steady-state cadence for long-running work.

Do not use this to retry a failing status check by itself. With
`Effect.repeat`, failed effects stop the repeat. The schedule only sees
successful status values.

Do not use a very small interval when each status check is expensive, rate
limited, or likely to queue behind earlier requests.

##### Schedule shape

Use `Schedule.spaced("250 millis")` for the burst cadence, `Schedule.take(12)`
to cap the burst, `Schedule.while` to continue only for pending statuses, and
`Schedule.passthrough` to return the latest status.

##### Example

```ts
import { Clock, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type Status =
  | { readonly state: "pending" }
  | { readonly state: "ready"; readonly resourceId: string }
  | { readonly state: "failed"; readonly reason: string }

const fastInitialPolling = Schedule.spaced("250 millis").pipe(
  Schedule.take(12),
  Schedule.satisfiesInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "pending")
)

const script: ReadonlyArray<Status> = [
  { state: "pending" },
  { state: "pending" },
  { state: "ready", resourceId: "result-1" }
]

let checks = 0

const checkStatus = Effect.gen(function*() {
  const now = yield* Clock.currentTimeMillis
  const status = script[Math.min(checks, script.length - 1)]!
  checks += 1
  console.log(`t+${now}ms check ${checks}: ${status.state}`)
  return status
})

const program = Effect.gen(function*() {
  const fiber = yield* checkStatus.pipe(
    Effect.repeat(fastInitialPolling),
    Effect.forkDetach
  )

  yield* TestClock.adjust("3 seconds")

  const finalStatus = yield* Fiber.join(fiber)
  console.log("final:", finalStatus)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

The first check is immediate. The 250-millisecond delay applies only after a
successful pending observation.

##### Variants

Use a smaller recurrence cap when the first few checks usually settle the
workflow. For example, five recurrences at 200 milliseconds keeps the aggressive
window close to one second after the immediate first check.

Use a larger interval when requests are heavier or the remote service publishes
status updates less frequently. A 500 millisecond burst can still feel
responsive without creating as much request pressure.

Use `Schedule.fixed("250 millis")` instead of `Schedule.spaced("250 millis")`
only when you want to target fixed wall-clock boundaries. For most status
endpoints, `Schedule.spaced` is simpler because it waits after each completed
check.

##### Notes and caveats

`Schedule.take(12)` limits recurrences after the initial check. It is not a
workflow timeout and it does not interrupt an in-flight request. `Schedule.while`
sees successful status values only.

#### 15.2 Slow polling after initial responsiveness matters less

Use this for the slower phase after the initial responsive window has passed.
The caller still observes progress, but the status endpoint is no longer polled
at the early high-frequency cadence.

##### Problem

After the first few seconds, polling every few hundred milliseconds usually
creates load without improving the user experience. The policy should slow down
and still stop as soon as a terminal status appears.

##### When to use it

Use this when the first responsive phase has passed and the remaining work is
allowed to settle over tens of seconds or minutes.

This is a good fit for exports, media processing, provisioning, indexing,
settlement checks, and other workflows where early completion is nice, but
later completion does not need instant feedback.

##### When not to use it

Do not use this as the whole initial user-facing policy when the first few
seconds are important. The first status check still runs immediately, but the
slow interval controls subsequent recurrences.

Do not use this when an external system requires a minimum or maximum polling
contract that differs from your chosen interval.

Do not use this to retry a failing status endpoint by itself. With
`Effect.repeat`, failed effects stop the repeat. The schedule only sees
successful status values.

##### Schedule shape

Use `Schedule.spaced("30 seconds")` for the slower cadence,
`Schedule.passthrough` to keep the latest status as the result, and
`Schedule.while` to continue only while that status is still pending.

##### Example

```ts
import { Clock, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type Status =
  | { readonly state: "pending"; readonly progress: number }
  | { readonly state: "ready"; readonly resultId: string }
  | { readonly state: "failed"; readonly reason: string }

const isPending = (status: Status): boolean => status.state === "pending"

const slowPollingAfterInitialWindow = Schedule.spaced("30 seconds").pipe(
  Schedule.satisfiesInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => isPending(input))
)

const script: ReadonlyArray<Status> = [
  { state: "pending", progress: 70 },
  { state: "ready", resultId: "report-42" }
]

let checks = 0

const checkStatus = Effect.gen(function*() {
  const now = yield* Clock.currentTimeMillis
  const status = script[Math.min(checks, script.length - 1)]!
  checks += 1
  console.log(`t+${now}ms check ${checks}: ${status.state}`)
  return status
})

const program = Effect.gen(function*() {
  const fiber = yield* checkStatus.pipe(
    Effect.repeat(slowPollingAfterInitialWindow),
    Effect.forkDetach
  )

  yield* TestClock.adjust("30 seconds")

  const finalStatus = yield* Fiber.join(fiber)
  console.log("final:", finalStatus)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

##### Variants

Use a shorter interval, such as 10 or 15 seconds, when the user is still
watching the page and a small delay in completion feedback would be noticeable.

Use a longer interval, such as one or five minutes, when the workflow is mostly
background work and the status endpoint is expensive or rate limited.

Add jitter when many clients may enter the slow phase at roughly the same time.
The slower cadence reduces load, but it does not by itself prevent synchronized
polling.

Add a separate cap or elapsed-time budget when the caller needs a definite
answer instead of an open-ended slow wait.

##### Notes and caveats

The first check in this phase is immediate. `Schedule.spaced` waits after each
successful status check completes. `Schedule.while` sees successful status
values only; request failures should be retried or reported separately.

#### 15.3 Polling strategy for user-triggered workflows

Use this recipe for work started by a user action, such as generating a report,
submitting a review, importing a small file, refreshing derived data, or
starting an approval flow. Poll quickly while the user is likely watching, then
slow down if the workflow is still processing.

##### Problem

The first few seconds are important because the user is still watching. If the
workflow finishes quickly, the UI should notice quickly. If it does not finish
quickly, polling should slow down so the status endpoint is not kept under
unnecessary pressure.

##### When to use it

Use this when the workflow is user-triggered, visible to the caller, and often
settles shortly after submission.

This is a good fit for pages that can update from `"processing"` to `"ready"`
without requiring the user to refresh, while still tolerating a slower cadence
after the initial responsive window.

##### When not to use it

Do not use this as a general policy for long-running back-office jobs. Those
usually need wider intervals, operational budgets, and separate alerting or
handoff behavior.

Do not use this when the status endpoint itself is expensive enough that even a
short burst would compete with the workflow being observed.

Do not use this to retry failed status requests by itself. With
`Effect.repeat`, failed effects stop the repeat. The schedule sees successful
status values.

##### Schedule shape

Use `Schedule.andThen` to sequence a short responsive phase into a slower
follow-up phase. Put `Schedule.while` after the sequencing so terminal statuses
stop both phases, and use `Schedule.passthrough` to return the latest
`WorkflowStatus`.

##### Example

```ts
import { Clock, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type WorkflowStatus =
  | { readonly state: "processing"; readonly message: string }
  | { readonly state: "ready"; readonly resultUrl: string }
  | { readonly state: "failed"; readonly reason: string }

const userTriggeredPolling = Schedule.spaced("500 millis").pipe(
  Schedule.take(4),
  Schedule.andThen(Schedule.spaced("5 seconds")),
  Schedule.satisfiesInputType<WorkflowStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "processing")
)

const script: ReadonlyArray<WorkflowStatus> = [
  { state: "processing", message: "queued" },
  { state: "processing", message: "rendering" },
  { state: "processing", message: "uploading" },
  { state: "processing", message: "still uploading" },
  { state: "processing", message: "almost done" },
  { state: "ready", resultUrl: "/reports/42" }
]

let checks = 0

const checkWorkflowStatus = Effect.gen(function*() {
  const now = yield* Clock.currentTimeMillis
  const status = script[Math.min(checks, script.length - 1)]!
  checks += 1
  console.log(`t+${now}ms check ${checks}: ${status.state}`)
  return status
})

const program = Effect.gen(function*() {
  const fiber = yield* checkWorkflowStatus.pipe(
    Effect.repeat(userTriggeredPolling),
    Effect.forkDetach
  )

  yield* TestClock.adjust("10 seconds")

  const finalStatus = yield* Fiber.join(fiber)
  console.log("final:", finalStatus)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

The first check is immediate. The first four scheduled recurrences use the
500-millisecond cadence; the next recurrence uses the five-second cadence.

##### Variants

Use a shorter fast phase for lightweight UI actions where most completions
happen almost immediately. For example, four recurrences at 300 milliseconds
keeps the responsive window brief.

Use a slower follow-up interval when the user can leave the page open while the
workflow continues. Ten or fifteen seconds is often enough for a visible UI
flow that no longer needs near-instant feedback.

Add jitter to the slower phase when many users may trigger the same workflow at
the same time, such as after a deploy, notification, or scheduled campaign.

Add a separate cap or elapsed-time budget when the UI must eventually stop
waiting and tell the user to check back later.

##### Notes and caveats

`Schedule.take(4)` limits only the fast recurrence phase. It does not include
the initial status check, and it does not limit the slower phase after
`Schedule.andThen`.

Apply the status predicate after `Schedule.andThen` so terminal statuses stop
the whole policy, not only the fast phase.

Keep the status check cheap and read-only. User-triggered polling should
observe progress, not perform the work again.

Request failures stay in the effect failure channel. `Schedule.while` sees only
successful status values.

#### 15.4 Polling strategy for long-running back-office jobs

Use this recipe for back-office jobs that need periodic operator visibility but
are not latency-critical. The schedule gives a few early observations, then
settles into a low-pressure background cadence.

##### Problem

Polling too frequently creates steady pressure on the job store, status API, and
worker database. The polling policy should provide enough early signal to catch
fast failures or obvious progress, then settle into a low-pressure cadence until
the job reaches a terminal state.

##### When to use it

Use this when job completion is useful to observe but not latency critical.

This is a good fit for scheduled or queue-driven operational work where the
poller feeds logs, metrics, dashboards, follow-up tasks, or notifications rather
than a user actively watching a page.

Use it when status checks are cheap enough to run periodically, but expensive
enough that thousands of jobs polling every few seconds would be noticeable.

##### When not to use it

Do not use this for interactive workflows where the caller expects immediate
feedback after clicking a button. Those flows usually need a shorter, bounded
early window before moving to background handling.

Do not use this as a retry policy for a failing status endpoint. With
`Effect.repeat`, failed effects stop the repeat. The schedule sees successful
job status values, not transport or decoding failures.

Do not leave this as an unbounded poller if the surrounding process has no
lifetime, cancellation, or operational owner.

##### Schedule shape

Start with a modest operational cadence, then switch to a slower background
cadence with `Schedule.andThen`. Preserve the latest `JobStatus` with
`Schedule.passthrough`, and continue only while the job is still running.

##### Example

```ts
import { Clock, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type JobStatus =
  | { readonly state: "running"; readonly processed: number; readonly total: number }
  | { readonly state: "completed"; readonly completedAt: string }
  | { readonly state: "failed"; readonly reason: string }

const backOfficeJobPolling = Schedule.spaced("30 seconds").pipe(
  Schedule.take(3),
  Schedule.andThen(Schedule.spaced("5 minutes")),
  Schedule.satisfiesInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "running")
)

const script: ReadonlyArray<JobStatus> = [
  { state: "running", processed: 10, total: 100 },
  { state: "running", processed: 20, total: 100 },
  { state: "running", processed: 30, total: 100 },
  { state: "running", processed: 40, total: 100 },
  { state: "running", processed: 80, total: 100 },
  { state: "completed", completedAt: "2026-05-17T12:00:00Z" }
]

let checks = 0

const readJobStatus = Effect.gen(function*() {
  const now = yield* Clock.currentTimeMillis
  const status = script[Math.min(checks, script.length - 1)]!
  checks += 1
  console.log(`t+${now}ms check ${checks}: ${status.state}`)
  return status
})

const program = Effect.gen(function*() {
  const fiber = yield* readJobStatus.pipe(
    Effect.repeat(backOfficeJobPolling),
    Effect.forkDetach
  )

  yield* TestClock.adjust("15 minutes")

  const finalStatus = yield* Fiber.join(fiber)
  console.log("final:", finalStatus)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

The example uses three early recurrences to keep the output short. In a real
back-office poller, increase that first-phase count if operators need more early
progress samples.

##### Variants

Use a one-minute initial phase when early progress is not operationally useful.
For overnight reconciliation or batch import work, `Schedule.spaced("1 minute")`
followed by `Schedule.spaced("10 minutes")` may be enough.

Use a shorter steady interval when the poller triggers the next automated step,
such as publishing a completion notification or enqueueing a dependent job.

Add jitter when many jobs are created at the same scheduled boundary. A slower
cadence reduces pressure, but identical intervals can still synchronize a large
fleet of pollers.

Add an external timeout, cancellation signal, or owner process lifetime when the
job may remain `"running"` indefinitely because of lost workers or corrupted
state.

##### Notes and caveats

`Effect.repeat` runs the status check once before the schedule controls any
recurrence. The first observation is immediate.

`Schedule.take(3)` limits the first phase to three recurrences after the initial
status check. It is not three total status checks.

`Schedule.spaced` waits after each successful status check completes. That is
usually what you want for back-office polling because status checks may have
variable latency.

`Schedule.while` reads successful `JobStatus` values only. Keep status endpoint
failures in the effect error channel and handle retries separately if the
endpoint itself is unreliable.

#### 15.5 Polling from many clients without synchronization

Use jitter when many clients poll the same service on a regular cadence, but no
client needs to land on an exact shared boundary. Jitter keeps the interval
recognizable while making each recurrence delay vary slightly.

##### Problem

If many clients start together and all poll every five seconds, they can keep
calling the status endpoint in waves. The average request rate may be fine, but
the service sees short synchronized bursts instead of a steadier stream.

Jitter is a small random adjustment to each recurrence delay. It does not change
what status means or when polling should stop; it only reduces accidental timing
alignment.

##### When to use it

Use this for independent clients, fibers, workers, or browser sessions that poll
the same read-only status endpoint.

It fits work that is already in progress, where each caller has its own id and
periodically asks whether the remote state has changed.

##### When not to use it

Do not use jitter as a stop condition. Polling still needs a status predicate,
timeout, recurrence cap, or external interruption.

Do not use it for clock-aligned work, such as checks that must run exactly at
the top of each minute.

Do not treat client-side jitter as overload control. Rate limits, admission
control, quotas, and server-side load shedding are separate mechanisms.

##### Schedule shape

Start with `Schedule.spaced` for the base interval, apply
`Schedule.jittered`, preserve the latest status with `Schedule.passthrough`,
and stop with `Schedule.while` once the status is no longer pending.

In Effect, `Schedule.jittered` adjusts each delay to between 80% and 120% of
the original delay. A five-second interval becomes a recurrence delay between
four and six seconds.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type Status =
  | { readonly state: "pending"; readonly requestId: string }
  | { readonly state: "complete"; readonly requestId: string; readonly resultId: string }

const scriptedStatuses: ReadonlyArray<Status> = [
  { state: "pending", requestId: "request-42" },
  { state: "pending", requestId: "request-42" },
  { state: "complete", requestId: "request-42", resultId: "result-7" }
]

let readIndex = 0

const checkStatus = (requestId: string): Effect.Effect<Status> =>
  Effect.sync(() => {
    const status = scriptedStatuses[
      Math.min(readIndex, scriptedStatuses.length - 1)
    ]!
    readIndex += 1
    return status
  }).pipe(
    Effect.tap((status) => Console.log(`[${requestId}] observed ${status.state}`))
  )

const pollWithJitter = Schedule.spaced("20 millis").pipe(
  Schedule.jittered,
  Schedule.satisfiesInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "pending")
)

const program = checkStatus("request-42").pipe(
  Effect.repeat(pollWithJitter),
  Effect.tap((status) => Console.log(`finished with ${status.state}`))
)

Effect.runPromise(program).then((status) => {
  console.log("result:", status)
})
// Output:
// [request-42] observed pending
// [request-42] observed pending
// [request-42] observed complete
// finished with complete
// result: { state: 'complete', requestId: 'request-42', resultId: 'result-7' }
```

The first status check runs immediately. Later checks wait for the jittered
delay, and the repeat stops as soon as the latest successful status is no longer
`"pending"`.

##### Variants

Add `Schedule.take` or combine with `Schedule.recurs` when the caller needs a
hard recurrence limit. Interpret the last status explicitly, because a bounded
schedule can stop while the operation is still pending.

Use a shorter base interval for cheap status checks that need quick feedback.
Use a longer interval when the dependency should receive less polling traffic.

If the status request itself can fail transiently, retry that request separately
before repeating it. `Effect.repeat` feeds successful status values into the
schedule; failures stop the repeat unless handled first.

##### Notes and caveats

`Schedule.jittered` has fixed bounds: 80% to 120% of the original delay.

`Schedule.while` sees successful status values only. It does not classify
transport, decoding, authorization, or service failures from the effect error
channel.

When a timing schedule reads the latest status through `metadata.input`, apply
`Schedule.satisfiesInputType<T>()` before `Schedule.while`.

#### 15.6 Jittered status checks in distributed systems

Distributed workers often need regular status checks, but a whole fleet should
not call the same dependency at the same instant. Jitter keeps each worker near
the intended cadence while letting checks drift apart.

##### Problem

Workers may check leases, shard assignments, replication tasks, queue drains, or
long-running operations owned by another service. A fixed interval is simple,
but workers that restart together or receive the same batch together can remain
synchronized.

Use jitter when the exact second is not important and the operational goal is a
steadier stream of status reads.

##### When to use it

Use this when multiple replicas, workers, or service instances poll the same
kind of status endpoint.

It fits checks that should happen regularly, but where one worker checking a
little earlier or later has no semantic meaning.

##### When not to use it

Do not use jitter as a completion rule. The status value still decides whether
the remote work is active or terminal.

Do not use it for exact boundary checks, coordinated leader actions, or jobs
where all instances intentionally sample at the same time.

Do not use it as a replacement for concurrency limits, quotas, or backpressure
when the dependency has hard capacity limits.

##### Schedule shape

Combine a base polling interval with `Schedule.jittered`, preserve the latest
status using `Schedule.passthrough`, and continue only while the status is still
active.

Effect's `Schedule.jittered` changes each recurrence delay to 80% to 120% of
the original delay. A ten-second interval becomes a delay between eight and
twelve seconds.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type WorkerStatus =
  | { readonly state: "running"; readonly workerId: string; readonly taskId: string }
  | { readonly state: "complete"; readonly workerId: string; readonly taskId: string }

const scriptedStatuses: ReadonlyArray<WorkerStatus> = [
  { state: "running", workerId: "worker-a", taskId: "task-9" },
  { state: "running", workerId: "worker-a", taskId: "task-9" },
  { state: "complete", workerId: "worker-a", taskId: "task-9" }
]

let readIndex = 0

const checkWorkerStatus = (
  workerId: string,
  taskId: string
): Effect.Effect<WorkerStatus> =>
  Effect.sync(() => {
    const status = scriptedStatuses[
      Math.min(readIndex, scriptedStatuses.length - 1)
    ]!
    readIndex += 1
    return status
  }).pipe(
    Effect.tap((status) => Console.log(`[${workerId}/${taskId}] ${status.state}`))
  )

const distributedStatusChecks = Schedule.spaced("25 millis").pipe(
  Schedule.jittered,
  Schedule.satisfiesInputType<WorkerStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "running")
)

const program = checkWorkerStatus("worker-a", "task-9").pipe(
  Effect.repeat(distributedStatusChecks),
  Effect.tap((status) => Console.log(`final status: ${status.state}`))
)

Effect.runPromise(program).then((status) => {
  console.log("result:", status)
})
// Output:
// [worker-a/task-9] running
// [worker-a/task-9] running
// [worker-a/task-9] complete
// final status: complete
// result: { state: 'complete', workerId: 'worker-a', taskId: 'task-9' }
```

Each worker evaluates its own schedule. Even if several workers start together,
later checks choose independent jittered delays around the same base interval.

##### Variants

Use a shorter base interval for cheap local checks. Use a longer interval for
shared databases, control services, or external APIs.

Add a recurrence cap when a worker should stop after a bounded number of active
observations. Treat the final active status as "not finished in time" rather
than as success.

Retry transient failures inside the status-check effect when appropriate.
`Effect.repeat` itself repeats successes; it does not turn failed reads into
status values.

##### Notes and caveats

`Schedule.jittered` does not expose configurable bounds; the range is fixed at
80% to 120%.

The first status check runs immediately. The schedule controls only later
recurrences.

Use `Schedule.satisfiesInputType<T>()` before `Schedule.while` when the
predicate reads the latest successful status from `metadata.input`.

#### 15.7 Reduce herd effects in control planes

A herd effect is many independent callers hitting the same dependency at the
same time. In control planes, jitter is a small scheduling tool that helps keep
status polling from turning into synchronized bursts.

##### Problem

Control planes often expose status for deployment rollouts, cluster membership,
workflow progress, assignment health, or reconciliation. After restarts,
incident recovery, autoscaling, or batch submissions, many callers may begin
polling together and remain aligned on fixed interval boundaries.

Jitter does not make polling rare. It keeps the intended cadence while making
each caller's recurrence delay slightly different.

##### When to use it

Use this when many processes, workers, tenants, or browser sessions poll a
control-plane endpoint for read-only status.

It fits cases where a response that is a second early or late is fine, but
synchronized read bursts are expensive.

##### When not to use it

Do not use jitter when a control-plane action must happen on an exact
wall-clock boundary.

Do not use jitter as the completion rule. Status values still decide whether an
operation is queued, reconciling, ready, or rejected.

Do not treat jitter as a complete overload strategy. Admission control, quotas,
server-side rate limits, and deployment pacing remain separate concerns.

##### Schedule shape

Use a normal control-plane polling interval with `Schedule.spaced`, apply
`Schedule.jittered`, preserve the latest status with `Schedule.passthrough`,
and keep polling only while the operation is active.

Effect's jitter range is fixed at 80% to 120%. A fifteen-second interval becomes
a delay between twelve and eighteen seconds.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type ControlPlaneStatus =
  | { readonly state: "queued"; readonly operationId: string }
  | { readonly state: "reconciling"; readonly operationId: string }
  | { readonly state: "ready"; readonly operationId: string }
  | { readonly state: "rejected"; readonly operationId: string; readonly reason: string }

const scriptedStatuses: ReadonlyArray<ControlPlaneStatus> = [
  { state: "queued", operationId: "op-22" },
  { state: "reconciling", operationId: "op-22" },
  { state: "ready", operationId: "op-22" }
]

let readIndex = 0

const isActive = (status: ControlPlaneStatus): boolean => status.state === "queued" || status.state === "reconciling"

const describeOperation = (
  operationId: string
): Effect.Effect<ControlPlaneStatus> =>
  Effect.sync(() => {
    const status = scriptedStatuses[
      Math.min(readIndex, scriptedStatuses.length - 1)
    ]!
    readIndex += 1
    return status
  }).pipe(
    Effect.tap((status) => Console.log(`[${operationId}] ${status.state}`))
  )

const controlPlanePolling = Schedule.spaced("30 millis").pipe(
  Schedule.jittered,
  Schedule.satisfiesInputType<ControlPlaneStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => isActive(input))
)

const program = describeOperation("op-22").pipe(
  Effect.repeat(controlPlanePolling),
  Effect.tap((status) => Console.log(`control-plane result: ${status.state}`))
)

Effect.runPromise(program).then((status) => {
  console.log("result:", status)
})
// Output:
// [op-22] queued
// [op-22] reconciling
// [op-22] ready
// control-plane result: ready
// result: { state: 'ready', operationId: 'op-22' }
```

Each caller chooses its own adjusted delay on each recurrence. Even when callers
start together, later status checks are less likely to stay aligned.

##### Variants

Use longer base intervals for expensive control-plane reads or operations that
normally take minutes. Use shorter intervals only for cheap endpoints where
tighter observation is worth the load.

Add a bounded schedule when callers must stop observing non-terminal operations.
Return a distinct "still active" outcome if the bound stops polling before the
control plane reaches a terminal state.

If the control-plane read can fail transiently, add a retry policy to that read
before the repeat.

##### Notes and caveats

Client-side jitter reduces accidental alignment among cooperative callers. It
does not protect the control plane from malicious clients, hard capacity
limits, or every caller being triggered by the same external event.

`Effect.repeat` repeats after successful status reads. Failed reads stop the
repeat unless recovered first.

Use `Schedule.satisfiesInputType<T>()` before reading `metadata.input` in
`Schedule.while`.

## Part V — Delay, Backoff, and Load Control

### 16. Choose a Delay Strategy

#### 16.1 Constant delays

A constant delay waits the same amount of time before each retry or repeated
iteration. It keeps timing predictable without introducing an adaptive backoff
curve.

##### Problem

You need a visible pause between attempts, but the dependency does not need
progressively increasing delays. Immediate retries are too aggressive, while
exponential backoff would obscure a deliberately steady cadence. The policy
should say two things clearly:

- how long to wait between attempts
- when to stop retrying

##### When to use it

Use a constant delay for stable dependencies that occasionally return temporary
failures: a local service restarting, a short network hiccup, a lock that clears
quickly, or an idempotent request to a dependency that normally recovers within
a few seconds.

It is also useful as a conservative first production policy. The delay is easy
to explain in logs and dashboards, and changing `"250 millis"` to `"1 second"`
does not change the shape of the schedule.

##### When not to use it

Do not use a constant delay as the only protection for overload. If every retry
waits the same amount of time, a busy caller can keep applying steady pressure
to a dependency that is already failing.

Do not use it without a stop condition unless the workflow is intentionally
unbounded. `Schedule.spaced("1 second")` by itself keeps recurring forever.

Do not use it for unsafe side effects. Retrying writes requires idempotency,
deduplication, or a domain-specific recovery plan before the schedule is chosen.

##### Schedule shape

For retrying with a constant delay, start with `Schedule.spaced(duration)` and
combine it with a limit such as `Schedule.recurs(n)`.

`Schedule.spaced(duration)` waits that duration after each completed attempt
before allowing the next recurrence. Use this for ordinary retry spacing and
for repeat loops where the gap after work completes is what matters.

`Schedule.fixed(duration)` is different: it targets fixed interval boundaries.
That is useful for fixed-cadence repeating work, but it is usually not what you
mean by "wait 500 milliseconds before retrying." For retry policies, reach for
`spaced` first unless you specifically need clock-like cadence.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class TemporaryProfileError extends Data.TaggedError("TemporaryProfileError")<{
  readonly reason: "Timeout" | "Unavailable"
}> {}

let attempts = 0

const fetchProfile = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`profile attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail(
      new TemporaryProfileError({ reason: "Unavailable" })
    )
  }

  return { id: "user-123", name: "Ada" }
})

const retryWithConstantDelay = Schedule.spaced("50 millis").pipe(
  Schedule.both(Schedule.recurs(4))
)

const program = fetchProfile.pipe(
  Effect.retry(retryWithConstantDelay)
)

Effect.runPromise(program).then((profile) => {
  console.log(`loaded profile: ${profile.name}`)
})
// Output:
// profile attempt 1
// profile attempt 2
// profile attempt 3
// loaded profile: Ada
```

The example uses a short delay so it terminates quickly in `scratchpad/repro.ts`.
In a real retry, choose the delay from the dependency's recovery behavior.

##### Variants

For a user-facing request, keep both the delay and the retry count small so the
caller gets an answer quickly. For a background worker, increase the delay
before increasing the retry count. That keeps the policy simple while reducing
pressure on the dependency.

If many instances run the same policy at the same time, a constant delay can
synchronize retries. Add jitter only after the base delay and retry limit are
correct.

##### Notes and caveats

`Effect.retry` feeds typed failures into the schedule. The first execution is
not delayed, and defects or interruptions are not retried as ordinary typed
failures.

The output of `Schedule.spaced` is a recurrence count. In a retry, that output
is used to drive the policy; the successful value of the retried effect is what
the program returns.

Keep classification close to the effect being retried. The schedule should
describe timing and limits, while the domain code decides which failures are
safe to retry.

#### 16.2 Linear backoff

Linear backoff adds the same amount of extra delay at each retry decision. It
reduces pressure gradually while keeping the delay curve easier to explain than
exponential backoff.

Effect does not provide a `Schedule.linear` constructor. Build this policy from
a stateful schedule that counts retry decisions, then derive the delay from
that count.

##### Problem

A worker calls an internal dependency that usually recovers within a few
seconds. You want waits such as 250 milliseconds, 500 milliseconds, 750
milliseconds, and 1 second before giving up. Doubling would make later attempts
too far apart for this workflow.

##### When to use it

Use linear backoff when each failure should reduce pressure, but you still want
predictable recovery speed. It fits short-lived overload, brief queue or cache
contention, reconnect attempts inside a single process, and internal services
where a simple fixed increment is easier to reason about than an exponential
curve.

##### When not to use it

Do not use linear backoff to retry permanent failures. Authentication errors,
validation failures, malformed requests, and unsafe non-idempotent writes should
be handled before the retry policy is applied.

Do not use it as a fleet-wide protection mechanism by itself. If many callers
fail together, a deterministic linear policy can still make them retry together.
For clustered systems or public APIs, consider adding jitter after choosing the
base delay curve.

Do not leave the schedule unbounded unless retrying forever is intentional. A
linear delay grows slowly, so an unbounded policy can keep work alive for a long
time.

##### Schedule shape

`Schedule.unfold(initial, next)` outputs the current state and computes the next
state for the following decision. Starting at `1` makes the first retry delay
one increment instead of zero.

`Schedule.addDelay` adds an extra delay based on the schedule output. Because
`Schedule.unfold` has no delay of its own, the added delay becomes the retry
delay.

`Schedule.take(5)` bounds the schedule so the effect can retry only a limited
number of times after the original attempt.

##### Example

```ts runnable deterministic
import { Console, Data, Duration, Effect, Schedule } from "effect"

class IndexError extends Data.TaggedError("IndexError")<{
  readonly reason: "busy" | "unavailable"
}> {}

let attempts = 0

const refreshSearchIndex = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`index attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(new IndexError({ reason: "busy" }))
  }

  return "index refreshed"
})

const retryWithLinearBackoff = Schedule.unfold(
  1,
  (step) => Effect.succeed(step + 1)
).pipe(
  Schedule.addDelay((step) => Effect.succeed(Duration.millis(step * 20))),
  Schedule.take(5)
)

const program = refreshSearchIndex.pipe(
  Effect.retry(retryWithLinearBackoff)
)

Effect.runPromise(program).then((message) => {
  console.log(message)
})
// Output:
// index attempt 1
// index attempt 2
// index attempt 3
// index attempt 4
// index refreshed
```

The example uses a 20 millisecond increment so it finishes quickly. With a 250
millisecond increment, the same shape would wait 250ms, 500ms, 750ms, and so on.
If all attempts fail, `Effect.retry` returns the last `IndexError`.

##### Variants

Use a smaller increment for user-facing paths where responsiveness matters. Use
a larger increment for background work that should reduce downstream pressure
more visibly. If many processes may retry at the same time, add
`Schedule.jittered` to the finished policy.

##### Notes and caveats

The step value is schedule state, not the result of the retried effect.
`Effect.retry` feeds typed failures into the schedule, but this policy ignores
the failure value and only uses the retry count.

Because the delay is computed from the step value, changing the initial state
changes the first delay. Start at `0` only when an immediate first retry is
intentional.

Linear backoff has no built-in cap. If the retry count can become large, add a
limit such as `Schedule.take`, a time budget, or a maximum-delay policy before
using it in production.

#### 16.3 Exponential backoff

Exponential backoff grows the delay after each failed attempt. In Effect, use
`Schedule.exponential` for that growing delay and compose it with an explicit
limit so the retry policy has a clear end.

##### Problem

An HTTP API returns a temporary 503, a database is failing over, or a queue
broker is recovering after a restart. Retrying immediately can make the outage
worse. Retrying at a fixed interval can still keep too much steady pressure on
the dependency.

Use exponential backoff when the first retry should happen soon, later retries
should slow down aggressively, and the whole policy should stop after a known
number of retries.

##### When to use it

Use exponential backoff for idempotent remote calls where failures are likely
to be temporary and downstream recovery matters. It is a practical default for
timeouts, connection resets, brief unavailability, and overload responses that
should not be hammered by a tight loop.

The backoff should be visible in the schedule value. A reviewer should be able
to see the starting delay, the growth behavior, and the retry limit without
searching for sleeps or counters elsewhere in the code.

##### When not to use it

Do not use exponential backoff to retry permanent errors. Validation failures,
authorization failures, malformed requests, and unsafe non-idempotent writes
should be handled before this policy is applied.

Do not use `Schedule.exponential` by itself as a production retry policy unless
unbounded retrying is intentional. The schedule keeps recurring, so add
`Schedule.recurs`, `Schedule.take`, or another stopping condition.

##### Schedule shape

`Schedule.exponential(base)` waits using `base * factor^n`, with a default
factor of `2`. For example, `Schedule.exponential("100 millis")` produces
delays of 100 milliseconds, 200 milliseconds, 400 milliseconds, 800
milliseconds, and so on.

With `Effect.retry`, the first call runs immediately. If it fails with a typed
error, the schedule decides whether to retry and how long to wait before the
next call.

Combine `Schedule.exponential(base)` with `Schedule.recurs(n)` to keep the
growing delay but bound the number of retries.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class DownstreamError extends Data.TaggedError("DownstreamError")<{
  readonly reason: "Timeout" | "Unavailable" | "Overloaded"
}> {}

let attempts = 0

const fetchCustomerProfile = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`profile API attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(new DownstreamError({ reason: "Unavailable" }))
  }

  return { customerId: "customer-123", plan: "pro" as const }
})

const retryTransientRemoteFailure = Schedule.exponential("20 millis").pipe(
  Schedule.both(Schedule.recurs(5))
)

const program = fetchCustomerProfile.pipe(
  Effect.retry(retryTransientRemoteFailure)
)

Effect.runPromise(program).then((profile) => {
  console.log(`${profile.customerId} plan: ${profile.plan}`)
})
// Output:
// profile API attempt 1
// profile API attempt 2
// profile API attempt 3
// profile API attempt 4
// customer-123 plan: pro
```

The example uses 20 milliseconds as the base so it finishes quickly. With a
100 millisecond base, the first five retry delays would be 100ms, 200ms, 400ms,
800ms, and 1600ms. If all retries fail, `Effect.retry` returns the last
`DownstreamError`.

##### Variants

Use a gentler factor, such as `Schedule.exponential("200 millis", 1.5)`, when
doubling backs off too quickly for the workflow. For repeated successful work,
`Schedule.take` can limit how many schedule outputs are used.

##### Notes and caveats

`Schedule.recurs(5)` means five retries after the original attempt, so the
effect can run up to six times total.

Basic exponential backoff has no maximum delay cap and no jitter. For
user-facing flows, long-running workers, large fleets, or rate-limited APIs,
add the appropriate cap, time budget, or jittered policy in the surrounding
recipe.

The schedule controls recurrence mechanics. It does not decide whether a
domain operation is safe to retry; classify errors and ensure idempotency near
the effect being retried.

#### 16.4 Capped exponential backoff

Capped exponential backoff grows retry delays quickly at first, then stops
increasing once they reach an operational maximum. The cap keeps a caller,
worker, or supervisor from waiting minutes or hours between attempts.

##### Problem

An operation can tolerate short exponential delays at the start of an outage,
but not the long tail of an uncapped curve. A request timeout, queue lease,
reconnect loop, or operational alert window may require every retry decision to
stay below a known maximum.

##### When to use it

Use capped exponential backoff when the first few retries should spread out
quickly, but every later retry still needs to happen within a known maximum
interval.

This is a common fit for idempotent calls to HTTP APIs, databases, queues,
caches, and control planes. The cap gives operators a concrete answer to "how
long can this wait between attempts?" while preserving the load-shedding
benefit of exponential growth.

##### When not to use it

Do not use this policy to make unsafe work retryable. Non-idempotent writes need
idempotency keys, deduplication, transactions, or another domain guarantee
before retrying is safe.

Do not treat the cap as a total timeout. A policy capped at 5 seconds can still
spend much longer overall if it allows many retries. Use a retry limit or a
time budget when the whole operation must finish within a bound.

Do not use the same capped curve across a large fleet without thinking about
synchronization. If many clients fail together, add jitter after the base timing
is correct.

##### Schedule shape

Start with `Schedule.exponential(base)`. It returns a schedule whose output is
the current delay and whose delay grows by the exponential factor.

Use `Schedule.modifyDelay` to clamp each computed delay before it is used. Add
a retry limit separately with `Schedule.both(Schedule.recurs(n))` when the
operation should eventually give up.

##### Example

```ts runnable deterministic
import { Console, Data, Duration, Effect, Schedule } from "effect"

class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly service: string
}> {}

let attempts = 0

const refreshControlPlaneState = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`control-plane attempt ${attempts}`)

  if (attempts < 5) {
    return yield* Effect.fail(
      new ServiceUnavailable({ service: "control-plane" })
    )
  }

  return "control plane refreshed"
})

const cappedBackoff = Schedule.exponential("20 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(50)))),
  Schedule.both(Schedule.recurs(8))
)

const program = refreshControlPlaneState.pipe(
  Effect.retry(cappedBackoff)
)

Effect.runPromise(program).then((message) => {
  console.log(message)
})
// Output:
// control-plane attempt 1
// control-plane attempt 2
// control-plane attempt 3
// control-plane attempt 4
// control-plane attempt 5
// control plane refreshed
```

The first call to `refreshControlPlaneState` runs immediately. If it fails with
`ServiceUnavailable`, retries use exponential delays starting at 20
milliseconds. Each delay is capped at 50 milliseconds in the example. A
production policy might use a 5 second or 30 second cap, depending on the
workflow.

##### Variants

Use a smaller cap for interactive work and a larger cap for background recovery.
If many processes may retry the same dependency together, keep the cap and add
`Schedule.jittered`.

##### Notes and caveats

`Schedule.modifyDelay` changes the delay chosen by the schedule. It does not
change the schedule output. For `Schedule.exponential`, the output remains the
uncapped exponential duration, even though the actual wait has been capped.

`Schedule.recurs(8)` means eight retries after the original attempt, not eight
total attempts.

With `Effect.retry`, failures are fed into the schedule. If the schedule stops,
the last typed failure is returned. If any attempt succeeds, the retry policy is
finished and the successful value is returned.

### 17. Operational Backoff Recipes

#### 17.1 Backoff for unstable remote APIs

Remote APIs can fail for temporary reasons: gateway timeouts, short rate-limit
windows, deploys, or overloaded dependencies behind the endpoint. A bounded
exponential backoff gives the service time to recover while keeping retry load
explicit.

##### Problem

You submit usage events to a billing API. The request is safe to retry because
it uses an idempotency key, but the API sometimes returns retryable statuses
such as `408`, `429`, or `5xx`.

The policy should start with a short delay, grow exponentially, cap long waits,
stop after a small budget, and avoid retrying permanent client errors.

##### When to use it

Use this for idempotent remote calls: fetching a report, submitting a
deduplicated event, refreshing a token from a temporarily unavailable identity
provider, or calling an internal service that occasionally returns `503`.

It is useful when many callers share the dependency because the retry count,
elapsed budget, cap, and jitter are visible in one schedule.

##### When not to use it

Do not retry bad input, missing credentials, forbidden access, nonexistent
resources, or schema mismatches. Be careful with non-idempotent operations:
backoff controls timing, not duplicate side effects.

##### Schedule shape

`Schedule.exponential("100 millis")` produces delays that grow by the default
factor of `2`. Add `Schedule.jittered` when many clients may fail together. Use
`Schedule.modifyDelay` with `Duration.min` to cap each delay, then combine the
cadence with `Schedule.recurs` and `Schedule.during` for count and time bounds.

Use the `while` option on `Effect.retry` to classify retryable errors.

##### Example

```ts
import { Console, Data, Duration, Effect, Schedule } from "effect"

class RemoteApiError extends Data.TaggedError("RemoteApiError")<{
  readonly status: number
  readonly message: string
}> {}

interface UsageReceipt {
  readonly id: string
}

interface UsageRequest {
  readonly accountId: string
  readonly units: number
  readonly idempotencyKey: string
}

const statuses = [503, 429, 200] as const
let attempts = 0

const submitUsageEvent = (request: UsageRequest) =>
  Effect.gen(function*() {
    attempts += 1
    const status = statuses[Math.min(attempts - 1, statuses.length - 1)]
    yield* Console.log(`billing attempt ${attempts}: HTTP ${status}`)

    if (status !== 200) {
      return yield* Effect.fail(
        new RemoteApiError({ status, message: "temporary billing failure" })
      )
    }

    return {
      id: `receipt-${request.idempotencyKey}`
    } satisfies UsageReceipt
  })

const isRetryable = (error: RemoteApiError) => error.status === 408 || error.status === 429 || error.status >= 500

const remoteApiBackoff = Schedule.exponential("20 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(80)))),
  Schedule.both(Schedule.recurs(4)),
  Schedule.both(Schedule.during("1 second"))
)

const program = Effect.gen(function*() {
  const receipt = yield* submitUsageEvent({
    accountId: "acct_123",
    units: 42,
    idempotencyKey: "usage-acct_123-demo"
  }).pipe(
    Effect.retry({
      schedule: remoteApiBackoff,
      while: isRetryable
    })
  )
  yield* Console.log(`accepted usage event: ${receipt.id}`)
}).pipe(
  Effect.catch((error) => Console.log(`usage event failed without retrying further: ${error._tag}`))
)

Effect.runPromise(program)
```

The example uses millisecond-scale delays so it is quick to run. Increase the
base, cap, and budget for a real remote API.

##### Variants

For a user-facing request, shorten the elapsed budget and retry count. For a
background worker, keep jitter enabled and emit metrics at the retry boundary so
operators can see when the dependency is forcing callers into backoff.

If the API returns `Retry-After`, prefer that server-provided timing for rate
limits. Exponential backoff is a local fallback when the remote service gives no
better signal.

##### Notes and caveats

`Schedule.exponential` recurs forever by itself. Always pair it with a count
limit, elapsed budget, or domain predicate.

Backoff is only one part of remote API safety. Use timeouts, classify errors,
keep request bodies replayable, and require idempotency for mutating calls.

#### 17.2 Backoff for queue reconnection

Queue reconnection should have one visible timing policy. That policy describes
how much pressure a consumer applies while the broker, network path, or endpoint
is recovering.

##### Problem

A worker must open a queue connection before it can consume messages. The first
attempt should happen immediately. Transient connection failures should retry
with a growing delay and stop after a clear budget.

##### When to use it

Use this for queue clients, broker consumers, or background workers where the
right response to a transient disconnect is to reconnect. Operators should be
able to answer "how many reconnects will this try?" and "how quickly does the
delay grow?" from the schedule.

##### When not to use it

Do not retry permanent configuration problems: bad credentials, missing queues,
invalid consumer groups, or schema mismatches. Keep decode and processing
failures out of the reconnect policy unless reconnecting is truly the recovery
action.

##### Schedule shape

`Schedule.exponential("250 millis")` starts at 250 milliseconds and doubles by
default. `Schedule.recurs(6)` allows six retries after the original attempt.
`Schedule.jittered` spreads reconnects when many workers fail at the same time.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type QueueConnectError =
  | { readonly _tag: "BrokerUnavailable" }
  | { readonly _tag: "ConnectionReset" }

type QueueRuntimeError =
  | QueueConnectError
  | { readonly _tag: "MessageDecodeFailed" }

interface QueueConnection {
  readonly run: Effect.Effect<void, QueueRuntimeError>
}

let connectAttempts = 0

const openQueueConnection: Effect.Effect<QueueConnection, QueueConnectError> = Effect.gen(function*() {
  connectAttempts += 1
  yield* Console.log(`queue connect attempt ${connectAttempts}`)

  if (connectAttempts < 3) {
    return yield* Effect.fail({ _tag: "BrokerUnavailable" } as const)
  }

  return {
    run: Console.log("consumer processed one message")
  }
})

const reconnectBackoff = Schedule.exponential("20 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const connectWithBackoff = openQueueConnection.pipe(
  Effect.retry(reconnectBackoff)
)

const consumer = Effect.gen(function*() {
  const connection = yield* connectWithBackoff
  yield* connection.run
}).pipe(
  Effect.catch((error) => Console.log(`consumer failed: ${error._tag}`))
)

Effect.runPromise(consumer)
// Output:
// queue connect attempt 1
// queue connect attempt 2
// queue connect attempt 3
// consumer processed one message
```

The example stops after one processed message so it can be pasted into a
scratchpad and run immediately.

##### Variants

For a single local worker, deterministic timing may be easier to debug, so
jitter can be removed. For a larger fleet, keep jitter and consider a larger
base delay so broker recovery does not receive a synchronized reconnect wave.

For a supervisor that should restart the whole consumer after runtime
disconnects, apply the policy around the larger effect that opens the connection
and runs the consume loop.

##### Notes and caveats

`Effect.retry` feeds typed failures into the schedule. In the example, only
`QueueConnectError` reaches the reconnect policy, so message decode failures are
not silently treated as connection problems.

#### 17.3 Backoff for cold-start dependencies

Cold-start checks should be responsive when dependencies are ready and gentle
when they are not. During deploys or scale-out, many instances may open pools,
load config, warm caches, and contact dependencies at the same time.

##### Problem

A startup readiness check controls whether the process becomes ready. It should
run immediately, retry only transient readiness failures, increase delay after
each failed check, and stop after a clear startup budget.

##### When to use it

Use this for idempotent startup gates: pinging a database, checking a cache
endpoint, opening a broker connection, or asking a local sidecar whether it has
finished initialization.

It is most useful when process start order does not guarantee dependency
readiness: deploys, autoscaling, local multi-service development, and test
containers.

##### When not to use it

Do not retry bad credentials, invalid URLs, missing schemas, unsupported
protocol versions, or authorization failures. Retry the narrow readiness check,
not the whole startup program.

If every deploy overloads the dependency for minutes, the schedule is exposing a
capacity problem rather than solving it.

##### Schedule shape

`Schedule.exponential("200 millis")` waits 200 milliseconds before the first
retry, then 400 milliseconds, 800 milliseconds, and so on. Combine it with
`Schedule.recurs` for a startup budget. Use `Schedule.jittered` for fleet
startup so instances are less likely to retry at exactly the same moment.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class DependencyNotReady extends Data.TaggedError("DependencyNotReady")<{
  readonly dependency: string
  readonly reason: string
}> {}

class DependencyMisconfigured extends Data.TaggedError("DependencyMisconfigured")<{
  readonly dependency: string
  readonly reason: string
}> {}

type StartupDependencyError = DependencyNotReady | DependencyMisconfigured

let readinessChecks = 0

const checkDatabaseReady: Effect.Effect<void, StartupDependencyError> = Effect.gen(function*() {
  readinessChecks += 1
  yield* Console.log(`database readiness check ${readinessChecks}`)

  if (readinessChecks < 4) {
    return yield* Effect.fail(
      new DependencyNotReady({
        dependency: "postgres",
        reason: "accepting connections soon"
      })
    )
  }
})

const startHttpServer = Console.log("HTTP server started")

const coldStartBackoff = Schedule.exponential("15 millis").pipe(
  Schedule.both(Schedule.recurs(5)),
  Schedule.jittered
)

const isRetryableStartupFailure = (error: StartupDependencyError) => error._tag === "DependencyNotReady"

const program = Effect.gen(function*() {
  yield* checkDatabaseReady.pipe(
    Effect.retry({
      schedule: coldStartBackoff,
      while: isRetryableStartupFailure
    })
  )

  yield* startHttpServer
}).pipe(
  Effect.catch((error) => Console.log(`startup failed: ${error._tag}`))
)

Effect.runPromise(program)
// Output:
// database readiness check 1
// database readiness check 2
// database readiness check 3
// database readiness check 4
// HTTP server started
```

The first readiness check runs before the schedule is consulted. If a retry
eventually succeeds, startup continues. If the failure is misconfiguration, the
`while` predicate prevents retrying.

##### Variants

For a single local process, remove jitter when deterministic timing is more
useful. For large rollouts, keep jitter and use a slower base delay or gentler
growth factor. For dependencies with a strict startup service-level objective,
use a smaller retry count and let orchestration restart or reschedule the
process after failure.

##### Notes and caveats

`Schedule.recurs(5)` means five retries after the original readiness check, not
five total checks.

Backoff reduces startup storms by waiting longer after each failure. Jitter
reduces synchronization between instances. They address different parts of the
same startup problem and are often used together.

#### 17.4 Cap long tails in retry behavior

Use this to keep late retries visible by putting a maximum wait on a growing
backoff policy.

##### Problem

Long retry tails make systems look idle while work is still pending. A worker
may be holding a queue lease, a supervisor may be waiting for reconnect, or an
operator may be looking for the next attempt in logs. A cap keeps the tail
within a known interval.

##### When to use it

Use it for idempotent retry paths such as control-plane calls, reconnect loops,
queue consumers, and reconciliation jobs. The cap answers "how long until this
tries again?" and a separate retry limit answers "when does this stop?"

##### When not to use it

Do not use a cap to make permanent failures look transient. Classify validation
errors, authorization failures, malformed requests, and unsafe writes before the
retry policy is applied.

Do not treat the cap as a total timeout. A 5-second cap only bounds the delay
between attempts. The total runtime also depends on how many retries are allowed
and how long each attempted operation takes.

##### Schedule shape

Start with `Schedule.exponential(base)`, then clamp the actual delay selected
for the next recurrence with `Schedule.modifyDelay`. The clamp is
`Duration.min(delay, Duration.seconds(5))`.

`Schedule.exponential` still outputs the uncapped exponential duration.
`Schedule.modifyDelay` changes the actual sleep used by the schedule. Add
stopping behavior separately with `Schedule.recurs` or `Schedule.during`.

##### Example

```ts runnable deterministic
import { Console, Data, Duration, Effect, Schedule } from "effect"

class ControlPlaneUnavailable extends Data.TaggedError(
  "ControlPlaneUnavailable"
)<{
  readonly service: string
  readonly attempt: number
}> {}

let attempts = 0

const refreshRoutingTable = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`refresh attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(
      new ControlPlaneUnavailable({
        service: "routing",
        attempt: attempts
      })
    )
  }

  return "routes refreshed"
})

const capAt5Seconds = (delay: Duration.Duration) => Duration.min(delay, Duration.seconds(5))

const cappedBackoff = Schedule.exponential("250 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(capAt5Seconds(delay))),
  Schedule.tapInput((error: ControlPlaneUnavailable) =>
    Console.log(`retrying ${error.service} after attempt ${error.attempt}`)
  ),
  Schedule.tapOutput((rawDelay) =>
    Console.log(
      `raw next delay: ${Duration.format(rawDelay)}, capped at: ${Duration.format(capAt5Seconds(rawDelay))}`
    )
  ),
  Schedule.both(Schedule.recurs(8))
)

const program = refreshRoutingTable.pipe(
  Effect.retry(cappedBackoff),
  Effect.flatMap((message) => Console.log(`result: ${message}`))
)

Effect.runPromise(program)
// Output:
// refresh attempt 1
// retrying routing after attempt 1
// raw next delay: 250ms, capped at: 250ms
// refresh attempt 2
// retrying routing after attempt 2
// raw next delay: 500ms, capped at: 500ms
// refresh attempt 3
// retrying routing after attempt 3
// raw next delay: 1s, capped at: 1s
// refresh attempt 4
// result: routes refreshed
```

`Schedule.tapInput` logs the failure that caused a retry. `Schedule.tapOutput`
logs the raw exponential output and the capped value used by the delay
calculation.

##### Variants

Use a smaller cap for interactive work. Add `Schedule.during` when the whole
retry window needs an elapsed budget. For fleet-wide retry paths, apply
`Schedule.jittered` before the final cap so randomization does not break the
maximum-delay guarantee.

##### Notes and caveats

`Schedule.recurs(8)` means eight retries after the original attempt, not eight
total attempts.

Capping long tails is an operational visibility tool, not just a latency tweak:
dashboards, logs, alerts, and humans can reason about the next retry without
reading scattered sleeps or hidden counters.

#### 17.5 Cap delays without losing backoff benefits

Use this to keep the useful early shape of exponential backoff while preventing
late delays from becoming too long.

##### Problem

Backoff should reduce pressure quickly: `250 millis`, `500 millis`, `1 second`,
`2 seconds`, and so on. The same curve can later drift into 16, 32, or 64 second
waits. The policy should say both things: grow while the delay is small, then
stop growing at the cap.

##### When to use it

Use it for retry or reconnect loops where short early retries are helpful but
long tail delays are not: control-plane calls, startup probes, worker reconnects,
and idempotent remote operations. It is also useful when the maximum single
delay is part of the operational contract.

##### When not to use it

Do not use capped backoff to make permanent failures look transient. Classify
validation errors, authorization failures, malformed requests, and unsafe
non-idempotent writes before `Effect.retry` applies the schedule.

Avoid it when a fixed cadence is the real requirement. If every retry should
wait exactly 5 seconds, use `Schedule.spaced("5 seconds")`.

##### Schedule shape

Build the policy in two steps:

- start with `Schedule.exponential`, which outputs the computed delay and uses
  that delay before the next recurrence
- apply `Schedule.modifyDelay` with `Duration.min` so the delay used by the
  schedule is never larger than the cap

The cap does not flatten the whole policy. With a base of `250 millis` and a
5-second cap, the early delays are still `250 millis`, `500 millis`, `1 second`,
`2 seconds`, and `4 seconds`. Only computed delays above 5 seconds are replaced.

##### Example

```ts runnable deterministic
import { Console, Data, Duration, Effect, Schedule } from "effect"

class RemoteError extends Data.TaggedError("RemoteError")<{
  readonly attempt: number
}> {}

let attempts = 0

const callControlPlane = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(new RemoteError({ attempt: attempts }))
  }

  return "ok"
})

const capAt5Seconds = (delay: Duration.Duration) => Duration.min(delay, Duration.seconds(5))

const cappedCadence = Schedule.exponential("250 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(capAt5Seconds(delay))),
  Schedule.tapOutput((rawDelay) =>
    Console.log(
      `raw delay ${Duration.format(rawDelay)} -> capped ${Duration.format(capAt5Seconds(rawDelay))}`
    )
  )
)

const retryPolicy = cappedCadence.pipe(
  Schedule.both(Schedule.recurs(8))
)

const program = callControlPlane.pipe(
  Effect.retry(retryPolicy),
  Effect.flatMap((result) => Console.log(`result: ${result}`))
)

Effect.runPromise(program)
// Output:
// attempt 1
// raw delay 250ms -> capped 250ms
// attempt 2
// raw delay 500ms -> capped 500ms
// attempt 3
// raw delay 1s -> capped 1s
// attempt 4
// result: ok
```

Delays below the cap pass through unchanged, so the policy keeps the early
benefit of exponential spacing. Delays above the cap are limited, so the late
retry loop cannot become quieter than the workflow allows.

##### Variants

For a gentler curve, pass a smaller factor to `Schedule.exponential`, such as
`Schedule.exponential("250 millis", 1.5)`. The same cap still applies; it just
takes more recurrences to reach it.

For many instances using the same retry policy, apply `Schedule.jittered` before
the final cap. That spreads retry traffic while preserving the maximum-delay
promise.

##### Notes and caveats

`Schedule.modifyDelay` changes the delay used between recurrences; it does not
change the schedule output. In the example, `Schedule.tapOutput` receives the
raw exponential delay and computes the capped value separately for logging.

`Effect.retry` feeds failures into the schedule. `Effect.repeat` feeds
successful values into the schedule. That distinction matters if you later add
predicates or observation hooks such as `Schedule.tapInput`.

### 18. Spacing and Throttling

#### 18.1 At least one request per second

Use `Schedule` to make a repeat loop's pacing visible instead of hiding sleeps
around request code.

##### Problem

A client or worker may need to keep making requests without running in a tight
loop. Reviewers should be able to see whether the one-second rule is a
post-completion gap or a fixed interval boundary, because those shapes behave
differently when requests are slow.

##### When to use it

Use this when a single fiber should keep sending requests with a controlled gap
between them. It fits background synchronization, lightweight polling,
heartbeat-style calls, and integrations where a steady request stream is useful
but bursts are not.

It is especially useful when request duration should contribute to the overall
spacing. If a request takes 300 milliseconds and the schedule is spaced by one
second, the next request starts about one second after the previous request
completed, not 700 milliseconds later.

##### When not to use it

Do not use this wording when you really mean a minimum throughput guarantee.
`Schedule.spaced("1 second")` can prevent a loop from running more frequently
than one request plus one gap, but it cannot ensure at least one completed
request per second when requests are slow, blocked, retried elsewhere, or
interrupted.

Do not use this as a fleet-wide rate limiter. A schedule controls one repeated
effect. Coordinating many fibers, processes, or hosts needs a shared limiter,
queue, semaphore, or service-side quota policy.

Do not use `Effect.repeat` to retry failed requests. With `Effect.repeat`, a
typed failure from the request stops the repeat. If failures should be retried,
apply a retry policy around the request itself and then repeat the successful
request loop.

##### Schedule shape

The basic policy is `Schedule.spaced("1 second")`. It recurs continuously and
contributes a one-second delay to every recurrence decision. With
`Effect.repeat`, the first request runs immediately. After each successful
request, the schedule waits one second before the next request starts.

The shape is:

- request 1: run immediately
- if request 1 succeeds: wait one second
- request 2: run again
- if request 2 succeeds: wait one second
- continue until the fiber is interrupted, the request fails, or a bounded
  variant stops the schedule

Use `Schedule.fixed("1 second")` for a different shape: it targets fixed
one-second interval boundaries. If a request takes longer than the interval,
the next run happens immediately, but missed runs do not pile up.

##### Example

```ts
import { Console, Effect, Ref, Schedule } from "effect"

type RequestError = {
  readonly _tag: "RequestError"
  readonly message: string
}

const oneSecondAfterEachRequest = Schedule.spaced("1 second").pipe(
  Schedule.take(2)
)

const program = Effect.gen(function*() {
  const sent = yield* Ref.make(0)

  const sendRequest: Effect.Effect<void, RequestError> = Ref.updateAndGet(
    sent,
    (n) => n + 1
  ).pipe(
    Effect.tap((requestNumber) => Console.log(`sent request ${requestNumber}`)),
    Effect.flatMap(() => Effect.sleep("25 millis"))
  )

  const finalRecurrence = yield* sendRequest.pipe(
    Effect.repeat(oneSecondAfterEachRequest)
  )

  yield* Console.log(`schedule stopped after recurrence ${finalRecurrence}`)
})

Effect.runPromise(program)
```

`program` sends the first request immediately, then waits one second after each
successful request before the next run. `Schedule.take(2)` keeps the example
finite: one initial run plus two scheduled recurrences.

The schedule output is the recurrence count. The operational contract is the
delay between successful request runs.

##### Variants

Bound the loop when the worker should perform only a limited number of
additional requests. The first request still runs immediately; `Schedule.take(5)`
limits the scheduled recurrences after that first request.

Use `Schedule.fixed("1 second")` when fixed interval boundaries are the
requirement. It is not the same as "sleep one second after each request"; if a
request runs long, the next request may start immediately.

##### Notes and caveats

Be careful with the phrase "at least one request per second". In ordinary rate
limiting language, this recipe is closer to "no more often than one request
plus one one-second gap per loop". It spaces requests; it does not guarantee a
minimum successful request rate.

`Schedule.spaced("1 second")` delays recurrences; it does not delay the first
request. The first execution of the repeated effect happens immediately.

`Schedule.fixed("1 second")` and `Schedule.spaced("1 second")` are both real
cadence APIs, but they answer different questions. Use `spaced` for a gap after
work completes. Use `fixed` for fixed interval boundaries.

`Effect.repeat` feeds successful values into the schedule. Failed requests do
not become schedule inputs; they stop the repeat unless you handle or retry
them before repeating.

#### 18.2 Process a batch with gaps between items

Use `Schedule.spaced` when a finite batch should move one item at a time with a
visible pause between successful sends.

##### Problem

An import worker may call a partner API, write to a rate-limited database, or
publish messages to a broker. Each item can be processed independently, but a
back-to-back batch can create a short spike in connections, locks, queue depth,
or remote requests.

##### When to use it

Use this when the important rule is "after a successful item, wait before
starting the next item."

`Schedule.spaced(duration)` is the direct fit for dependency pressure caused by
successful work. It waits after the previous item finishes, so the dependency
gets a quiet period before the next item starts.

This is appropriate for small to moderate batches where sequential processing is
acceptable and the gap is part of the operational contract.

##### When not to use it

Do not use this to retry a failed item by itself. With `Effect.repeat`, failures
stop the repeat. If an item should be retried, apply an explicit retry policy
around the item processor before returning success to the batch loop.

Do not use spacing as the only protection for a heavily shared dependency. Gaps
reduce pressure from one worker, but they do not replace concurrency limits,
rate-limit headers, bulkheads, queue backpressure, or admission control.

Do not use this when the batch must complete as quickly as possible and the
dependency can safely absorb the burst. In that case a plain sequential
`Effect.forEach` may be clearer.

##### Schedule shape

The repeated effect returns the number of items remaining after the item it just
processed. `Schedule.while` sees that successful value as `input`. If more items
remain, the schedule waits and allows the next recurrence. If no items remain,
the repeat stops immediately.

Use `Schedule.spaced` rather than `Schedule.fixed` when you want the gap to be
measured after each item completes. If an item takes 100 milliseconds to send and
the spacing is 250 milliseconds, the next item starts about 350 milliseconds
after the previous item started.

##### Example

```ts runnable deterministic
import { Console, Effect, Ref, Schedule } from "effect"

type BatchItem = {
  readonly id: string
  readonly payload: string
}

type DependencyError = {
  readonly _tag: "DependencyError"
  readonly itemId: string
}

const items: ReadonlyArray<BatchItem> = [
  { id: "a", payload: "alpha" },
  { id: "b", payload: "bravo" },
  { id: "c", payload: "charlie" }
]

const gapBetweenItems = Schedule.spaced("50 millis").pipe(
  Schedule.satisfiesInputType<number>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input > 0)
)

const program = Effect.gen(function*() {
  const remaining = yield* Ref.make(items)

  const sendToDependency = (
    item: BatchItem
  ): Effect.Effect<void, DependencyError> => Console.log(`sent ${item.id}: ${item.payload}`)

  const processNext = Effect.gen(function*() {
    const item = yield* Ref.modify(remaining, (items) =>
      [
        items[0],
        items.slice(1)
      ] as const)

    if (item === undefined) {
      return 0
    }

    yield* sendToDependency(item)

    const left = yield* Ref.get(remaining)
    yield* Console.log(`${left.length} item(s) left`)

    return left.length
  })

  const finalRemaining = yield* processNext.pipe(
    Effect.repeat(gapBetweenItems)
  )

  yield* Console.log(`batch complete; remaining=${finalRemaining}`)
})

Effect.runPromise(program)
// Output:
// sent a: alpha
// 2 item(s) left
// sent b: bravo
// 1 item(s) left
// sent c: charlie
// 0 item(s) left
// batch complete; remaining=0
```

The first item is sent immediately. If more items remain, the schedule waits
before processing the next item. After the last item succeeds, `processNext`
returns `0`, so the schedule stops without adding another gap. The snippet uses
a short gap so it finishes quickly in a scratchpad.

##### Variants

Use a longer gap when the downstream dependency shows pressure through rising
latency, lock waits, queue depth, rate-limit responses, or connection pool
exhaustion.

Use a shorter gap when each item is cheap and the dependency has enough spare
capacity. Keep the chosen duration visible in a named schedule so operators can
tune it without reverse-engineering a loop.

If many workers may start batches at the same time, add `Schedule.jittered`
after choosing the base spacing. Jitter reduces synchronized pressure across
workers, but it does not bound total throughput by itself. Pair it with worker
concurrency limits or a dependency rate limiter when the dependency has a hard
quota.

##### Notes and caveats

The schedule does not delay the first item. It controls only recurrences after a
successful item has been processed.

`Effect.repeat` feeds successful values into the schedule. In this recipe, the
successful value is the remaining item count, and `Schedule.while` uses it to
decide whether another recurrence is needed.

If `sendToDependency` fails, the batch stops with that failure. Add item-level
classification and retry separately if transient failures should be retried.

`Schedule.spaced` measures the delay after the previous item completes. That is
usually what you want for dependency pressure, because slow items naturally
reduce the start rate of later items.

#### 18.3 Avoid hammering an external API

Use a schedule to make retry spacing explicit for external APIs. The first call
is immediate, and only follow-up attempts after a failure are paced.

##### Problem

You call a third-party API from a worker. The request is replay-safe because it
uses an idempotency key, but the service sometimes responds with a timeout, a
short rate-limit window, or a transient server error. Reviewers should be able
to see:

- how quickly retries start
- how retries spread out over time
- how many extra requests the policy can create
- which failures are allowed to retry
- why the request is safe to replay

##### When to use it

Use this recipe when a remote call can be retried but should leave breathing
room between attempts. Typical examples are fetching a generated report,
submitting an idempotent event, refreshing data from a vendor API, or retrying a
temporary `429` from a service with a documented quota.

It is a good fit when retry safety is part of the API contract. The schedule can
limit pressure, but the request still needs to be replayable: use an
idempotency key, a deduplication token, a natural resource identifier, or a
read-only operation.

##### When not to use it

Do not use retry spacing to make unsafe side effects safe. Retrying
`POST /payments` or `POST /orders` can duplicate work unless the external API
provides idempotency or another deduplication mechanism.

Do not retry permanent failures such as invalid input, missing credentials,
forbidden access, or a resource that does not exist. Classify those errors
before the schedule is allowed to recur.

Do not treat `Schedule` as a distributed rate limiter. A schedule spaces one
program's recurrences. If many processes share the same vendor quota, combine
this retry policy with a real rate limiter or vendor-provided `Retry-After`
handling.

##### Schedule shape

Start with the delay shape, then add guardrails. An exponential schedule
starting at 250 milliseconds grows by the default factor of `2`: about `250ms`,
`500ms`, `1s`, `2s`, and so on. `Schedule.jittered` randomly adjusts each
recurrence delay between `80%` and `120%` of the computed delay, which helps
avoid synchronized retries when many workers fail at the same time.

`Schedule.recurs(5)` bounds the extra requests. `Schedule.during("30 seconds")`
bounds the elapsed retry window when combined with `Schedule.both`. `both` gives
intersection semantics: the combined policy continues only while both component
schedules continue, and it uses the maximum of their delays.

The code below uses shorter durations so it can be pasted into a scratchpad and
finish quickly.

##### Example

```ts
import { Console, Data, Effect, Random, Ref, Schedule } from "effect"

class VendorApiError extends Data.TaggedError("VendorApiError")<{
  readonly status: number
  readonly message: string
}> {}

interface Enrichment {
  readonly companyId: string
  readonly riskScore: number
}

const isRetryableVendorFailure = (error: VendorApiError) =>
  error.status === 408 ||
  error.status === 429 ||
  error.status >= 500

const vendorRetryPolicy = Schedule.exponential("30 millis").pipe(
  Schedule.satisfiesInputType<VendorApiError>(),
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
  Schedule.both(Schedule.during("1 second")),
  Schedule.while(({ input }) => isRetryableVendorFailure(input))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)

  const enrichCompany = (request: {
    readonly companyId: string
    readonly idempotencyKey: string
  }): Effect.Effect<Enrichment, VendorApiError> =>
    Effect.gen(function*() {
      const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
      yield* Console.log(
        `vendor attempt ${attempt} with key ${request.idempotencyKey}`
      )

      if (attempt === 1) {
        return yield* Effect.fail(
          new VendorApiError({ status: 429, message: "slow down" })
        )
      }

      if (attempt === 2) {
        return yield* Effect.fail(
          new VendorApiError({ status: 503, message: "temporary outage" })
        )
      }

      return { companyId: request.companyId, riskScore: 42 }
    })

  const enrichment = yield* enrichCompany({
    companyId: "company_123",
    idempotencyKey: "enrich-company_123"
  }).pipe(
    Effect.retry(vendorRetryPolicy),
    Random.withSeed("vendor-retry-demo")
  )

  yield* Console.log(`risk score: ${enrichment.riskScore}`)
})

Effect.runPromise(program)
```

The first `enrichCompany` call happens immediately. If it fails with a retryable
`VendorApiError`, `Effect.retry` feeds that failure into the schedule. The
schedule waits for the jittered exponential delay and then allows another
attempt. If the error is not retryable, the retry count is exhausted, or the
elapsed budget is exceeded, the original failure is returned.

##### Variants

For a strict published quota, choose a base delay that respects the quota even
under retries. If the API allows one request per second per tenant, a
`Schedule.spaced("1 second")` policy may be clearer than exponential backoff
because it states the minimum gap directly.

For a bursty worker fleet, keep jitter enabled and consider a larger starting
delay. Jitter spreads retries from identical clients, but it does not coordinate
quota across processes.

If the vendor returns `Retry-After`, prefer honoring that response when it is
available. A local schedule is a fallback policy; a server-provided delay is
usually the more accurate rate-limit signal.

##### Notes and caveats

`Effect.retry` is failure-driven. It retries only after the effect fails, and it
passes the failure to the schedule as `input`. That is why `Schedule.while` can
inspect `VendorApiError` and stop on non-retryable statuses.

`Schedule.exponential` and `Schedule.spaced` are unbounded by themselves. Always
combine them with a retry count, elapsed budget, domain predicate, or enclosing
lifetime when calling an external API.

Spacing protects the dependency from immediate retry bursts, but it does not
guarantee global compliance with a vendor quota. Use a shared rate limiter when
the limit applies across workers, tenants, or service instances.

Retry safety is separate from timing. Before adding a schedule, make sure the
operation is read-only or replay-safe through idempotency, deduplication, or a
vendor contract that explicitly permits retrying.

#### 18.4 Smooth demand over time

Use `Schedule.spaced` and, when needed, `Schedule.jittered` to turn repeated
work into a paced stream with visible timing rules.

##### Problem

Queue draining, cache warming, search indexing, and remote API calls can create
uneven pressure when they run as quickly as possible: idle time, a burst of
requests, then more idle time.

The schedule should make each worker's pace explicit, and a fleet should avoid
synchronized requests when instances share the same configuration.

##### When to use it

Use this recipe for background loops where each repetition is safe and useful on
its own, but bursty demand would hurt a downstream service, database, queue, or
cache.

It is especially useful when several process instances run the same loop. A
shared one-second spacing gives every instance the same average pace, while
jitter gives each instance a slightly different actual delay on each recurrence.

##### When not to use it

Do not use spacing and jitter as a substitute for real concurrency limits, queue
backpressure, rate-limit handling, or overload protection. A schedule controls
when the next repetition is attempted; it does not know how much work is waiting
or how much capacity the downstream system currently has.

Do not add jitter when exact wall-clock cadence matters, such as emitting a
sample exactly on a reporting boundary. In that case, choose a precise cadence
deliberately and accept that it may align across workers.

##### Schedule shape

`Schedule.spaced("1 second")` waits one second after each successful repetition
before the next repetition is started. This differs from `Schedule.fixed`, which
tries to maintain a wall-clock interval and may run immediately if the previous
action took longer than the interval.

`Schedule.jittered` adjusts each computed delay between `80%` and `120%` of the
original delay. Applied to a one-second spaced schedule, each sleep is randomly
chosen between 800 milliseconds and 1.2 seconds. The average pace stays close to
the base spacing, but instances no longer line up perfectly.

##### Example

```ts runnable deterministic
import { Console, Effect, Random, Ref, Schedule } from "effect"

type WorkItem = {
  readonly id: string
}

type WorkerError = {
  readonly _tag: "WorkerError"
}

const initialItems: ReadonlyArray<WorkItem> = [
  { id: "job-1" },
  { id: "job-2" },
  { id: "job-3" },
  { id: "job-4" }
]

const smoothedDemand = Schedule.spaced("40 millis").pipe(
  Schedule.jittered,
  Schedule.satisfiesInputType<number>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input > 0)
)

const program = Effect.gen(function*() {
  const queue = yield* Ref.make(initialItems)

  const processNextItem: Effect.Effect<number, WorkerError> = Effect.gen(
    function*() {
      const item = yield* Ref.modify(queue, (items) =>
        [
          items[0],
          items.slice(1)
        ] as const)

      if (item === undefined) {
        return 0
      }

      yield* Console.log(`processed ${item.id}`)

      const remaining = yield* Ref.get(queue)
      return remaining.length
    }
  )

  const remaining = yield* processNextItem.pipe(
    Effect.repeat(smoothedDemand),
    Random.withSeed("smoothed-demand-demo")
  )

  yield* Console.log(`queue drained; remaining=${remaining}`)
})

Effect.runPromise(program)
// Output:
// processed job-1
// processed job-2
// processed job-3
// processed job-4
// queue drained; remaining=0
```

The first `processNextItem` run happens immediately. The schedule controls only
the follow-up repetitions. Each successful run is followed by a jittered delay
around the base spacing, and `Schedule.while` stops the loop when the worker
reports that no items remain. The snippet uses millisecond-scale spacing so it
finishes quickly in a scratchpad.

##### Variants

For a single worker where only local pacing matters, remove `Schedule.jittered`
and keep the spacing deterministic.

For a larger fleet, keep the jitter even when the base interval is short. The
spacing controls average demand; the jitter reduces alignment between instances.

For long-running workers, make the lifecycle boundary explicit in the fiber,
queue, or service that owns the loop. Keep the spacing policy named so operators
can still see the intended load profile.

##### Notes and caveats

`Effect.repeat` feeds successful values into the schedule. If
`processNextItem` fails, the repeat stops unless you handle or retry that error
separately.

`Schedule.spaced` recurs indefinitely by itself. Pair it with a stop condition
when the loop is meant to finish, or make the owning process lifetime explicit
when the loop is meant to run continuously.

`Schedule.jittered` changes delay timing only. It does not change the work
effect, the success value, or the error channel. Keep randomness in the schedule
so readers can understand the demand-shaping contract from one value.

#### 18.5 Drain a queue slowly

A queue drain is repeat work, not retry work. Run one item, decide whether more
work remains, and let a schedule add the pause before the next item.

##### Problem

A local queue already contains work. Processing everything in a tight loop can
burst against a database, API, or shared worker pool. The drain should make
steady progress, stop when the queue is empty, and cap how much one invocation
can do.

`Queue.take` waits when the queue is empty, so the drain step should check for
available work before taking. The successful step result can then tell
`Effect.repeat` whether another scheduled pass is useful.

##### When to use it

Use this for local buffers, outbox dispatchers, maintenance queues, and
reprocessing backlogs where empty means "this drain pass is done." The repeated
effect should process one item or one small batch and return whether more work
is likely.

##### When not to use it

Do not use this as a long-lived consumer that should block for future messages.
A normal consumer loop can call `Queue.take` and let the queue provide
backpressure.

Do not use the drain schedule to recover from item-processing failures.
`Effect.repeat` schedules successful values. If processing can fail
transiently, retry that item-processing effect separately.

Do not treat `Queue.size` as a transactional reservation in a multi-consumer
queue. It is fine for a single drain worker deciding whether to keep going, but
another consumer can change the size at any time.

##### Schedule shape

Use `Schedule.spaced` for the pause between successful drain steps and combine
it with a recurrence limit such as `Schedule.recurs(99)`. Put the empty-queue
stop condition in `Effect.repeat({ while })`, where it can inspect the
`DrainStep` returned by the effect.

The first item is processed immediately. The schedule controls only the
follow-up drain steps.

##### Example

```ts runnable deterministic
import { Console, Effect, Queue, Schedule } from "effect"

type WorkItem = {
  readonly id: number
  readonly payload: string
}

type DrainStep =
  | { readonly _tag: "Processed"; readonly item: WorkItem; readonly remaining: number }
  | { readonly _tag: "Drained" }

const processItem = (item: WorkItem) => Console.log(`processed item ${item.id}: ${item.payload}`)

const drainOneAvailableItem = Effect.fnUntraced(function*(queue: Queue.Queue<WorkItem>) {
  const queued = yield* Queue.size(queue)

  if (queued === 0) {
    yield* Console.log("queue is empty")
    return { _tag: "Drained" } as const
  }

  const item = yield* Queue.take(queue)
  yield* processItem(item)

  const remaining = yield* Queue.size(queue)
  yield* Console.log(`${remaining} item(s) remain`)

  return { _tag: "Processed", item, remaining } as const
})

const slowDrainPolicy = Schedule.spaced("10 millis").pipe(
  Schedule.both(Schedule.recurs(9))
)

const shouldContinue = (step: DrainStep) => step._tag === "Processed" && step.remaining > 0

const program = Effect.gen(function*() {
  const queue = yield* Queue.unbounded<WorkItem>()
  yield* Queue.offerAll(queue, [
    { id: 1, payload: "refresh-search-index" },
    { id: 2, payload: "publish-outbox-event" },
    { id: 3, payload: "expire-cache-entry" }
  ])

  yield* drainOneAvailableItem(queue).pipe(
    Effect.repeat({
      schedule: slowDrainPolicy,
      while: shouldContinue
    })
  )

  yield* Console.log("drain pass finished")
})

Effect.runPromise(program)
// Output:
// processed item 1: refresh-search-index
// 2 item(s) remain
// processed item 2: publish-outbox-event
// 1 item(s) remain
// processed item 3: expire-cache-entry
// 0 item(s) remain
// drain pass finished
```

The demo uses `10 millis` so it terminates quickly. In production, choose a gap
from the dependency you are protecting, such as a database write budget or API
quota.

##### Variants

For batch drains, process a small batch and return the remaining count. Keep
the same schedule shape: a spacing policy, a count limit, and a stop condition
based on the successful drain result.

For shared queues, move reservation semantics into the queue or database claim
operation. The schedule can pace successful work, but it cannot make `size`
stable across workers.

##### Notes and caveats

`Effect.repeat` feeds successful `DrainStep` values into the repeat decision.
Failures from `processItem` stop the drain unless the processing effect has its
own retry policy.

`Schedule.spaced` waits after a successful iteration completes. `Schedule.fixed`
is different: it follows interval boundaries and may run again immediately if a
previous iteration took longer than the interval.

### 19. Rate Limits and User-Facing Effects

#### 19.1 Send emails with controlled spacing

Email delivery is a user-visible write. Retry timing should be explicit,
bounded, and limited to failures that are safe to retry.

##### Problem

An email provider can fail with timeouts, temporary unavailability, or
rate-limit responses. Immediate retries can exceed quotas, trigger throttling,
or create duplicate-looking messages when the provider accepted the first
request but the response was lost.

The retry policy should show the delay between attempts, the retry count, and
the failure types that are retryable.

##### When to use it

Use this for transactional or notification email where retrying can help:
welcome emails, password resets, invoices, account alerts, and queued
notifications.

It works best when the provider supports a stable idempotency key, message key,
or client reference. That key should identify the logical email and be reused
for every attempt.

##### When not to use it

Do not retry invalid recipients, malformed content, suppressed addresses,
authorization failures, or provider rejections that are clearly permanent.

Do not treat `Schedule.spaced` as an account-wide rate limiter. It spaces this
effect's attempts; queue concurrency and shared quotas still need their own
controls.

##### Schedule shape

Use a small bounded retry policy. `Schedule.spaced("30 seconds")` leaves a
fixed gap between failed attempts, and `Schedule.recurs(3)` allows at most
three retries after the original send. `Effect.retry({ schedule, while })`
applies the schedule only to failures accepted by the predicate.

The first provider call is not delayed.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class EmailDeliveryError extends Data.TaggedError("EmailDeliveryError")<{
  readonly reason:
    | "Timeout"
    | "ProviderUnavailable"
    | "RateLimited"
    | "InvalidRecipient"
    | "RejectedContent"
}> {}

interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly bodyText: string
  readonly idempotencyKey: string
}

interface ProviderMessageId {
  readonly value: string
}

let attempts = 0

const sendViaProvider = (message: EmailMessage) =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`email attempt ${attempts} using key ${message.idempotencyKey}`)

    if (attempts === 1) {
      return yield* Effect.fail(new EmailDeliveryError({ reason: "Timeout" }))
    }

    return { value: `provider-${message.idempotencyKey}` } satisfies ProviderMessageId
  })

const emailRetrySpacing = Schedule.spaced("20 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const isRetryableEmailFailure = (error: EmailDeliveryError): boolean => {
  switch (error.reason) {
    case "Timeout":
    case "ProviderUnavailable":
    case "RateLimited":
      return true
    case "InvalidRecipient":
    case "RejectedContent":
      return false
  }
}

const sendEmailWithControlledSpacing = (message: EmailMessage) =>
  sendViaProvider(message).pipe(
    Effect.retry({
      schedule: emailRetrySpacing,
      while: isRetryableEmailFailure
    })
  )

const program = sendEmailWithControlledSpacing({
  to: "user@example.com",
  subject: "Your report is ready",
  bodyText: "Open the dashboard to view it.",
  idempotencyKey: "email:report-ready:user-123"
}).pipe(
  Effect.tap((receipt) => Console.log(`accepted as ${receipt.value}`))
)

Effect.runPromise(program)
// Output:
// email attempt 1 using key email:report-ready:user-123
// email attempt 2 using key email:report-ready:user-123
// accepted as provider-email:report-ready:user-123
```

The demo uses `20 millis` so it finishes quickly. In production, choose spacing
from provider quota and user experience. The idempotency key belongs to the
logical email, not to a single HTTP attempt.

##### Variants

Interactive flows usually need fewer retries and shorter spacing so the caller
gets a timely answer. Outbox workers can use longer spacing and more attempts
because the user is no longer blocked on the request.

When many workers may retry the same kind of email, add `Schedule.jittered`
after the base spacing. Use jitter for fleet behavior, not when a provider
requires precise minimum spacing.

##### Notes and caveats

`Effect.retry` feeds failures into the schedule. Permanent failures bypass the
schedule when the `while` predicate returns `false`.

`Schedule.recurs(3)` means three retries after the original attempt, not three
total provider calls.

Spacing reduces burstiness; it does not make delivery idempotent. Duplicate
prevention comes from the provider contract and from reusing the same stable
key.

#### 19.2 Respect provider quotas

Provider quotas make retry timing part of the integration contract. Use fixed
spacing when the rule is a minimum gap between attempts.

##### Problem

A provider enforces a documented quota, such as one request per second. Quick
retries after a timeout or `429 Too Many Requests` can violate that quota even
when the code is local and small.

The policy should show the minimum retry spacing, the maximum number of extra
provider calls, and the failures that count as retryable quota or availability
signals.

##### When to use it

Use this when one client, worker, or user-facing path must avoid bursty retries
against a quota-protected provider. It fits idempotent calls such as sending a
notification with a deduplication key, refreshing customer metadata, checking
delivery status, or submitting a provider request with a documented retry
contract.

`Schedule.spaced` is clearest when the provider quota is a steady rate.

##### When not to use it

Do not use a local schedule as a fleet-wide rate limiter. A one-second
`Schedule.spaced` policy spaces one retrying effect, not every fiber, process,
tenant, or deployment sharing the account.

Do not retry permanent failures. Classify errors before the schedule is allowed
to recur.

If the response includes `Retry-After` or a quota reset timestamp, prefer that
provider guidance for the rate-limit case and keep fixed spacing as a fallback.

##### Schedule shape

Combine `Schedule.spaced` with `Schedule.recurs`, then pass a retry predicate to
`Effect.retry`. The schedule controls when another attempt may happen; the
predicate controls whether a failure is allowed to use the schedule.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly status: number
  readonly reason: string
}> {}

interface DeliveryReceipt {
  readonly messageId: string
  readonly accepted: boolean
}

type ProviderRequest = {
  readonly tenantId: string
  readonly messageId: string
  readonly idempotencyKey: string
}

let attempts = 0

const sendProviderMessage = (request: ProviderRequest) =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`provider attempt ${attempts} for ${request.messageId}`)

    if (attempts === 1) {
      return yield* Effect.fail(new ProviderError({ status: 429, reason: "rate limited" }))
    }
    if (attempts === 2) {
      return yield* Effect.fail(new ProviderError({ status: 503, reason: "unavailable" }))
    }

    return { messageId: request.messageId, accepted: true } satisfies DeliveryReceipt
  })

const isRetryableProviderError = (error: ProviderError) =>
  error.status === 408 ||
  error.status === 429 ||
  error.status === 500 ||
  error.status === 502 ||
  error.status === 503 ||
  error.status === 504

const providerQuotaPolicy = Schedule.spaced("20 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const program = sendProviderMessage({
  tenantId: "tenant-123",
  messageId: "message-456",
  idempotencyKey: "tenant-123:message-456"
}).pipe(
  Effect.retry({
    schedule: providerQuotaPolicy,
    while: isRetryableProviderError
  }),
  Effect.tap((receipt) => Console.log(`accepted: ${receipt.accepted}`))
)

Effect.runPromise(program)
// Output:
// provider attempt 1 for message-456
// provider attempt 2 for message-456
// provider attempt 3 for message-456
// accepted: true
```

The original provider call is immediate. Retryable failures are spaced by the
schedule and stop after the retry count is exhausted.

##### Variants

For stricter quotas, choose spacing from the published limit. Twelve requests
per minute implies at least five seconds between attempts for one worker.

For user-facing flows, reduce retry count or add an elapsed budget. For
background work, longer intervals and more attempts may be acceptable when the
provider contract permits them.

For many workers sharing one provider account, keep this as the local retry
shape and add shared admission control around the provider call.

##### Notes and caveats

`Effect.retry` is failure-driven. Successful provider responses end the retry
loop immediately; typed failures are passed to the retry policy.

`Schedule.spaced` is unbounded by itself. Combine it with a retry limit, elapsed
budget, domain predicate, or enclosing workflow lifetime when calling a
third-party API.

A `429` can be retryable when quota will refill soon. A hard quota exhaustion,
invalid API key, or forbidden tenant usually should not retry.

#### 19.3 Space calls to a third-party API

Third-party clients usually need two policies: a steady cadence for normal
traffic and a smaller retry policy around each individual call.

##### Problem

You need to send requests to a provider without starting the next request as
soon as the previous one finishes. The rule should be easy to review: send one
item, wait, then send the next item.

A single request may still need retries for transient failures such as timeouts,
temporary unavailability, or retryable rate-limit responses. Keep that retry
policy separate from the outer spacing policy so provider quota behavior is not
hidden inside call-level failure handling.

Use `Effect.repeat` with `Schedule.spaced(duration)` for the worker cadence, and
use `Effect.retry` around the one provider call when retrying is safe.

##### When to use it

Use this for one worker, fiber, or shard that should avoid back-to-back calls to
a provider. It fits ingestion jobs, webhook delivery, enrichment pipelines, and
partner synchronization where a provider publishes a rough quota such as one
request per second.

Use it when "wait after each completed call" is the intended behavior.
`Schedule.spaced("1 second")` waits after the previous run finishes; slow API
responses naturally reduce the total request rate.

##### When not to use it

Do not treat a local schedule as a global rate limiter. If many processes,
hosts, tenants, or shards share one provider quota, coordinate that quota with
shared admission control.

Do not retry unsafe writes unless the API supports idempotency keys or another
deduplication mechanism. A timeout can mean the provider accepted the request
but the client did not receive the response.

Do not use guessed spacing when the provider gives an exact `Retry-After` value
that must be followed. Classify that response and derive the retry delay from
the provider signal.

##### Schedule shape

The outer policy is `Schedule.spaced(duration)`. With `Effect.repeat`, the first
effect run starts immediately. After a successful run, the schedule waits before
allowing the next recurrence. The time spent inside the provider call is not
subtracted from the delay; this is spacing, not a fixed wall-clock rate.

Add `Schedule.recurs(n)` when the worker should make only `n` additional
successful recurrences. For a long-lived supervised worker, fiber lifetime or a
queue shutdown signal may be the stop condition instead.

##### Example

```ts runnable deterministic
import { Console, Effect, Ref, Schedule } from "effect"

type PartnerEvent = {
  readonly idempotencyKey: string
  readonly payload: string
}

type PartnerError =
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "Rejected"; readonly reason: string }

const events: ReadonlyArray<PartnerEvent> = [
  { idempotencyKey: "event-1", payload: "alpha" },
  { idempotencyKey: "event-2", payload: "bravo" },
  { idempotencyKey: "event-3", payload: "charlie" }
]

const nextEvent = Effect.fnUntraced(function*(cursor: Ref.Ref<number>) {
  const index = yield* Ref.updateAndGet(cursor, (n) => n + 1)
  const event = events[index - 1]

  if (event === undefined) {
    return yield* Effect.fail({ _tag: "NoMoreEvents" } as const)
  }

  yield* Console.log(`next: ${event.idempotencyKey}`)
  return event
})

const postToPartner = Effect.fnUntraced(function*(
  calls: Ref.Ref<number>,
  event: PartnerEvent
) {
  const callNumber = yield* Ref.updateAndGet(calls, (n) => n + 1)
  yield* Console.log(`provider call ${callNumber}: ${event.payload}`)

  if (callNumber === 1) {
    return yield* Effect.fail({ _tag: "Unavailable" } as const)
  }

  return { acceptedId: `accepted-${event.idempotencyKey}` }
})

const isRetryablePartnerError = (error: PartnerError): boolean => error._tag !== "Rejected"

const retryTransientCallFailure = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(2))
)

const sendOneEvent = Effect.fnUntraced(function*(
  cursor: Ref.Ref<number>,
  calls: Ref.Ref<number>
) {
  const event = yield* nextEvent(cursor)
  const response = yield* postToPartner(calls, event).pipe(
    Effect.retry({
      schedule: retryTransientCallFailure,
      while: isRetryablePartnerError
    })
  )
  yield* Console.log(`sent: ${response.acceptedId}`)
})

const program = Effect.gen(function*() {
  const cursor = yield* Ref.make(0)
  const calls = yield* Ref.make(0)

  yield* sendOneEvent(cursor, calls).pipe(
    Effect.repeat(
      Schedule.spaced("25 millis").pipe(
        Schedule.both(Schedule.recurs(2))
      )
    )
  )

  yield* Console.log("done")
})

Effect.runPromise(program)
// Output:
// next: event-1
// provider call 1: alpha
// provider call 2: alpha
// sent: accepted-event-1
// next: event-2
// provider call 3: bravo
// sent: accepted-event-2
// next: event-3
// provider call 4: charlie
// sent: accepted-event-3
// done
```

The worker sends the first event immediately. The first provider call fails
once, so `Effect.retry` retries that same event with short exponential spacing.
Only after the call succeeds does the outer `Schedule.spaced` policy wait before
the worker asks for the next event.

##### Variants

Add jitter when many local workers use the same cadence and exact spacing is not
required. `Schedule.jittered` adjusts each delay between 80% and 120% of the
computed delay, which helps workers avoid moving together.

For a batch job, combine `Schedule.spaced(duration)` with `Schedule.recurs(n)`.
For a stricter provider quota, increase the spacing. For a quota shared across
workers, use a real rate limiter instead of trying to encode fleet-wide quota
accounting in each local repeat schedule.

##### Notes and caveats

`Schedule.spaced` delays recurrences; it does not delay the first call. If the
first call must wait too, sleep or acquire a permit before entering the repeat.

`Effect.repeat` feeds successful values into its schedule. `Effect.retry` feeds
typed failures into its schedule. Keeping those schedules separate makes clear
which policy protects normal traffic and which policy handles transient call
failure.

Classify non-retryable provider responses before retrying. Authentication
errors, validation failures, permanent rejection, and non-idempotent duplicate
risks should fail fast or move the event to a dead-letter path.

#### 19.4 Slow down after a 429 response

HTTP `429 Too Many Requests` is a pacing signal. Treat it differently from
ordinary transient failures so retry timing can follow provider guidance.

##### Problem

An HTTP API sometimes returns `429`. If the response includes a retry-after
signal, the next attempt should honor it. If the signal is missing, the client
should still wait for a conservative fallback delay. Other failures should not
silently inherit the same policy because they have different operational
meaning.

##### When to use it

Use this when the server explicitly says the client is rate limited. Common
sources are a `Retry-After` header, a provider-specific reset header, or a
decoded response field that says when quota should be available again.

This is a good fit for idempotent calls, background sync jobs, polling workers,
and queued writes where waiting is better than turning a temporary quota limit
into a hard failure.

##### When not to use it

Do not use this as a generic HTTP retry policy. A `500` or `503` usually means
the service is unhealthy or overloaded; exponential backoff with jitter and a
short budget is usually a better fit.

Do not retry unsafe non-idempotent requests unless the protocol gives you an
idempotency key or another deduplication guarantee. Slowing down prevents bursts;
it does not make repeated writes safe.

##### Schedule shape

Build the policy around the typed error value:

- classify retryable errors before scheduling
- use `Schedule.identity<ApiError>()` so the schedule output is the latest error
- use `Schedule.modifyDelay` to choose the next delay from that error
- cap retries with `Schedule.recurs(n)`

Normalize provider headers into a `Duration` before constructing the typed
`RateLimited` error. The schedule should consume domain data, not parse raw HTTP
headers.

##### Example

```ts runnable deterministic
import { Console, Duration, Effect, Ref, Schedule } from "effect"

type ApiError =
  | {
    readonly _tag: "RateLimited"
    readonly retryAfter: Duration.Duration | undefined
  }
  | {
    readonly _tag: "ServerUnavailable"
  }

const fallback429Delay = Duration.millis(40)

const retryAfter = (error: ApiError): Duration.Duration =>
  error._tag === "RateLimited" && error.retryAfter !== undefined
    ? error.retryAfter
    : fallback429Delay

const isRateLimited = (error: ApiError): boolean => error._tag === "RateLimited"

const rateLimitPolicy = Schedule.identity<ApiError>().pipe(
  Schedule.while(({ input }) => input._tag === "RateLimited"),
  Schedule.modifyDelay((error) => {
    const delay = retryAfter(error)
    return Console.log(`429 delay: ${Duration.toMillis(delay)}ms`).pipe(
      Effect.as(delay)
    )
  }),
  Schedule.both(Schedule.recurs(4))
)

const callApi = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`HTTP attempt ${attempt}`)

  if (attempt === 1) {
    return yield* Effect.fail(
      {
        _tag: "RateLimited",
        retryAfter: Duration.millis(25)
      } as const
    )
  }

  if (attempt === 2) {
    return yield* Effect.fail(
      {
        _tag: "RateLimited",
        retryAfter: undefined
      } as const
    )
  }

  return { body: "ok" }
})

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const response = yield* callApi(attempts).pipe(
    Effect.retry({
      schedule: rateLimitPolicy,
      while: isRateLimited
    })
  )
  yield* Console.log(`response: ${response.body}`)
})

Effect.runPromise(program)
// Output:
// HTTP attempt 1
// 429 delay: 25ms
// HTTP attempt 2
// 429 delay: 40ms
// HTTP attempt 3
// response: ok
```

The first retry uses the provider's 25 millisecond signal. The second retry uses
the fallback because the simulated response omits `retryAfter`. In production,
use durations that match the provider contract rather than documentation-sized
delays.

##### Variants

If the provider gives an absolute reset time, convert it into a duration at the
HTTP boundary and store that duration on the `RateLimited` error.

If many workers share the same credential, coordinate through a shared limiter.
Only jitter fallback delays when doing so cannot retry before a required
provider minimum.

If the request is user-facing, combine the retry count with a short elapsed-time
budget. Background jobs can usually afford longer spacing than foreground
requests.

##### Notes and caveats

The first call is not delayed. The schedule controls follow-up attempts after
`callApi` fails.

The fallback delay is part of the contract. Without it, a missing retry-after
signal can become a burst of immediate retries, which is what a rate-limit
policy is meant to prevent.

#### 19.5 Coordinate retry and rate-limit handling

Retries and rate limits answer different questions. Classification decides
whether another attempt is allowed; the schedule decides when that attempt may
happen.

##### Problem

An external API can fail in several ways:

- `RateLimited`: retryable, but only after the provider's requested delay
- `ServiceUnavailable`: retryable with ordinary backoff
- `BadRequest`: not retryable; the request must be fixed

The retry policy should make both decisions explicit. `BadRequest` should not
enter the retry schedule. `RateLimited` should wait at least as long as the
provider asked. `ServiceUnavailable` can use normal backoff.

##### Recommended policy

Classify first with `Effect.retry({ while })`. Then use a schedule that can
observe the typed retry input. `Schedule.identity<ApiError>()` exposes the
current failure as the schedule output; `Schedule.modifyDelay` can choose a
delay that matches that failure.

##### Example

```ts runnable deterministic
import { Console, Duration, Effect, Ref, Schedule } from "effect"

type ApiError =
  | {
    readonly _tag: "RateLimited"
    readonly retryAfter: Duration.Duration
  }
  | {
    readonly _tag: "ServiceUnavailable"
  }
  | {
    readonly _tag: "BadRequest"
    readonly reason: string
  }

const isRetryable = (error: ApiError): boolean => error._tag === "RateLimited" || error._tag === "ServiceUnavailable"

const retryPolicy = Schedule.identity<ApiError>().pipe(
  Schedule.both(Schedule.exponential("10 millis")),
  Schedule.modifyDelay(([error], computedDelay) => {
    const delay = error._tag === "RateLimited"
      ? Duration.max(computedDelay, error.retryAfter)
      : computedDelay

    return Console.log(
      `delay for ${error._tag}: ${Duration.toMillis(delay)}ms`
    ).pipe(Effect.as(delay))
  }),
  Schedule.both(Schedule.recurs(5))
)

const callProvider = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`provider attempt ${attempt}`)

  if (attempt === 1) {
    return yield* Effect.fail({ _tag: "ServiceUnavailable" } as const)
  }

  if (attempt === 2) {
    return yield* Effect.fail(
      {
        _tag: "RateLimited",
        retryAfter: Duration.millis(35)
      } as const
    )
  }

  return "provider-ok"
})

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const result = yield* callProvider(attempts).pipe(
    Effect.retry({
      schedule: retryPolicy,
      while: isRetryable
    })
  )
  yield* Console.log(`result: ${result}`)
})

Effect.runPromise(program)
// Output:
// provider attempt 1
// delay for ServiceUnavailable: 10ms
// provider attempt 2
// delay for RateLimited: 35ms
// provider attempt 3
// result: provider-ok
```

This policy allows at most five retries after the original call. Ordinary
service unavailability follows the exponential delay. Rate limits use the larger
of the exponential delay and the provider's `retryAfter` value, so the client
never retries earlier than the rate-limit response requested.

##### Why the pieces are separate

The `while` predicate is the classification boundary. It says which typed errors
are safe to retry. Permanent failures, validation failures, authorization
failures, and unsafe write failures should be rejected there.

The `Schedule` is the timing boundary. It says how retryable failures are paced
after classification has allowed them. Because retry schedules receive failures
as input, timing can still distinguish a rate-limit response from a server
unavailable response.

`Schedule.both` combines the typed input schedule with exponential backoff. The
combined schedule recurs only while both sides recur, and it uses the maximum of
their delays. `Schedule.recurs(5)` adds a hard retry count.

##### Variants

If provider guidance must be followed exactly, use a schedule whose base delay
does not add extra backoff for `RateLimited` errors. If many clients may retry
together, add jitter only after deciding whether the provider contract allows
it.

If the operation is user-facing, combine the retry count with a time budget such
as `Schedule.during("10 seconds")` so callers get a bounded response. Background
workers can use longer budgets with clear logging around the rate-limited path.

##### Notes and caveats

`Effect.retry` schedules typed failures from the error channel. It does not turn
defects or interruptions into retryable errors.

The first call is not delayed. The schedule controls waits between retry
attempts after a failure.

`Schedule.modifyDelay` replaces the delay chosen by the schedule. Use it when
the rate-limit delay should be compared with, or override, computed backoff. Use
`Schedule.addDelay` when provider delay should be added on top of an existing
delay.

Retries do not make side effects safe. For writes, classification must account
for idempotency keys, deduplication, or another domain guarantee before any
schedule is applied.

### 20. Jitter Concepts and Tradeoffs

#### 20.1 Thundering herds

Use jitter when many clients, workers, service instances, or fibers might
otherwise retry or poll on the same cadence.

##### Problem

A thundering herd is a burst created when many actors react to the same event at
the same time. Deploys, restarts, cache expiry, outage recovery, rate limits, and
shared transient errors can all synchronize clients. A fixed delay that is mild
for one caller can become a sharp load wave across a fleet.

##### When to use it

Use it when the same schedule can run in many places at once: reconnecting
clients, workers polling a shared queue, dashboard refreshes, health checks,
cache refills, or retries after a dependency outage.

Decide the base shape first, then add jitter. For example, keep
`Schedule.exponential("100 millis")` as the retry shape or
`Schedule.spaced("5 seconds")` as the polling shape, then apply
`Schedule.jittered`.

##### When not to use it

Do not use jitter to hide unsafe retries. Non-idempotent writes, authorization
failures, validation failures, and malformed requests should be classified
before retrying.

Avoid jitter when exact timing is the requirement, such as protocol heartbeats,
batch windows, deterministic tests, or user-facing countdowns.

##### Schedule shape

`Schedule.jittered` modifies the delay produced by another schedule. In Effect,
each delay is randomly adjusted between 80% and 120% of the original delay. It
does not decide what is retryable, how often to stop, or how many attempts are
allowed. Compose those decisions separately:

- `Schedule.exponential` or `Schedule.spaced` describes the base cadence
- `Schedule.recurs` or `Schedule.during` bounds the recurrence
- `Schedule.jittered` spreads wake-ups around the base cadence

##### Example

```ts runnable
import { Console, Effect, Schedule } from "effect"

type ApiError = {
  readonly _tag: "ServiceUnavailable"
  readonly client: string
  readonly attempt: number
}

const retryWithoutHerding = Schedule.exponential("20 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const runClient = (client: string) => {
  let attempts = 0

  const fetchSharedResource = Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`${client} attempt ${attempts}`)

    if (attempts < 3) {
      return yield* Effect.fail<ApiError>({
        _tag: "ServiceUnavailable",
        client,
        attempt: attempts
      })
    }

    return `${client} loaded the resource`
  })

  return fetchSharedResource.pipe(
    Effect.retry(retryWithoutHerding),
    Effect.flatMap(Console.log)
  )
}

const program = Effect.forEach(
  ["client-a", "client-b", "client-c"],
  runClient,
  { concurrency: 3, discard: true }
)

Effect.runPromise(program)
// Output may vary: jitter and concurrent clients can change ordering
// client-a attempt 1
// client-b attempt 1
// client-c attempt 1
// client-c attempt 2
// client-b attempt 2
// client-a attempt 2
// client-b attempt 3
// client-b loaded the resource
// client-c attempt 3
// client-c loaded the resource
// client-a attempt 3
// client-a loaded the resource
```

The first attempt for each client runs immediately. If a client fails, the
exponential schedule controls the retry shape and `Schedule.jittered` prevents
every client from sleeping for exactly the same delay.

##### Variants

For polling, jitter a `Schedule.spaced` repeat policy. For outage recovery,
combine exponential backoff, jitter, and an elapsed budget. For a hard
maximum-delay guarantee, apply jitter before the final `Schedule.modifyDelay`
cap.

##### Notes and caveats

Jitter reduces synchronization; it does not reduce the total number of attempts.
Keep attempt limits, elapsed-time budgets, rate limits, and error classification
visible near the effect being retried.

Because jitter changes timing randomly, logs and metrics should be read as
ranges around the base policy rather than exact timestamps.

#### 20.2 Coordinated clients

Use jitter when clients share a start signal and would otherwise make follow-up
calls as one wave.

##### Problem

Coordinated clients start from the same signal and keep following the same
cadence. A deploy, cache expiry, feature flag flip, or upstream outage can make
hundreds of clients fail or poll together. If all of them retry after exactly
`100 millis`, then `200 millis`, then `400 millis`, a policy that is polite for
one client becomes noisy for the service receiving all of them.

##### When to use it

Use it for browser reconnects, service instances retrying the same dependency,
workers polling jobs created in batches, and scheduled processes released or
restarted together. The more actors share the cadence, the more useful jitter
becomes.

##### When not to use it

Do not add jitter when exact timing is the product or protocol requirement. A
metronomic heartbeat, fixed billing boundary, or protocol timeout may need a
predictable `Schedule.fixed` or `Schedule.spaced` cadence.

Do not use jitter to disguise errors that should not be retried. Classify
validation failures, authorization failures, malformed requests, and unsafe
non-idempotent writes before applying the schedule.

##### Schedule shape

Choose the deterministic shape first, then jitter it:

1. Start with the cadence: `Schedule.exponential`, `Schedule.spaced`, or another
   base schedule.
2. Apply `Schedule.jittered` so each recurrence delay is spread around that
   cadence.
3. Add limits such as `Schedule.recurs` or `Schedule.during`.

That order keeps the policy readable: exponential retry, jittered, bounded.

##### Example

```ts runnable
import { Console, Effect, Schedule } from "effect"

type ClientError = {
  readonly _tag: "ClientError"
  readonly client: string
  readonly attempt: number
}

const clientRetry = Schedule.exponential("25 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5))
)

const makeClientCall = (client: string) => {
  let attempts = 0

  const call = Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`${client} call ${attempts}`)

    if (attempts < 3) {
      return yield* Effect.fail<ClientError>({
        _tag: "ClientError",
        client,
        attempt: attempts
      })
    }

    return `${client} done`
  })

  return call.pipe(
    Effect.retry(clientRetry),
    Effect.flatMap(Console.log)
  )
}

const program = Effect.forEach(
  ["browser-a", "browser-b", "browser-c"],
  makeClientCall,
  { concurrency: 3, discard: true }
)

Effect.runPromise(program)
// Output may vary: jitter and concurrent clients can change ordering
// browser-a call 1
// browser-b call 1
// browser-c call 1
// browser-a call 2
// browser-b call 2
// browser-c call 2
// browser-a call 3
// browser-a done
// browser-b call 3
// browser-b done
// browser-c call 3
// browser-c done
```

Each client has the same retry policy, but each recurrence samples its own
jittered delay. The policy remains easy to review because the base cadence,
jitter, and retry limit are all visible.

##### Variants

Use `Schedule.exponential(...).pipe(Schedule.jittered)` for retries after
failures. Use `Schedule.spaced(...).pipe(Schedule.jittered)` for polling. Pair
jitter with `Schedule.recurs` for count limits or `Schedule.during` for
elapsed-time budgets.

##### Notes and caveats

`Effect.retry` feeds failures into the schedule. `Effect.repeat` feeds
successful values into the schedule. That distinction matters when adding
predicates: retry policies usually inspect errors, while polling policies
usually inspect returned statuses.

Jitter reduces accidental coordination; it is not fairness or rate limiting. If
the downstream system needs a strict cap, use a rate limiter, queue, or server
side backpressure mechanism.

#### 20.3 Recovery spikes

Use jittered backoff after an outage so recovery traffic spreads out instead of
forming synchronized retry waves.

##### Problem

Recovery can become its own incident. If every process uses the same
deterministic retry sequence, retry waves can line up across the fleet just as a
dependency is trying to recover.

The first attempt still happens normally. The schedule only decides what to do
after a typed failure is fed to `Effect.retry`.

##### When to use it

Use it when many clients, workers, pods, or service instances retry the same
dependency after broker restarts, database failovers, network partitions,
rollbacks, or regional control-plane incidents.

This is a good default when the operation is safe to retry and the downstream
system benefits from recovery traffic being spread out.

##### When not to use it

Do not use jitter to make unsafe writes retryable. Classify validation errors,
authorization errors, malformed requests, and non-idempotent operations before
applying the schedule.

Avoid jitter when timing itself is the contract, such as a fixed-rate heartbeat
that another system interprets precisely.

##### Schedule shape

Build the operational shape first, then jitter it:

- `Schedule.exponential("200 millis")` creates the increasing recovery delay
- `Schedule.jittered` spreads each computed delay by 80% to 120%
- `Schedule.both(Schedule.recurs(6))` stops after a bounded number of retries

##### Example

```ts runnable
import { Console, Data, Effect, Schedule } from "effect"

class DependencyUnavailable extends Data.TaggedError("DependencyUnavailable")<{
  readonly service: string
  readonly instance: string
  readonly attempt: number
}> {}

const recoveryRetryPolicy = Schedule.exponential("30 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(6))
)

const recoverInstance = (instance: string) => {
  let attempts = 0

  const refreshFromDependency = Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`${instance} refresh attempt ${attempts}`)

    if (attempts < 3) {
      return yield* Effect.fail(
        new DependencyUnavailable({
          service: "orders-db",
          instance,
          attempt: attempts
        })
      )
    }

    return `${instance} recovered`
  })

  return refreshFromDependency.pipe(
    Effect.retry(recoveryRetryPolicy),
    Effect.flatMap(Console.log)
  )
}

const program = Effect.forEach(
  ["instance-a", "instance-b", "instance-c"],
  recoverInstance,
  { concurrency: 3, discard: true }
)

Effect.runPromise(program)
// Output may vary: jitter and concurrent clients can change ordering
// instance-a refresh attempt 1
// instance-b refresh attempt 1
// instance-c refresh attempt 1
// instance-a refresh attempt 2
// instance-c refresh attempt 2
// instance-b refresh attempt 2
// instance-c refresh attempt 3
// instance-c recovered
// instance-a refresh attempt 3
// instance-a recovered
// instance-b refresh attempt 3
// instance-b recovered
```

Each instance keeps the same general backoff shape, but its individual delays
are randomly adjusted. The fleet no longer has to retry on identical boundaries
during recovery.

##### Variants

Use a smaller base delay when the dependency is local and cheap to probe. Use a
larger base delay when the dependency is expensive to warm up or has strict rate
limits. Add `Schedule.during` when the retry policy needs an elapsed recovery
budget.

##### Notes and caveats

Jitter is not a rate limiter. It spreads retry timing, but it does not enforce a
global concurrency limit or coordinate work across processes. Combine it with
downstream limits when the system needs hard protection.

#### 20.4 Add jitter to exponential backoff

Add jitter to exponential backoff when multiple callers can fail together and
retry the same dependency.

##### Problem

Exponential backoff reduces retry pressure over time, but callers that start
together can still retry together: 100 milliseconds later, 200 milliseconds
later, 400 milliseconds later, and so on.

Place `Schedule.jittered` after the exponential schedule. It keeps the
exponential shape and randomizes each delay between 80% and 120% of the delay
chosen by `Schedule.exponential`.

##### When to use it

Use jittered exponential backoff for idempotent HTTP requests, queue operations,
cache lookups, database calls, and service-to-service requests where many
fibers, workers, or service instances may retry together.

The larger the caller population, the more important it is to avoid identical
retry times.

##### When not to use it

Do not use jitter as a stopping condition. Add `Schedule.recurs`, `times`, an
elapsed-time limit, or another bound when the retry policy must be finite.

Do not use jitter when exact timing is required. For deterministic tests, either
avoid jitter or assert bounds instead of exact delays.

##### Schedule shape

With a 10 millisecond base, exponential backoff produces 10 milliseconds, 20
milliseconds, 40 milliseconds, and 80 milliseconds. After `Schedule.jittered`,
those delays become ranges: 8-12 milliseconds, 16-24 milliseconds, 32-48
milliseconds, and 64-96 milliseconds.

`Schedule.both(Schedule.recurs(4))` adds a finite retry count without changing
the jittered delay.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class GatewayUnavailable extends Data.TaggedError("GatewayUnavailable")<{
  readonly status: number
}> {}

let attempts = 0

const callGateway: Effect.Effect<string, GatewayUnavailable> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`gateway attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(new GatewayUnavailable({ status: 503 }))
  }

  return "gateway response"
})

const jitteredBackoff = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const program = callGateway.pipe(
  Effect.retry(jitteredBackoff),
  Effect.tap((value) => Console.log(`success: ${value}`))
)

Effect.runPromise(program).then(() => undefined, console.error)
// Output:
// gateway attempt 1
// gateway attempt 2
// gateway attempt 3
// gateway attempt 4
// success: gateway response
```

The original call runs immediately. Each retry uses the exponential delay as a
base and then jitters that delay. If all four retries fail, the last typed
`GatewayUnavailable` is propagated.

##### Variants

Use a smaller base delay for latency-sensitive work. Use a gentler exponential
factor, such as `1.5`, when doubling grows too quickly.

When only some typed failures should be retried, pass `Effect.retry({ schedule,
while })`. The predicate controls retry eligibility; the schedule controls
timing and count.

##### Notes and caveats

`Schedule.jittered` does not take a percentage argument. Effect uses the fixed
80% to 120% range.

Place jitter after the delay shape you want to randomize. Additional composition
can then add limits, caps, predicates, or observability around the jittered
backoff.

Jitter spreads retry attempts, but it does not cap exponential growth. Long
retry policies still need a cap and a retry limit that match the caller's
budget.

#### 20.5 Avoid synchronized retries in clustered systems

Clustered callers need retry policies that avoid sending every node back to the
same dependency at the same instant.

##### Problem

Nodes, pods, workers, or service clients can observe the same failure at roughly
the same time. A shared fixed delay or identical exponential policy can then
create retry waves on the same boundaries.

Add `Schedule.jittered` to the retry schedule. Each caller keeps the same broad
backoff shape, but waits a slightly different amount before retrying.

##### When to use it

Use this when the same retry policy may run concurrently in many places:
service replicas, queue consumers, background workers, cluster members, or many
fibers calling the same downstream dependency.

It fits temporary leader unavailability, rolling restarts, short network
partitions, overload responses, and connection pool exhaustion.

##### When not to use it

Do not use jitter as the only protection for a cluster that can generate more
retry traffic than the dependency can handle. Jitter reduces alignment, not the
number of callers.

Do not add jitter to hide an unbounded or overly aggressive policy. Cluster
retry policies still need retry limits, timeouts, queue boundaries, circuit
breakers, rate limits, or other operational bounds where appropriate.

##### Schedule shape

`Schedule.exponential("15 millis")` produces 15 milliseconds, 30 milliseconds,
60 milliseconds, and so on. `Schedule.jittered` changes those to ranges around
each base delay. `Schedule.recurs(4)` stops each caller after four retries.

The first execution is not delayed. The schedule is consulted only after a
typed failure.

##### Example

```ts runnable
import { Console, Data, Effect, Schedule } from "effect"

class ClusterRequestError extends Data.TaggedError("ClusterRequestError")<{
  readonly nodeId: string
  readonly reason: "Unavailable" | "Overloaded" | "Partitioned" | "InvalidRequest"
}> {}

const isRetryableClusterError = (error: ClusterRequestError) =>
  error.reason === "Unavailable" ||
  error.reason === "Overloaded" ||
  error.reason === "Partitioned"

const clusteredRetryPolicy = Schedule.exponential("15 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const heartbeatProgram = (nodeId: string) => {
  let attempts = 0

  const sendHeartbeat: Effect.Effect<void, ClusterRequestError> = Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`${nodeId}: heartbeat attempt ${attempts}`)

    if (attempts < 3) {
      return yield* Effect.fail(
        new ClusterRequestError({
          nodeId,
          reason: "Overloaded"
        })
      )
    }

    yield* Console.log(`${nodeId}: heartbeat accepted`)
  })

  return sendHeartbeat.pipe(
    Effect.retry({
      schedule: clusteredRetryPolicy,
      while: isRetryableClusterError
    })
  )
}

const program = Effect.all([
  heartbeatProgram("node-a"),
  heartbeatProgram("node-b"),
  heartbeatProgram("node-c")
], { concurrency: "unbounded", discard: true })

Effect.runPromise(program).then(() => undefined, console.error)
// Output may vary: jitter and concurrent workers can change ordering
// node-a: heartbeat attempt 1
// node-b: heartbeat attempt 1
// node-c: heartbeat attempt 1
// node-a: heartbeat attempt 2
// node-b: heartbeat attempt 2
// node-c: heartbeat attempt 2
// node-a: heartbeat attempt 3
// node-a: heartbeat accepted
// node-b: heartbeat attempt 3
// node-b: heartbeat accepted
// node-c: heartbeat attempt 3
// node-c: heartbeat accepted
```

Each node starts immediately and retries transient cluster errors with the same
base policy. Jitter spreads the retry delays, so the nodes are less likely to
retry in one coordinated burst.

##### Variants

For a clustered operation with a steady retry cadence, jitter `Schedule.spaced`
instead of `Schedule.exponential`.

For a capped policy, compose the cap first and then add `Schedule.jittered` if
the capped delay should also be spread. A capped base delay of 5 seconds becomes
a jittered delay between 4 and 6 seconds.

##### Notes and caveats

`Schedule.jittered` uses Effect's fixed 80% to 120% range.

Jitter changes retry timing, not retry eligibility. Keep using `while` or
`until` predicates when only some typed failures should be retried.

`Schedule.recurs(4)` means four retries after the original attempt, not four
total executions.

#### 20.6 More stability, less predictability

Jitter keeps the base cadence visible while making each individual delay
approximate. The point is to protect aggregate load, not to make one caller more
precise.

##### Problem

Many clients, workers, or service instances can start the same schedule at the
same time after a deploy, outage, or restart. Without jitter, they can also wake
up together and send a burst of retries, cache refreshes, or polls to the same
dependency.

The policy should weaken that alignment without hiding the intended cadence.
Operators can still describe the base delay and the jitter range; they should
not expect every caller to wake at the exact same offset.

##### When to use it

Use jitter when aggregate load matters more than exact per-caller timing:

- retries from many clients after a transient outage
- cache warming from multiple application instances
- polling loops that would otherwise hit a service on the same boundary
- reconnect loops after a broker, database, or gateway interruption

This fits idempotent operations, where repeating the same request does not
change correctness. The schedule still needs a count limit, time budget, or
external lifetime when the workflow must stop.

##### When not to use it

Do not use jitter when exact timing is part of the requirement. Fixed reporting
windows, protocol heartbeats with strict deadlines, tests that assert precise
delays, and workflows coordinated by a shared clock usually need deterministic
timing.

Do not use jitter to make unsafe retries safe. Retried writes still need
idempotency, deduplication, transactions, or another domain-level guarantee.
Jitter changes when the next attempt happens; it does not change whether the
attempt is valid.

##### Schedule shape

Start with the cadence you would have used without jitter, then apply
`Schedule.jittered`. For example, adding `Schedule.jittered` after
`Schedule.spaced("1 second")` still says "one second between recurrences", but
each one-second delay is randomized to roughly 800 milliseconds through 1.2
seconds.

For an exponential policy, each computed exponential delay is jittered:

| Base delay | Jittered delay range |
| ---------- | -------------------- |
| 200 ms     | 160-240 ms           |
| 400 ms     | 320-480 ms           |
| 800 ms     | 640-960 ms           |
| 1.6 s      | 1.28-1.92 s          |

The benefit is smoother aggregate load. The tradeoff is less exact timing for
any one fiber or process.

##### Example

```ts runnable deterministic
import { Console, Effect, Random, Ref, Schedule } from "effect"

type GatewayError = {
  readonly _tag: "GatewayError"
  readonly attempt: number
}

const refreshPolicy = Schedule.spaced("20 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3))
)

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)

  const refreshCacheEntry: Effect.Effect<string, GatewayError> = Effect.gen(
    function*() {
      const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
      yield* Console.log(`refresh attempt ${attempt}`)

      if (attempt < 3) {
        return yield* Effect.fail({ _tag: "GatewayError", attempt } as const)
      }

      return "cache refreshed"
    }
  )

  const result = yield* refreshCacheEntry.pipe(
    Effect.retry(refreshPolicy),
    Random.withSeed("cache-refresh-demo")
  )

  yield* Console.log(result)
})

Effect.runPromise(program)
// Output:
// refresh attempt 1
// refresh attempt 2
// refresh attempt 3
// cache refreshed
```

`program` runs the cache refresh immediately, then retries around a 20
millisecond cadence instead of exactly every 20 milliseconds. The seeded random
service makes the demo reproducible; production code usually uses the default
random service.

##### Variants

For transient service failures, combine exponential backoff with jitter. That
keeps the exponential shape while avoiding synchronized retry bursts around each
step.

For periodic background work, jitter the steady cadence. This is useful when
many instances may poll approximately every 30 seconds, but the service should
not receive all polls on the same boundary.

##### Notes and caveats

`Schedule.jittered` does not accept a custom percentage. The implementation in
`packages/effect/src/Schedule.ts` adjusts each delay between 80% and 120% of the
original delay.

Jitter changes only delays. It preserves the schedule output, input handling,
and stopping behavior. Add `Schedule.recurs`, `Schedule.take`,
`Schedule.during`, or another limit when the policy must be finite.

With `Effect.retry`, the first attempt is not delayed. Jitter applies to waits
between retry attempts after typed failures. With `Effect.repeat`, jitter
applies to waits between successful repetitions.

For tests, avoid asserting an exact jittered delay. Either keep the schedule
deterministic in that test or assert the allowed bounds.

#### 20.7 When not to add jitter

Jitter is useful for desynchronizing callers, but it is the wrong tool when exact
timing is part of the contract.

##### Problem

Before applying `Schedule.jittered`, decide what readers may rely on: an exact
cadence, or an approximate cadence around a base delay. A randomized recurrence
may run earlier or later than the wrapped schedule would, so it should be a
deliberate load-shaping choice.

##### When to use it

Skip jitter when the exact delay is meaningful:

- a protocol heartbeat, maintenance tick, or sampling loop must run at a known
  cadence
- a test needs deterministic virtual-time advancement
- a user-visible retry, refresh, or progress check should feel predictable
- a small single-instance loop has no fleet-wide synchronization problem

In those cases, use the schedule that states the real timing requirement:
`Schedule.fixed` for wall-clock cadence, `Schedule.spaced` for a gap after work
finishes, `Schedule.exponential` for deterministic backoff, and
`Schedule.recurs`, `Schedule.take`, or `Schedule.during` for visible bounds.

##### When not to use it

Do not add `Schedule.jittered` just because a schedule repeats. A single worker
that drains a local queue every second does not need random timing unless it is
competing with other workers or protecting a shared dependency. A UI path that
promises "try again in 5 seconds" should not sometimes wait 4 seconds and
sometimes 6 seconds. A test that advances `TestClock` by exact intervals should
not depend on a randomized delay range.

Also avoid jitter when the schedule is documenting an external contract. Cron
boundaries, billing windows, lease renewals, and protocol timeouts usually need
predictability more than desynchronization.

##### Schedule shape

Choose the deterministic shape first and leave it unjittered when precision is
the requirement. Use `Schedule.fixed` for wall-clock cadence, `Schedule.spaced`
for a gap after work finishes, `Schedule.exponential` for deterministic backoff,
and `Schedule.recurs`, `Schedule.take`, or `Schedule.during` for visible bounds.

##### Example

```ts runnable deterministic
import { Console, Effect, Ref, Schedule } from "effect"

const predictableStatusPolling = Schedule.spaced("50 millis").pipe(
  Schedule.take(3)
)

const program = Effect.gen(function*() {
  const polls = yield* Ref.make(0)

  const pollUserVisibleStatus = Ref.updateAndGet(polls, (n) => n + 1).pipe(
    Effect.tap((poll) => Console.log(`poll ${poll}: status is still visible`)),
    Effect.as("visible")
  )

  const finalRecurrence = yield* pollUserVisibleStatus.pipe(
    Effect.repeat(predictableStatusPolling)
  )

  yield* Console.log(`stopped after recurrence ${finalRecurrence}`)
})

Effect.runPromise(program)
// Output:
// poll 1: status is still visible
// poll 2: status is still visible
// poll 3: status is still visible
// poll 4: status is still visible
// stopped after recurrence 3
```

The loop uses a deterministic gap and a deterministic stop condition. Adding
`Schedule.jittered` would change the user-visible rhythm without improving
safety for this single-user workflow.

##### Variants

For tests, prefer deterministic schedules and advance virtual time by the exact
delay the schedule promises. Test jittered policies separately by asserting
that delays stay within Effect's `80%` to `120%` jitter range instead of
asserting one exact delay.

For exact wall-clock cadence, prefer `Schedule.fixed`. For "wait this long
after the previous run finishes", prefer `Schedule.spaced`. For a small
single-instance loop, start with the simplest deterministic cadence and add
jitter only after there is an actual coordination or downstream-load problem.

##### Notes and caveats

`Schedule.jittered` changes only the recurrence delay. It does not change which
errors are retryable, when a schedule stops, or whether a repeated operation is
safe. If the problem is overload, quota enforcement, or too many concurrent
callers, jitter may be one useful tool, but it is not a replacement for limits,
classification, or admission control.

### 21. Jitter in Real Systems

#### 21.1 Jittered retries for HTTP clients

Use jittered retries when many HTTP clients may see the same transient failure
and retry at nearly the same time. `Schedule.jittered` keeps the chosen retry
shape visible while spreading each retry delay across a small random range.

##### Problem

An HTTP call can fail because a gateway is overloaded, a request times out, or a
server returns `408`, `429`, or `5xx`. Retrying can help, but only when the
request is safe to repeat. For writes, "safe" usually means idempotent: running
the same request more than once has the same external effect as running it once.

##### When to use it

Use it for service-to-service calls, background delivery, and webhooks where a
shared outage can affect many callers. Keep error classification close to the
HTTP operation so the retry policy only sees failures that are worth retrying.

##### When not to use it

Do not retry validation errors, malformed requests, authentication failures, or
ordinary `4xx` responses. Do not blindly retry a `POST` that charges a card,
sends an email, or creates external state unless it carries an idempotency key or
another deduplication guarantee.

Jitter also does not replace explicit rate-limit handling. If the server returns
a `Retry-After` value, prefer that server-provided delay for that response.

##### Schedule shape

Choose the backoff first, then add jitter. `Schedule.exponential("100 millis")`
produces increasing delays. `Schedule.jittered` modifies each selected delay to
a random value between 80% and 120% of the original delay. Add
`Schedule.recurs` or a time budget so the retry is bounded.

##### Example

```ts runnable deterministic
import { Data, Effect, Schedule } from "effect"

type HttpMethod = "GET" | "HEAD" | "PUT" | "DELETE" | "POST"

class HttpError extends Data.TaggedError("HttpError")<{
  readonly method: HttpMethod
  readonly status: number
  readonly idempotencyKey?: string
}> {}

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500

const isRetrySafe = (error: HttpError) =>
  isRetryableStatus(error.status) &&
  (
    error.method === "GET" ||
    error.method === "HEAD" ||
    error.method === "PUT" ||
    error.method === "DELETE" ||
    error.idempotencyKey !== undefined
  )

let attempt = 0

const getProfile = Effect.gen(function*() {
  attempt += 1
  yield* Effect.sync(() => console.log(`GET /profile attempt ${attempt}`))

  if (attempt < 3) {
    return yield* Effect.fail(
      new HttpError({ method: "GET", status: 503 })
    )
  }

  return { id: 123, name: "Ada" }
})

const httpRetryPolicy = Schedule.exponential("20 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5))
)

const program = getProfile.pipe(
  Effect.retry({
    schedule: httpRetryPolicy,
    while: isRetrySafe
  }),
  Effect.tap((profile) => Effect.sync(() => console.log(`loaded ${profile.name}`)))
)

Effect.runPromise(program)
// Output:
// GET /profile attempt 1
// GET /profile attempt 2
// GET /profile attempt 3
// loaded Ada
```

##### Variants

For user-facing calls, use fewer retries or a short elapsed-time budget so the
caller gets a timely answer. For background delivery, use a larger base delay
and retry limit, but keep a clear handoff to a dead-letter queue, alert, or
operator-visible failed state.

For writes, keep the safety check stricter than the timing check. Retrying a
`POST` can be reasonable when the downstream service honors an idempotency key.
Without that guarantee, surface the failure instead of risking duplicate side
effects.

##### Notes and caveats

`Effect.retry` runs the original request immediately. Jitter affects only waits
between retries after typed failures.

`Schedule.jittered` changes delay only. Keep retry classification, maximum retry
count, and any total time budget explicit.

#### 21.2 Jittered retries for Redis reconnects

Use jittered retries for Redis reconnect loops that may run across many workers
at once. Pick the reconnect backoff first, then jitter the delay so workers do
not all reconnect on the same boundary.

##### Problem

A worker loses its Redis connection during a restart, failover, or short network
drop. It should reconnect quickly at first, back off after repeated failures,
and stop after a bounded number of attempts so the supervisor can report a real
outage.

##### When to use it

Use it for workers, stream consumers, subscription listeners, cache warmers, and
queue processors where reconnecting is expected. It is most useful when many
instances share the same Redis cluster.

##### When not to use it

Do not retry configuration errors. A bad Redis URL, missing credentials, TLS
misconfiguration, or an unsupported protocol setting should fail fast and be
reported as an operational problem.

Do not use reconnect backoff as a substitute for connection limits,
health-checking, or graceful shutdown. The schedule controls timing only; it
does not decide whether the process should keep accepting work while Redis is
unavailable.

##### Schedule shape

`Schedule.exponential("100 millis")` gives the reconnect loop a short first
delay and doubles the delay after each failed reconnect. `Schedule.jittered`
then randomizes each computed delay between `80%` and `120%` of that delay.

Apply a cap after jitter if the final sleep must never exceed a configured
maximum. Keep the retry count separate from the delay shape:
`Schedule.recurs(8)` means at most eight retries after the original reconnect
attempt.

##### Example

```ts runnable deterministic
import { Data, Duration, Effect, Schedule } from "effect"

class RedisReconnectError extends Data.TaggedError("RedisReconnectError")<{
  readonly reason: "timeout" | "connection-refused" | "server-loading"
}> {}

let attempt = 0

const reconnectRedis = Effect.gen(function*() {
  attempt += 1
  yield* Effect.sync(() => console.log(`redis reconnect attempt ${attempt}`))

  if (attempt < 4) {
    return yield* Effect.fail(
      new RedisReconnectError({ reason: "server-loading" })
    )
  }

  yield* Effect.sync(() => console.log("redis reconnected"))
})

const redisReconnectPolicy = Schedule.exponential("20 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(120)))),
  Schedule.both(Schedule.recurs(8))
)

const program = reconnectRedis.pipe(
  Effect.retry(redisReconnectPolicy)
)

Effect.runPromise(program)
// Output:
// redis reconnect attempt 1
// redis reconnect attempt 2
// redis reconnect attempt 3
// redis reconnect attempt 4
// redis reconnected
```

##### Variants

For a startup path, keep the first delay small but use a short retry limit so the
service can fail readiness quickly when Redis is not reachable.

For a long-running background worker, use a larger retry limit or combine the
policy with `Schedule.during` to express an elapsed reconnect budget. That gives
operators a concrete answer to how long the worker will keep trying before it
surfaces the failure.

For a large fleet, keep jitter enabled even when the cap is low. The cap limits
maximum wait time; jitter reduces synchronization.

##### Notes and caveats

`Effect.retry` feeds the `RedisReconnectError` into the schedule after a failed
reconnect attempt. The schedule decides whether to try again and how long to
sleep before that next attempt.

`Schedule.exponential` recurs forever by itself. Always pair it with a limit
such as `Schedule.recurs`, `Schedule.take`, `Schedule.during`, or a predicate
that stops on non-retryable Redis errors.

Apply `Schedule.jittered` to the chosen cadence rather than hiding randomness in
the reconnect effect. Keeping jitter in the schedule makes the retry contract
reviewable: exponential backoff for pressure, a cap for maximum sleep, and
jitter for fleet-wide spreading.

#### 21.3 Jittered retries for WebSocket reconnect

Use a bounded, jittered backoff when many WebSocket clients may reconnect after
the same gateway restart, network flap, or load-balancer rotation.

##### Problem

A reconnect loop should recover from transient close or connect failures without
leaving a user-facing client in an indefinite "reconnecting" state. The policy
must show which failures are retryable, how the delay grows, and where the loop
stops.

##### When to use it

Use this recipe when reconnecting an idempotent WebSocket session after
transient network or server conditions: temporary gateway unavailability,
connection reset, abnormal close, server overload, or a rolling restart.

It is especially useful when many clients run the same reconnect code: browser
tabs, mobile apps, desktop clients, edge workers, or service replicas that keep
long-lived sockets open.

##### When not to use it

Do not retry authentication, authorization, protocol, or validation failures as
if they were transient. An expired token should usually refresh credentials
first. A forbidden user, unsupported protocol version, malformed URL, or rejected
subprotocol should fail in the domain layer before the reconnect schedule is
used.

Do not treat jitter as admission control. Jitter spreads reconnect attempts, but
it does not reduce the number of clients that will try. Large fleets still need
server-side limits, connection draining, backpressure, and user-visible fallback
states.

##### Schedule shape

Start with exponential backoff, apply `Schedule.jittered`, cap the final delay
with `Schedule.modifyDelay`, and add a retry limit with `Schedule.recurs`.
`Schedule.jittered` adjusts each computed delay between 80% and 120% of the
wrapped schedule's delay. A 1 second reconnect delay therefore becomes 800
milliseconds to 1.2 seconds.

##### Example

```ts runnable deterministic
import { Data, Duration, Effect, Schedule } from "effect"

class WebSocketConnectError extends Data.TaggedError("WebSocketConnectError")<{
  readonly reason:
    | "AbnormalClose"
    | "GatewayUnavailable"
    | "NetworkError"
    | "ServerOverloaded"
    | "Unauthorized"
    | "UnsupportedProtocol"
}> {}

const isRetryableReconnectError = (error: WebSocketConnectError): boolean => {
  switch (error.reason) {
    case "AbnormalClose":
    case "GatewayUnavailable":
    case "NetworkError":
    case "ServerOverloaded":
      return true
    case "Unauthorized":
    case "UnsupportedProtocol":
      return false
  }
}

let attempt = 0

const connectWebSocket = Effect.gen(function*() {
  attempt += 1
  yield* Effect.sync(() => console.log(`websocket connect attempt ${attempt}`))

  if (attempt === 1) {
    return yield* Effect.fail(
      new WebSocketConnectError({ reason: "GatewayUnavailable" })
    )
  }
  if (attempt === 2) {
    return yield* Effect.fail(
      new WebSocketConnectError({ reason: "NetworkError" })
    )
  }

  yield* Effect.sync(() => console.log("websocket connected"))
})

const reconnectPolicy = Schedule.exponential("20 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(100)))),
  Schedule.both(Schedule.recurs(8))
)

const program = connectWebSocket.pipe(
  Effect.retry({
    schedule: reconnectPolicy,
    while: isRetryableReconnectError
  })
)

Effect.runPromise(program)
// Output:
// websocket connect attempt 1
// websocket connect attempt 2
// websocket connect attempt 3
// websocket connected
```

The sample uses short delays so it terminates quickly when pasted into
`scratchpad/repro.ts`. The same shape can use larger production intervals.

##### Variants

For an interactive screen, keep the retry count and cap small enough that the UI
can move to a visible "reconnect failed" state quickly.

For a background client, allow a longer tail but keep the cap explicit and emit
attempt telemetry around the reconnect effect. Operators usually need to know
the close reason, attempt count, and final exhausted failure.

If the server sends a reconnect hint, such as a close reason with a retry-after
duration, prefer that server-provided delay for that case. Use the jittered
exponential policy as the fallback when the client has no better timing signal.

##### Notes and caveats

`Schedule.jittered` has fixed bounds in Effect. It adjusts delays between 80%
and 120% of the original delay; this recipe does not assume configurable jitter
bounds.

`Effect.retry` feeds typed failures into the schedule. The first connect attempt
is not delayed. Jitter affects only reconnect delays after failures.

`Schedule.recurs(8)` means eight retries after the original connect attempt, not
eight total executions.

Reconnect safety is still a domain concern. Refresh credentials before retrying
authorization failures, avoid replaying non-idempotent session setup without a
deduplication story, and keep user-facing timeout or fallback behavior close to
the caller.

#### 21.4 Jittered periodic refresh

Use jittered repetition when a refresh loop should run on a recognizable cadence
without making every instance hit the same dependency at the same moment.

##### Problem

Each service instance refreshes cached configuration in the background. The
first refresh should run immediately. Later refreshes should stay near the
chosen interval while drifting enough to avoid synchronized requests across the
fleet.

##### When to use it

Use this when many independent processes, fibers, clients, or browser sessions
repeat the same successful operation on a regular cadence.

It fits refresh loops for cached configuration, feature flags, service
discovery data, quota snapshots, and other state that should stay reasonably
fresh but does not need to update on an exact wall-clock boundary.

Use it when the base interval is still the operational contract. A one-minute
refresh remains a one-minute refresh in spirit, but individual recurrences are
spread around that value.

##### When not to use it

Do not use jitter when the refresh must happen at exact wall-clock boundaries,
such as a report that must run at the top of every hour.

Do not use jitter as the only protection for an overloaded dependency. Jitter
reduces synchronization; it does not enforce quotas, backpressure, admission
control, or a maximum number of concurrent refreshes.

Do not use this schedule to recover from refresh failures. With
`Effect.repeat`, the schedule sees successful refresh results. If loading
configuration can fail transiently, give the refresh effect its own retry
policy before repeating it.

##### Schedule shape

Start with the intended refresh cadence and apply jitter to that cadence:

`Schedule.spaced("1 minute")` waits one minute after each successful refresh
before starting the next one. `Schedule.jittered` randomly adjusts each
recurrence delay between 80% and 120% of the original delay, so a one-minute
interval becomes a delay between 48 and 72 seconds.

The first refresh is not delayed by the schedule. It runs when the effect
starts. The schedule controls only the recurrences after successful refreshes.

##### Example

```ts runnable deterministic
import { Effect, Schedule } from "effect"

type Config = {
  readonly version: string
  readonly cacheTtlMillis: number
  readonly featureFlags: ReadonlyArray<string>
}

let version = 0

const loadConfig = Effect.sync((): Config => {
  version += 1
  console.log(`loaded config version ${version}`)
  return {
    version: `v${version}`,
    cacheTtlMillis: 60_000,
    featureFlags: ["search", "checkout"]
  }
})

const replaceCachedConfig = (config: Config) =>
  Effect.sync(() => {
    console.log(`cached ${config.version}`)
  })

const refreshCachedConfig = loadConfig.pipe(
  Effect.flatMap(replaceCachedConfig)
)

const demoRefreshSchedule = Schedule.spaced("20 millis").pipe(
  Schedule.jittered,
  Schedule.take(3)
)

const program = refreshCachedConfig.pipe(
  Effect.repeat(demoRefreshSchedule),
  Effect.tap(() => Effect.sync(() => console.log("refresh loop stopped")))
)

Effect.runPromise(program)
// Output:
// loaded config version 1
// cached v1
// loaded config version 2
// cached v2
// loaded config version 3
// cached v3
// loaded config version 4
// cached v4
// refresh loop stopped
```

The sample uses a short interval and `Schedule.take(3)` so it terminates
quickly. For a real background fiber, use the operational interval, such as one
minute, and tie interruption to the process lifecycle.

##### Variants

Use a longer interval when stale configuration is acceptable and the shared
configuration service is expensive. Use `Schedule.tapOutput` when you want
telemetry for the repeat count.

If a refresh can fail transiently, retry the single refresh operation with its
own short policy, then repeat the recovered operation on the longer refresh
cadence. That keeps failure recovery separate from normal periodic repetition.

##### Notes and caveats

`Schedule.jittered` does not expose configurable bounds. In Effect, it adjusts
each recurrence delay between 80% and 120% of the original delay.

`Effect.retry` feeds failures into a schedule. `Effect.repeat` feeds successful
values into a schedule. For periodic refresh, jitter usually belongs on the
repeat schedule because the goal is to spread normal successful polling or
refresh traffic.

`Schedule.spaced` measures the delay after the previous refresh completes. If
the refresh itself takes several seconds, the next refresh starts after the
work completes and the jittered delay has elapsed.

#### 21.5 Jittered cache warming

Cache warming is successful background work that repeats on a cadence. Use
jitter so many instances do not refresh the same hot keys at the same moment.

##### Problem

Every instance should run its first warming pass when the process starts and
then refresh important cache entries roughly every thirty seconds. In a fleet,
later passes should drift enough that instances do not all read the same backing
services at once.

##### When to use it

Use this when many service instances, workers, or pods run the same cache
warming loop against the same backing store, database, object store, or
downstream API.

It fits background warming for product catalogs, feature snapshots, permission
lookups, pricing tables, routing data, and other data that should remain hot
but does not need to refresh on an exact wall-clock boundary.

Use it when "roughly every thirty seconds" is acceptable and a steadier load
profile matters more than every instance refreshing at the same moment.

##### When not to use it

Do not use jitter when cache entries must be refreshed at exact wall-clock
boundaries, such as a report cache rebuilt at the top of every hour.

Do not use jitter as the only overload control for expensive warming work.
Limit concurrency inside the warming effect, use downstream rate limits, and
bound the number of keys each pass warms.

Do not use the repeat schedule to classify warming failures. With
`Effect.repeat`, the schedule sees successful warming results. If a single
warming pass can fail transiently, retry that pass separately before repeating
it on the long-running cadence.

##### Schedule shape

Start with the intended warming interval and add jitter:

`Schedule.spaced("30 seconds")` waits thirty seconds after a successful warming
pass completes. `Schedule.jittered` randomly adjusts each recurrence delay
between 80% and 120% of the original delay, so a thirty-second interval becomes
a delay between 24 and 36 seconds.

The first warming pass is not delayed by the schedule. It runs when the effect
starts. The schedule controls only the recurrences after successful warming
passes.

##### Example

```ts runnable deterministic
import { Effect, Schedule } from "effect"

type CacheKey = string

const hotKeys: ReadonlyArray<CacheKey> = [
  "catalog:featured",
  "pricing:default",
  "permissions:public"
]

const warmCacheEntry = Effect.fnUntraced(function*(key: CacheKey) {
  yield* Effect.sync(() => console.log(`warmed ${key}`))
})

const warmCacheOnce = Effect.forEach(
  hotKeys,
  warmCacheEntry,
  { concurrency: 4 }
).pipe(
  Effect.asVoid
)

const demoWarmingSchedule = Schedule.spaced("20 millis").pipe(
  Schedule.jittered,
  Schedule.take(2)
)

const program = warmCacheOnce.pipe(
  Effect.repeat(demoWarmingSchedule),
  Effect.tap(() => Effect.sync(() => console.log("cache warming stopped")))
)

Effect.runPromise(program)
// Output:
// warmed catalog:featured
// warmed pricing:default
// warmed permissions:public
// warmed catalog:featured
// warmed pricing:default
// warmed permissions:public
// warmed catalog:featured
// warmed pricing:default
// warmed permissions:public
// cache warming stopped
```

The sample warms three keys immediately and then performs two scheduled
recurrences. Use the real interval and lifecycle interruption for a production
background warmer.

##### Variants

Retry transient failures inside one warming pass, then repeat the recovered
warming pass on the longer jittered cadence. This keeps two policies separate:
a short retry policy for a failed warming attempt, and a long repeat policy for
normal cache warming.

Use a longer base interval for expensive data or large fleets. The jitter range
follows the base delay; a five-minute interval becomes a delay between four and
six minutes.

##### Notes and caveats

`Schedule.jittered` does not expose configurable bounds. In Effect, it adjusts
each recurrence delay between 80% and 120% of the original delay.

`Effect.retry` feeds failures into a schedule. `Effect.repeat` feeds successful
values into a schedule. Cache warming usually uses jitter on the repeat
schedule because the goal is to spread normal successful background traffic.

`Schedule.spaced` measures the delay after the previous warming pass completes.
If warming a large key set takes ten seconds, the next pass starts after that
work completes and the jittered delay has elapsed.

## Part VI — Composition and Termination

### 22. Stop Conditions

#### 22.1 Stop when status becomes terminal

Poll a job, order, import, deployment, or other long-running workflow when the
status endpoint succeeds even while the workflow is still in progress. A later
successful status eventually means "there is nothing more to poll".

Use `Effect.repeat` for the polling loop and let the schedule inspect each
successful status. The effect performs the first status read immediately. After
that, the schedule decides whether to wait and read again.

##### Problem

A status API may return `"queued"` or `"running"` as successful responses before
it eventually returns `"completed"`, `"failed"`, or `"canceled"`. The repeat
policy should treat only the non-terminal statuses as reasons to poll again.

A domain status such as `"failed"` is still a successful response from the status
API. The schedule should observe that value and stop the repeat loop, while
transport or decoding failures remain ordinary Effect failures.

##### When to use it

Use this when the repeated effect returns a domain status value and only some
of those statuses mean "poll again".

This is a good fit for order fulfillment, export generation, provisioning,
replication, and back-office jobs where states such as `"queued"` or
`"running"` are normal intermediate observations, while states such as
`"completed"`, `"failed"`, or `"canceled"` are terminal observations.

##### When not to use it

Do not use this as a retry policy for failed status reads. With
`Effect.repeat`, a failure from the status-read effect stops the repeat before
the schedule can inspect a status. Add a separate retry around the status read
if transient read failures should be retried.

Do not encode normal terminal statuses as failures just to stop polling. If the
remote workflow can end in `"completed"` or `"failed"` and both are meaningful
business outcomes, return both as successful status values and interpret the
final status after the repeat completes.

Do not leave production polling unbounded unless the fiber has a clear owner
that can interrupt it. Add a recurrence limit or elapsed budget when a terminal
status is expected but not guaranteed.

##### Schedule shape

Combine `Schedule.identity<OrderStatus>()` with a cadence using
`Schedule.bothLeft`. The identity schedule makes the latest successful status
the schedule output, while the cadence supplies the delay before the next read.
Then use `Schedule.while` to continue only while that status is not terminal.

Returning `true` from the predicate allows another poll. Returning `false`
stops the repeat and returns the latest status.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type OrderStatus =
  | { readonly state: "queued"; readonly orderId: string }
  | { readonly state: "running"; readonly orderId: string; readonly step: string }
  | { readonly state: "completed"; readonly orderId: string; readonly receiptId: string }
  | { readonly state: "failed"; readonly orderId: string; readonly reason: string }
  | { readonly state: "canceled"; readonly orderId: string }

type StatusReadError = {
  readonly _tag: "StatusReadError"
  readonly orderId: string
}

const statuses: ReadonlyArray<OrderStatus> = [
  { state: "queued", orderId: "order-123" },
  { state: "running", orderId: "order-123", step: "packing" },
  { state: "completed", orderId: "order-123", receiptId: "receipt-456" }
]

let reads = 0

const readOrderStatus = (
  orderId: string
): Effect.Effect<OrderStatus, StatusReadError> =>
  Effect.gen(function*() {
    const index = yield* Effect.sync(() => {
      const current = reads
      reads += 1
      return current
    })
    const status = statuses[index] ?? statuses[statuses.length - 1]!

    yield* Console.log(`status read ${index + 1}: ${status.state}`)
    return status
  })

const isTerminal = (status: OrderStatus): boolean =>
  status.state === "completed" ||
  status.state === "failed" ||
  status.state === "canceled"

const pollUntilTerminal = Schedule.identity<OrderStatus>().pipe(
  Schedule.bothLeft(Schedule.spaced("100 millis")),
  Schedule.while(({ output }) => !isTerminal(output))
)

const waitForTerminalOrderStatus = (orderId: string) =>
  readOrderStatus(orderId).pipe(
    Effect.repeat(pollUntilTerminal)
  )

const program = waitForTerminalOrderStatus("order-123").pipe(
  Effect.flatMap((status) => Console.log(`final status: ${status.state}`))
)

Effect.runPromise(program)
// Output:
// status read 1: queued
// status read 2: running
// status read 3: completed
// final status: completed
```

`waitForTerminalOrderStatus` reads the status immediately. If the first status
is `"completed"`, `"failed"`, or `"canceled"`, there is no delay and no second
request. If the status is `"queued"` or `"running"`, the schedule waits two
seconds in a real policy before the next read; the runnable example uses a
shorter delay so it finishes quickly.

The returned effect succeeds with the last observed `OrderStatus`. Usually that
will be a terminal status. If you add a recurrence cap or elapsed budget, the
final value may still be `"queued"` or `"running"`, so check the final status
before treating the workflow as complete.

##### Variants

For an internal worker where eventual completion is expected, combine the
condition with `Schedule.recurs`. For caller-facing polling, combine it with
`Schedule.during` so the caller gets a bounded answer.

For many clients polling the same kind of resource, add `Schedule.jittered`
after choosing a base cadence so instances do not synchronize.

The polling schedule answers "should I observe again?" The code after polling
answers "what does the final status mean for this caller?"

##### Notes and caveats

The first status read is not delayed. Schedule delays apply only before later
recurrences.

`Schedule.while` is evaluated at recurrence decision points after successful
runs. It does not interrupt a status read that is already running.

`Effect.repeat` feeds successful values into the schedule. `Effect.retry` feeds
failures into the schedule. Use `Effect.repeat` when the status value itself
decides whether to continue polling.

When a timing schedule needs to inspect the repeated effect's successful value,
use a schedule whose input type matches that value. `Schedule.identity<T>()` is
convenient when the caller should receive the last observed value rather than the
timing schedule's own output.

#### 22.2 Stop when no more work remains

Use this pattern when each successful run reports whether more work is waiting.
The schedule should repeat while that report says work remains, then return the
last successful observation when the queue is empty.

This is a common shape for queue drains, batch processors, catch-up workers, and
maintenance jobs that should keep going while they are making progress, but
should stop cleanly when there is nothing left to do.

##### Problem

A queue-drain effect processes one bounded batch and returns a result such as
`{ processed, remaining }`. One run is always useful because it discovers the
current backlog; after that, the schedule should continue only while `remaining`
says work is left.

Keep that decision in the schedule so reviewers can see both the cadence and the
termination rule, instead of finding a mutable loop counter or sleep hidden
inside the worker.

##### When to use it

Use this recipe when the successful value contains a clear "remaining work"
signal, such as a queue depth, a continuation cursor, or a `hasMore` flag.

It is a good fit when each recurrence should wait before taking another batch.
That prevents a catch-up worker from turning a large backlog into a tight loop
that competes with foreground traffic.

##### When not to use it

Do not use this as a replacement for queue acknowledgement, leasing, or
visibility timeout rules. The effect that drains the queue still owns those
delivery semantics.

Do not use this schedule to classify worker failures. `Effect.repeat` feeds
successful values into the schedule. Failures from the drain effect fail the
whole repeat unless you handle or retry them separately.

Avoid this shape when the queue can notify workers directly. A push signal,
stream, or consumer loop may be a better model than scheduled draining.

##### Schedule shape

Use `Schedule.identity<DrainResult>()` to keep the latest successful drain
result as the schedule output, combine it with a spacing policy, and continue
only while `remaining` is greater than zero.

`Schedule.while` receives metadata for each successful step. Returning `true`
continues the schedule; returning `false` stops it and yields the latest output.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type DrainResult = {
  readonly processed: number
  readonly remaining: number
}

type QueueDrainError = {
  readonly _tag: "QueueDrainError"
  readonly message: string
}

const batches: ReadonlyArray<DrainResult> = [
  { processed: 25, remaining: 40 },
  { processed: 25, remaining: 15 },
  { processed: 15, remaining: 0 }
]

let drains = 0

const drainWorkQueue: Effect.Effect<DrainResult, QueueDrainError> = Effect.gen(function*() {
  const index = yield* Effect.sync(() => {
    const current = drains
    drains += 1
    return current
  })
  const result = batches[index] ?? batches[batches.length - 1]!

  yield* Console.log(
    `drain ${index + 1}: processed=${result.processed}, remaining=${result.remaining}`
  )
  return result
})

const drainUntilEmpty = Schedule.identity<DrainResult>().pipe(
  Schedule.bothLeft(Schedule.spaced("100 millis")),
  Schedule.while(({ output }) => output.remaining > 0)
)

const program = drainWorkQueue.pipe(
  Effect.repeat(drainUntilEmpty),
  Effect.flatMap((result) => Console.log(`stopped with ${result.remaining} items remaining`))
)

Effect.runPromise(program)
// Output:
// drain 1: processed=25, remaining=40
// drain 2: processed=25, remaining=15
// drain 3: processed=15, remaining=0
// stopped with 0 items remaining
```

`drainWorkQueue` runs once immediately. If that first drain returns
`remaining: 0`, the schedule stops without waiting and `runDrain` succeeds with
that result.

If the first drain returns `remaining: 120`, the schedule waits before running
another drain. The example uses a short delay so it finishes quickly; production
drainers often use a longer cadence. The final result is the first observation
whose `remaining` value is `0`.

##### Variants

Use `remaining > 0 && processed > 0` when the worker should stop if a run made
no progress, even if the queue still reports backlog. That avoids repeating
forever when work is stuck behind a poison item or unavailable partition.

Use a longer interval for background maintenance queues, or a shorter interval
for interactive catch-up work. The spacing is paid after each successful drain,
so long-running batches naturally push the next recurrence later.

Add a separate limit when an empty queue is not guaranteed. For example, combine
the drain condition with `Schedule.recurs` or `Schedule.during` when the worker
has a fixed maintenance window.

##### Notes and caveats

`Effect.repeat` always performs the original effect before the schedule controls
any recurrence. The schedule decides whether to run again after observing the
successful `DrainResult`.

`Schedule.while` inspects successful values only. If `drainWorkQueue` fails, the
repeat fails unless the effect handles the error or the whole drain is wrapped
in a retry policy.

`Schedule.identity<DrainResult>()` is what makes `runDrain` return the latest
`DrainResult`. Without preserving the domain value, the result would come from a
timing schedule, such as the numeric output of `Schedule.spaced`.

Keep the reported `remaining` value meaningful. If it is approximate, stale, or
eventually consistent, add an operational guard such as an elapsed budget or a
recurrence cap so the worker cannot repeat forever on bad telemetry.

#### 22.3 Stop when data becomes available

Sometimes the absence of data is not an error. A cache entry may be warming in
the background, a resource record may be propagating, or another process may be
about to publish the value you need. In those cases, model "not available yet"
as a successful observation and let the schedule stop when a later successful
observation contains the data.

This recipe uses a cache lookup as the example. The lookup can succeed with
`Missing` or `Available`; only real lookup failures stay in the error channel.

##### Problem

A profile lookup may hit a cache before the background warmer has published the
entry. A miss is a normal observation in that path, so the polling policy should
wait briefly for an `Available` result without converting `Missing` into an
error.

The first lookup should happen immediately. If the data is missing, wait and try
again. If the data is available, stop without another lookup. The schedule should
make that stop condition visible in one place.

##### When to use it

Use this when all of these are true:

- A missing value is a normal temporary result.
- Some other path is already responsible for making the data available.
- The caller wants to wait by polling rather than subscribing to a push signal.
- Lookup failures should remain distinct from "not available yet".

Typical examples include asynchronous cache warm-up, read-through cache
population, eventually visible resource metadata, and short propagation windows
after a write.

##### When not to use it

Do not use this when the data may never be produced. Invalid keys, authorization
problems, disabled producers, and malformed requests should be represented as
separate domain results or failures before the schedule is applied.

Do not treat cache backend errors as misses unless the domain explicitly says
that is safe. A network error, serialization failure, or unavailable cache
server is usually a failed lookup, not an absent value.

Prefer a push-based callback, queue message, or notification channel when the
producer already has a reliable way to signal availability.

##### Schedule shape

Use a spaced schedule for the polling cadence, preserve the successful lookup
result as the schedule output, and continue only while that result is
`Missing`. The repeated program can then inspect the final observed lookup
result after the schedule stops.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type Availability<A> =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Available"; readonly value: A }

interface UserProfile {
  readonly id: string
  readonly displayName: string
}

type CacheLookupError = {
  readonly _tag: "CacheLookupError"
  readonly message: string
}

const observations: ReadonlyArray<Availability<UserProfile>> = [
  { _tag: "Missing" },
  { _tag: "Missing" },
  {
    _tag: "Available",
    value: { id: "user-1", displayName: "Ada" }
  }
]

let lookups = 0

const lookupProfileCache = (
  userId: string
): Effect.Effect<Availability<UserProfile>, CacheLookupError> =>
  Effect.gen(function*() {
    const index = yield* Effect.sync(() => {
      const current = lookups
      lookups += 1
      return current
    })
    const observation = observations[index] ?? observations[observations.length - 1]!

    yield* Console.log(`${userId} cache lookup ${index + 1}: ${observation._tag}`)
    return observation
  })

const pollUntilAvailable = Schedule.identity<Availability<UserProfile>>().pipe(
  Schedule.bothLeft(Schedule.spaced("100 millis")),
  Schedule.while(({ output }) => output._tag === "Missing")
)

const waitForProfile = (
  userId: string
): Effect.Effect<
  UserProfile,
  CacheLookupError | { readonly _tag: "ProfileUnavailable" }
> =>
  lookupProfileCache(userId).pipe(
    Effect.repeat(pollUntilAvailable),
    Effect.flatMap((availability) =>
      availability._tag === "Available"
        ? Effect.succeed(availability.value)
        : Effect.fail({ _tag: "ProfileUnavailable" as const })
    )
  )

const program = waitForProfile("user-1").pipe(
  Effect.flatMap((profile) => Console.log(`profile ready: ${profile.displayName}`))
)

Effect.runPromise(program)
// Output:
// user-1 cache lookup 1: Missing
// user-1 cache lookup 2: Missing
// user-1 cache lookup 3: Available
// profile ready: Ada
```

The first cache lookup runs immediately. If it returns `Missing`, the schedule
waits before the next lookup. The runnable example uses a short delay; a
production path can use a longer cadence. If the lookup returns `Available`, the
schedule stops and `Effect.repeat` returns that final `Available` value.

The `Missing` branch after `Effect.repeat` is unreachable for this unbounded
schedule because the schedule stops only when the latest successful observation
is no longer missing. It becomes reachable when you add a limit.

##### Variants

Add a recurrence cap when the caller should stop waiting after a bounded number
of misses. With the cap, `Effect.repeat` can return `Missing` because the
recurrence limit may stop the schedule before the cache entry appears. Interpret
that result explicitly instead of assuming the data was found.

Add `Schedule.jittered` when many callers may wait for the same key. It changes
the timing of each recurrence, not the stop condition.

##### Notes and caveats

Use `Effect.repeat` here because the decision is based on successful lookup
results. `Effect.retry` feeds failures into the schedule, which is the wrong
shape when "missing" is ordinary data.

The schedule does not delay the first lookup. It controls only recurrences after
the first successful lookup.

Keep the lookup effect responsible for classification. Translate only expected
absence into `Missing`; leave real lookup failures in the error channel.

#### 22.4 Stop when a value stabilizes

Some workflows do not have a terminal status field. Instead, they are finished
when repeated observations stop changing. A read model may be caught up when two
consecutive reads report the same version, a cache may be warm when its checksum
stops changing, or a derived aggregate may be ready when both its revision and
item count stay the same.

This recipe uses a schedule over successful outputs. The effect performs the
observation. The schedule remembers enough previous output to decide whether the
next successful output is stable.

##### Problem

A projection reader may need two consecutive snapshots with the same version and
item count before treating the projection as settled.

That comparison should be visible in the schedule. Future readers should not have
to infer "stable" from an unstructured loop, a mutable variable outside the
policy, or scattered sleep calls.

##### When to use it

Use this when each successful run is an observation and completion means "the
observed value has stopped changing".

Good examples include polling a projection version, waiting for an eventually
consistent count to settle, or reading a checksum until two consecutive reads
match. In each case, define exactly what equality means for the workflow.

##### When not to use it

Do not use this to retry failures. `Effect.repeat` feeds successful values into
the schedule; a failure stops the repetition with that failure unless you handle
it separately.

Do not use a single unchanged observation when the domain can pause and then
continue changing. In that case, require a longer stable streak, add a time
budget, or wait for a stronger terminal signal.

Avoid vague comparisons. For numeric values, exact equality may be too strict or
too weak. Prefer a named predicate such as "within tolerance" when that is the
real business rule.

##### Schedule shape

Start with a schedule whose input and output are the successful observation,
reduce those observations into stability state, and continue only while that
state is not stable. `Schedule.identity<Snapshot>()` passes each successful
`Snapshot` through as the schedule output. `Schedule.reduce` keeps the previous
observation in schedule state.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

interface Snapshot {
  readonly version: string
  readonly itemCount: number
}

interface StabilityState {
  readonly previous: Snapshot | undefined
  readonly current: Snapshot | undefined
  readonly stable: boolean
}

const snapshots: ReadonlyArray<Snapshot> = [
  { version: "v1", itemCount: 8 },
  { version: "v2", itemCount: 10 },
  { version: "v2", itemCount: 10 }
]

let reads = 0

const readSnapshot: Effect.Effect<Snapshot> = Effect.gen(function*() {
  const index = yield* Effect.sync(() => {
    const current = reads
    reads += 1
    return current
  })
  const snapshot = snapshots[index] ?? snapshots[snapshots.length - 1]!

  yield* Console.log(
    `snapshot ${index + 1}: version=${snapshot.version}, items=${snapshot.itemCount}`
  )
  return snapshot
})

const sameSnapshot = (left: Snapshot, right: Snapshot) =>
  left.version === right.version && left.itemCount === right.itemCount

const initialState: StabilityState = {
  previous: undefined,
  current: undefined,
  stable: false
}

const untilStable = Schedule.identity<Snapshot>().pipe(
  Schedule.bothLeft(Schedule.spaced("100 millis")),
  Schedule.reduce(
    () => initialState,
    (state, current): StabilityState => ({
      previous: state.current,
      current,
      stable: state.current !== undefined && sameSnapshot(state.current, current)
    })
  ),
  Schedule.while(({ output }) => !output.stable)
)

const program = readSnapshot.pipe(
  Effect.repeat(untilStable),
  Effect.flatMap((state) =>
    Console.log(
      `stable at version ${state.current?.version} with ${state.current?.itemCount} items`
    )
  )
)

Effect.runPromise(program)
// Output:
// snapshot 1: version=v1, items=8
// snapshot 2: version=v2, items=10
// snapshot 3: version=v2, items=10
// stable at version v2 with 10 items
```

`readSnapshot` runs once before the schedule is consulted. The first successful
snapshot cannot be stable because there is no previous snapshot to compare with.
After each later success, the schedule compares the latest snapshot with the
previous one. When `sameSnapshot` returns `true`, `Schedule.while` returns
`false`, and repetition stops.

The repeat returns the final `StabilityState`. Its `current` field is the
snapshot that matched `previous`.

##### Variants

For domains that can pause and then continue changing, require a longer stable
streak instead of one unchanged comparison. Track a count in the reduced state
and stop only after the count reaches the required number of unchanged
observations.

Add a recurrence limit or elapsed budget when stabilization is not guaranteed.
If the limit stops the schedule first, inspect the final state and return a
domain-specific "not stable yet" result.

##### Notes and caveats

This is an output condition, so it belongs with `Effect.repeat`, not
`Effect.retry`. Retry schedules observe failures. Repeat schedules observe
successful values.

The schedule does not delay the first observation. Delays apply only before
later recurrences.

If the value never stabilizes, an unbounded stability schedule can repeat
forever. Add a count limit, a time budget, or external cancellation unless the
surrounding workflow already provides one.

#### 22.5 Stop on fatal errors

Fatal errors should bypass retry timing. Classify raw failures into domain
errors first, then let only recoverable failures reach the retry schedule.

##### Problem

One operation can fail for temporary reasons, such as a timeout or overloaded
dependency, or for fatal reasons, such as bad input or missing authorization.
The retry budget should be spent only on failures that may recover without
changing the request.

##### When to use it

Use this recipe when a single operation can produce both retryable and
non-retryable failures. It fits HTTP clients, database calls, message
publication, and worker steps where a timeout may recover but validation or
authorization should stop immediately.

The classification belongs next to the boundary that understands the failure.
For example, translate HTTP `408`, `429`, and `503` into transient domain errors,
and translate HTTP `400`, `401`, and `403` into fatal domain errors before the
retry boundary.

##### When not to use it

Do not ask a schedule to discover whether an error is fatal. If the error is
known to be permanent, classify it before retrying and let it bypass the
schedule.

Also avoid retrying non-idempotent writes unless the operation has a clear
deduplication or transaction guarantee. Idempotent means safe to run more than
once with the same effect; a retry policy does not provide that guarantee.

##### Schedule shape

Use a normal timing schedule for retryable failures, then add the retry gate at
the `Effect.retry` call site:

- `schedule` controls delay and retry count
- `while` decides whether the current typed failure is retryable

This keeps the responsibilities separate. The schedule answers "when and how
many times?", while the predicate answers "is this failure retryable?"

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class TransientDownstreamError extends Data.TaggedError("TransientDownstreamError")<{
  readonly reason: "Timeout" | "Unavailable" | "RateLimited"
}> {}

class FatalDownstreamError extends Data.TaggedError("FatalDownstreamError")<{
  readonly reason: "BadRequest" | "Unauthorized" | "Forbidden"
}> {}

type DownstreamError = TransientDownstreamError | FatalDownstreamError

let attempts = 0

const callDownstream = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`attempt ${attempts}`)

  if (attempts === 1) {
    return yield* Effect.fail(
      new TransientDownstreamError({ reason: "Timeout" })
    )
  }

  return yield* Effect.fail(
    new FatalDownstreamError({ reason: "Unauthorized" })
  )
})

const isTransient = (error: DownstreamError): error is TransientDownstreamError =>
  error._tag === "TransientDownstreamError"

const retryPolicy = Schedule.exponential("20 millis").pipe(
  Schedule.both(Schedule.recurs(5))
)

const program = callDownstream.pipe(
  Effect.retry({
    schedule: retryPolicy,
    while: isTransient
  }),
  Effect.matchEffect({
    onFailure: (error) =>
      Console.log(
        `stopped on ${error._tag}/${error.reason} after ${attempts} attempts`
      ),
    onSuccess: (value) => Console.log(`succeeded with ${value}`)
  })
)

Effect.runPromise(program)
// Output:
// attempt 1
// attempt 2
// stopped on FatalDownstreamError/Unauthorized after 2 attempts
```

##### Variants

For a user-facing request, keep the retry budget small or add an elapsed budget
with `Schedule.during` so callers get a prompt answer.

For a background worker, use a larger budget and add logging or metrics around
classification. The useful signal is often "fatal error bypassed retry", not
just "retry exhausted".

If the downstream error carries retry metadata, classify that data before retry
as well. For example, a rate-limit response can become a transient error with a
parsed delay, and a custom schedule can use that delay without inspecting raw
HTTP headers elsewhere.

##### Notes and caveats

`Schedule.recurs(5)` means at most five retries after the original attempt. The
first call is not counted as a schedule recurrence.

`Effect.retry` observes failures, not successes. If `callDownstream` fails with
`FatalDownstreamError`, `while: isTransient` rejects it and the program fails
with that fatal error immediately. If it fails with `TransientDownstreamError`,
the schedule decides the next delay until the retry budget is exhausted.

Keep fatal and transient error types separate when possible. A single loose
error type with a boolean flag tends to spread retry decisions through the code
base. Tagged domain errors make the stop condition explicit at the retry
boundary.

#### 22.6 Classify errors before retrying

Retry policies should be narrow. A schedule can say when to try again and when
to stop, but it should not be asked to make every domain decision.

##### Problem

A downstream call can fail for several reasons. Some failures are temporary:
timeouts, overload, rate limits, or a service that is briefly unavailable. Other
failures are final for the current request: bad input, authorization failure,
missing configuration, or a business rule violation.

Classify the typed failure first, then let `Effect.retry` apply the schedule
only to genuinely transient failures. Using one broad retry policy for all
errors delays permanent failures, adds load, and hides whether the operation was
never retryable or merely exhausted its retry budget.

##### When to use it

Use this pattern when the same effect can fail with both transient and
non-transient typed errors. It is a good fit for HTTP clients, database calls,
message brokers, cloud control planes, and service-to-service requests where a
small set of failures should be attempted again.

Keep the classification close to the effect that knows the domain. A predicate
such as `isTransient` is easier to review than a schedule that silently retries
every error it receives.

##### When not to use it

Do not use this to make unsafe work safe to retry. A non-idempotent write still
needs an idempotency key, transaction boundary, deduplication strategy, or
another domain guarantee.

Do not retry validation errors, authentication errors, authorization errors,
malformed requests, or configuration errors. Those failures should return
immediately so the caller can fix the request or escalate the operational issue.

##### Schedule shape

Use two separate pieces:

- a predicate that decides whether the typed failure is transient
- a bounded schedule that decides retry timing and termination

`Schedule.exponential("100 millis")` provides the backoff curve. By itself, it
is unbounded. `Schedule.recurs(4)` adds a maximum of four retries after the
original attempt. `Schedule.jittered` spreads retry attempts around the
exponential delay so multiple callers do not retry together.

With `Effect.retry({ schedule, while })`, the `while` predicate is checked for
the typed failure. If it returns `false`, retrying stops immediately and that
failure is returned. If it returns `true`, the failure is fed to the schedule,
which decides whether another retry is allowed and how long to wait.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class DownstreamError extends Data.TaggedError("DownstreamError")<{
  readonly reason:
    | "Timeout"
    | "Unavailable"
    | "RateLimited"
    | "BadRequest"
    | "Unauthorized"
}> {}

const classifyStatus = (status: number): DownstreamError => {
  if (status === 408) {
    return new DownstreamError({ reason: "Timeout" })
  }
  if (status === 429) {
    return new DownstreamError({ reason: "RateLimited" })
  }
  if (status >= 500) {
    return new DownstreamError({ reason: "Unavailable" })
  }
  if (status === 401 || status === 403) {
    return new DownstreamError({ reason: "Unauthorized" })
  }
  return new DownstreamError({ reason: "BadRequest" })
}

const statuses: ReadonlyArray<number> = [429, 401]
let attempts = 0

const callDownstream = Effect.gen(function*() {
  attempts += 1
  const status = statuses[attempts - 1] ?? 200

  yield* Console.log(`downstream returned ${status}`)

  if (status === 200) {
    return "ok"
  }

  return yield* Effect.fail(classifyStatus(status))
})

const isTransient = (error: DownstreamError) =>
  error.reason === "Timeout" ||
  error.reason === "Unavailable" ||
  error.reason === "RateLimited"

const retryTransientFailures = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const program = callDownstream.pipe(
  Effect.retry({
    schedule: retryTransientFailures,
    while: isTransient
  }),
  Effect.matchEffect({
    onFailure: (error) => Console.log(`stopped on ${error.reason} after ${attempts} attempts`),
    onSuccess: (value) => Console.log(`succeeded with ${value}`)
  })
)

Effect.runPromise(program)
// Output:
// downstream returned 429
// downstream returned 401
// stopped on Unauthorized after 2 attempts
```

The `429` response is classified as transient and retried. The later `401` is
classified as `Unauthorized`, so retrying stops immediately and reports that
typed error.

##### Variants

Use a faster, smaller policy for user-facing paths so a permanent failure is not
hidden for long. Use an elapsed budget with `Schedule.during` when the caller
cares more about total waiting time than attempt count.

The same `isTransient` predicate can be reused with either schedule. The
predicate answers "is this failure retryable?" The schedule answers "how should
retrying proceed?"

##### Notes and caveats

`Effect.retry` retries typed failures from the error channel. Defects and fiber
interruptions are not made retryable by a schedule.

Prefer the `while` option on `Effect.retry` for error classification. It keeps
the domain predicate at the retry boundary and leaves `Schedule` responsible for
recurrence mechanics: delay, jitter, limits, and observation.

`Schedule.while` is lower level. It receives schedule metadata, including the
input, output, attempt, and selected delay. Use it when a schedule itself must
stop based on schedule metadata. For ordinary error classification before
retrying, `Effect.retry({ while })` is clearer.

### 23. Combine Limits and Delays

#### 23.1 Retry 5 times with fixed spacing

You want a failing effect to run once immediately, then retry at most five
times with the same delay before each retry. Compose the spacing and retry
limit so both concerns are visible at the retry boundary.

##### Problem

You need a bounded retry policy for a transient operation such as an inventory
lookup or startup check. The first attempt should happen right away. If it
fails, the next five retries should be spaced by a fixed interval.

The policy should make the off-by-one rule clear: "retry five times" means one
original attempt plus up to five retries, for at most six total attempts.

##### When to use it

Use this recipe when the operation is safe to run again and a fixed pause is
enough recovery time. It fits idempotent HTTP requests, short dependency
outages, service startup checks, and reconnect attempts where a steady cadence
is easier to reason about than backoff.

It is also useful when logs and runbooks need a simple answer: the call is tried
once, then retried up to five more times at the chosen spacing.

##### When not to use it

Do not use retries to hide permanent failures. Bad input, invalid credentials,
authorization failures, and unsafe non-idempotent writes should be classified
before the retry policy is applied.

Do not use a fixed spacing policy for overloaded or rate-limited dependencies
that need callers to spread out over time. Those cases usually call for
exponential backoff, jitter, server-provided retry metadata, or a time budget.

Do not use `Schedule.recurs(5)` when the requirement is five total attempts. In
that case the first attempt counts too, so the retry limit would be
`Schedule.recurs(4)`.

##### Schedule shape

Start with `Schedule.spaced` for the cadence, then add `Schedule.recurs(5)` as
the count guard. Combining them with `Schedule.both` means both schedules must
continue, so the policy stops when the retry count is exhausted.

With `Effect.retry`, the first execution is not scheduled. It runs immediately.
Only failures after that first execution are fed to the schedule:

- attempt 1: run immediately
- if attempt 1 fails: wait 1 second
- attempt 2: retry 1
- if attempt 2 fails: wait 1 second
- continue through retry 5
- if retry 5 fails: propagate the last typed failure

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly service: string
}> {}

let attempts = 0

const fetchInventory = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`inventory attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail(
      new ServiceUnavailable({ service: "inventory" })
    )
  }

  return ["sku-123", "sku-456"] as const
})

const retry5TimesWithFixedSpacing = Schedule.spaced("20 millis").pipe(
  Schedule.both(Schedule.recurs(5))
)

const program = fetchInventory.pipe(
  Effect.retry(retry5TimesWithFixedSpacing),
  Effect.matchEffect({
    onFailure: (error) => Console.log(`failed with ${error._tag} after ${attempts} attempts`),
    onSuccess: (items) => Console.log(`loaded ${items.length} items after ${attempts} attempts`)
  })
)

Effect.runPromise(program)
// Output:
// inventory attempt 1
// inventory attempt 2
// inventory attempt 3
// loaded 2 items after 3 attempts
```

The example uses `20 millis` so it terminates quickly. Use the same shape with
`1 second`, or any other fixed interval, in application code.

##### Variants

If you do not need to keep the output from `Schedule.recurs`, `Schedule.take(5)`
can express the same retry cap directly on the fixed-spacing schedule. For
`Effect.retry`, `take(5)` still means up to five retries after the original
attempt because schedule outputs correspond to scheduled retries.

Use a named count guard when the retry limit is important enough to read as its
own policy. If the requirement is "try the operation five times total", allow
only four retries with `Schedule.recurs(4)`.

##### Notes and caveats

`Effect.retry` feeds typed failures into the schedule. It does not retry defects
or fiber interruptions as typed failures.

`Schedule.spaced("1 second")` delays retries; it does not delay the first
attempt. The delay happens before each retry begins.

`Schedule.recurs(n)` counts scheduled recurrences, not total executions. With
`Effect.retry`, a recurrence is a retry. With `Effect.repeat`, a recurrence is a
repeat after a successful original execution.

#### 23.2 Retry 5 times with exponential backoff

Exponential backoff is a good default when a failure may be temporary but
retrying immediately would add pressure to the dependency. The retry limit is
what makes that policy operationally bounded.

##### Problem

You call a dependency that sometimes fails with a transient error. The operation
is safe to retry, but it should not retry forever and it should not hammer the
dependency while it is unhealthy.

You want the policy to say three things clearly:

- run the original attempt immediately
- after each failure, wait with exponential backoff
- stop after five scheduled retries

##### When to use it

Use this recipe for idempotent work where a later attempt can reasonably
succeed: reading from an overloaded service, refreshing cached metadata,
submitting a deduplicated event, or calling an internal API during a short
deploy window.

It is especially useful when code reviewers and operators need an exact answer
to "how many times can this run?" With `Schedule.recurs(5)`, the answer is one
original attempt plus at most five retries.

##### When not to use it

Do not use backoff to hide permanent failures. Bad input, forbidden access,
missing credentials, nonexistent resources, and schema errors should fail
without retrying.

Do not retry unsafe writes unless the operation has an idempotency key,
transaction boundary, or another guarantee that repeated execution cannot
duplicate the side effect.

Do not treat a retry count as a latency budget. Five retries can still take too
long if each attempt blocks before failing. If callers need a hard elapsed-time
limit, add `Schedule.during` or put an explicit timeout around the operation.

##### Schedule shape

Start with the delay shape, then add the retry limit.
`Schedule.exponential("200 millis")` starts with a 200 millisecond delay and,
with the default factor, doubles the delay on later recurrences.

`Schedule.recurs(5)` allows five scheduled recurrences. With `Effect.retry`,
those recurrences are retries after failures. `Schedule.both` requires both
schedules to continue, so the combined policy stops when the retry count is
exhausted.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type TransientError = {
  readonly _tag: "Timeout" | "Unavailable" | "RateLimited"
}

let attempts = 0

const callDownstream = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`downstream attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail({
      _tag: attempts === 1 ? "Timeout" : "Unavailable"
    } as TransientError)
  }

  return "response body"
})

const retryPolicy = Schedule.exponential("20 millis").pipe(
  Schedule.both(Schedule.recurs(5))
)

const program = callDownstream.pipe(
  Effect.retry(retryPolicy),
  Effect.matchEffect({
    onFailure: (error) => Console.log(`failed with ${error._tag} after ${attempts} attempts`),
    onSuccess: (value) => Console.log(`succeeded with "${value}" after ${attempts} attempts`)
  })
)

Effect.runPromise(program)
// Output:
// downstream attempt 1
// downstream attempt 2
// downstream attempt 3
// downstream attempt 4
// succeeded with "response body" after 4 attempts
```

The example uses a `20 millis` base interval so it terminates quickly. With this
policy, `callDownstream` can run at most six times total: one original attempt
plus five retries.

##### Variants

Use a larger base interval when the dependency needs more time to recover.

Use a smaller retry limit for user-facing requests where returning a clear error
quickly matters more than exhausting every recovery chance.

For fleet-wide retries, add jitter after the exponential cadence so identical
clients do not retry in lockstep.

##### Notes and caveats

`Schedule.exponential` is unbounded on its own. Always combine it with a retry
limit, elapsed-time budget, predicate, or another stopping condition for
request/response work.

`Schedule.recurs(5)` counts retries, not total executions. If a requirement says
"try five times total", use `Schedule.recurs(4)`.

`Effect.retry` retries typed failures from the error channel. Defects and fiber
interruptions are not retried as ordinary typed failures.

#### 23.3 Retry 10 times with jittered backoff

Use this policy when a transient failure should get several chances to recover
without every caller retrying at the same moments.

##### Problem

You have an effect that may fail because a dependency is restarting,
overloaded, briefly unreachable, or returning a retryable service error. A plain
`Schedule.exponential` retry policy backs off over time, but it is unbounded by
itself. If many workers use the same deterministic backoff, they can also retry
at the same boundaries and create bursts.

You want the operation to retry at most ten times after the original attempt,
with exponential delays that are randomly adjusted around each computed delay.

##### When to use it

Use this recipe for retryable, idempotent work that crosses a process or network
boundary: service calls, queue operations, cache fetches, database reconnects,
or client initialization. Ten retries is enough to ride out many short
incidents while still making exhaustion explicit.

It is especially useful when the same retry policy can run across many fibers,
workers, pods, or service instances. Jitter spreads retry traffic so fleet-wide
load is less likely to arrive as one coordinated spike.

##### When not to use it

Do not use this policy for permanent failures such as validation errors,
authorization failures, malformed requests, or missing configuration. Classify
those errors before retrying.

Do not use it to make unsafe writes safe. Retried writes still need idempotency,
deduplication, transactions, or another domain guarantee that repeated
execution is acceptable.

Do not use ten retries as a default latency budget for interactive paths. A
user-facing request may need fewer retries, a smaller elapsed-time bound, or a
fallback once the dependency is still unavailable.

##### Schedule shape

`Schedule.exponential("200 millis")` starts with a 200 millisecond delay and
doubles the base delay after each failed attempt.

`Schedule.jittered` modifies each recurrence delay between 80% and 120% of the
delay chosen by the schedule it wraps. With a 200 millisecond base, the first
retry waits somewhere from 160 to 240 milliseconds, the next retry is jittered
around 400 milliseconds, and so on.

`Schedule.both(Schedule.recurs(10))` adds the stopping condition. Both sides of
the composed schedule must continue, so the exponential schedule supplies the
delay while `Schedule.recurs(10)` supplies the retry limit.

With `Effect.retry`, the original effect runs immediately. `Schedule.recurs(10)`
means ten retries after that original execution, for up to eleven executions in
total.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly status: number
}> {}

const statuses = [503, 503, 200] as const
let attempts = 0

const callService = Effect.gen(function*() {
  attempts += 1
  const status = statuses[attempts - 1] ?? 200

  yield* Console.log(`service attempt ${attempts}: ${status}`)

  if (status === 200) {
    return "ok"
  }

  return yield* Effect.fail(new ServiceUnavailable({ status }))
})

const retryTenTimesWithJitteredBackoff = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(10))
)

const program = callService.pipe(
  Effect.retry({
    schedule: retryTenTimesWithJitteredBackoff,
    while: (error) => error.status === 429 || error.status >= 500
  }),
  Effect.matchEffect({
    onFailure: (error) => Console.log(`failed with HTTP ${error.status} after ${attempts} attempts`),
    onSuccess: (value) => Console.log(`succeeded with ${value} after ${attempts} attempts`)
  })
)

Effect.runPromise(program)
// Output:
// service attempt 1: 503
// service attempt 2: 503
// service attempt 3: 200
// succeeded with ok after 3 attempts
```

The example uses a `10 millis` base interval so it terminates quickly. The
`while` predicate keeps non-retryable typed failures out of the schedule. If all
ten retries fail, `program` fails with the last `ServiceUnavailable`.

##### Variants

Use a smaller retry budget when the caller needs a quick answer. Use a larger
starting delay when the dependency is already under pressure.

If the operation has a hard elapsed-time budget, add a time limit alongside the
attempt limit instead of relying on retry count alone.

##### Notes and caveats

`Schedule.exponential` is unbounded by itself. Pair it with an attempt limit,
elapsed-time limit, predicate, or another stopping condition before using it as
a production retry policy.

`Schedule.jittered` changes timing only. It does not reduce the number of
callers that may retry, and it does not decide which failures are safe to retry.
Use admission control, concurrency limits, circuit breakers, or load shedding
when the fleet can still produce more retry traffic than the dependency can
handle.

The composed schedule output is a pair of outputs from the jittered exponential
schedule and the recurrence counter. Plain `Effect.retry` uses the schedule for
retry decisions and returns the retried effect's successful value, so that
nested output usually does not appear in application code.

#### 23.4 Poll with both interval and deadline

Polling usually needs two separate limits. The interval controls load on the
remote system. The deadline controls how long the caller is willing to keep
observing a non-terminal state. Model those as two schedules and combine them,
instead of hiding a sleep and a clock check inside a loop.

##### Problem

You need to poll a job, export, provisioning, payment, or deployment status
endpoint every few seconds, but only until either the work reaches a terminal
state or the polling window expires.

The first status read should happen immediately. After each successful
non-terminal read, wait for the interval before checking again. If the elapsed
recurrence budget is exhausted first, return the last observed status so the
caller can decide whether to report a timeout, keep tracking in the background,
or surface the last known state.

##### When to use it

Use this for job, export, provisioning, indexing, payment, or deployment status
polling where a `"running"` response is a successful observation, not an
exceptional failure.

It is also a good fit when operators need to answer both questions separately:
"How often do we call the status endpoint?" and "When do we stop waiting?"

##### When not to use it

Do not use this as a retry policy for a failing status endpoint. With
`Effect.repeat`, successful status values feed the schedule; a failure from the
status read stops the repeat. Add a separate retry around the read itself if
transient transport failures should be retried.

Do not treat `Schedule.during` as a hard interruption timeout for an in-flight
request. The deadline is checked at recurrence decision points after successful
observations. Use `Effect.timeout` on the status read when each request needs
its own hard deadline.

##### Schedule shape

Use `Schedule.spaced` for the gap after each successful status read, and
`Schedule.during` for the elapsed recurrence budget.

`Schedule.passthrough` makes the latest successful status the schedule output.
That lets `Schedule.while` express terminal-state detection directly against
the observed status. `Schedule.bothLeft` keeps that status as the output while
requiring both the cadence policy and the deadline policy to allow another
recurrence.

##### Example

```ts
import { Console, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

type JobStatus =
  | { readonly _tag: "Running"; readonly jobId: string }
  | { readonly _tag: "Completed"; readonly jobId: string; readonly resultId: string }
  | { readonly _tag: "Failed"; readonly jobId: string; readonly reason: string }

type StatusReadError = { readonly _tag: "StatusReadError" }

type PollDeadlineExceeded = {
  readonly _tag: "PollDeadlineExceeded"
  readonly lastStatus: JobStatus
}

let reads = 0

const readStatus = Effect.fnUntraced(function*(jobId: string) {
  reads += 1

  const status: JobStatus = reads < 3
    ? { _tag: "Running", jobId }
    : { _tag: "Completed", jobId, resultId: "result-1" }

  yield* Console.log(`read ${reads}: ${status._tag}`)
  return status
})

const cadence = Schedule.spaced("5 seconds").pipe(
  Schedule.setInputType<JobStatus>(),
  Schedule.passthrough
)

const deadline = Schedule.during("2 minutes").pipe(
  Schedule.setInputType<JobStatus>()
)

const pollEvery5SecondsForUpTo2Minutes = cadence.pipe(
  Schedule.while(({ output }) => output._tag === "Running"),
  Schedule.bothLeft(deadline)
)

const pollJob = Effect.fnUntraced(function*(jobId: string) {
  const status = yield* readStatus(jobId).pipe(
    Effect.repeat(pollEvery5SecondsForUpTo2Minutes)
  )

  if (status._tag === "Running") {
    return yield* Effect.fail(
      {
        _tag: "PollDeadlineExceeded",
        lastStatus: status
      } satisfies PollDeadlineExceeded
    )
  }

  return status
})

const program = Effect.gen(function*() {
  const fiber = yield* pollJob("job-1").pipe(Effect.forkDetach)
  yield* TestClock.adjust("10 seconds")

  const status = yield* Fiber.join(fiber)
  yield* Console.log(`poll result: ${status._tag}`)
}).pipe(
  Effect.matchEffect({
    onFailure: (error: StatusReadError | PollDeadlineExceeded) => Console.log(`poll failed with ${error._tag}`),
    onSuccess: () => Console.log("polling finished")
  }),
  Effect.provide(TestClock.layer()),
  Effect.scoped
)

Effect.runPromise(program)
```

`pollJob` performs the first read immediately. The next two reads are driven by
the five-second cadence, but `TestClock` advances those intervals instantly for
the runnable example.

The final `PollDeadlineExceeded` branch is optional but often useful. Without
it, the repeat returns the last observed `JobStatus`, which may still be
`Running` when the deadline stops the schedule.

##### Variants

For a user-facing request, use a shorter deadline and return
`PollDeadlineExceeded` with the last known status so the UI can show progress
without pretending the job failed.

For a background worker, increase the spacing and keep the same terminal-state
detection. If many workers start at the same time, apply `Schedule.jittered` to
the cadence after choosing the base interval.

If each status request also needs a per-request timeout, put `Effect.timeout` on
`readStatus`. That timeout changes the behavior of an individual status read.
The schedule still controls only the recurrence interval, deadline, and
terminal-state detection.

##### Notes and caveats

`Schedule.spaced("5 seconds")` waits five seconds after a successful status read
before the next recurrence. Use `Schedule.fixed` instead when you need
wall-clock-aligned polling boundaries.

`Schedule.during("2 minutes")` measures elapsed schedule time and stops the
repeat when the recurrence window is no longer open. It does not cancel a
status read already in progress.

`Schedule.bothLeft` has intersection semantics: both schedules must want to
recur. The combined delay is the maximum delay requested by the two schedules,
and the output kept by the repeat is the left schedule output, the latest
`JobStatus` in this recipe.

#### 23.5 Exponential backoff plus time budget

Combine a growing retry delay with an elapsed retry window when the caller cares
about bounded recovery time more than a fixed attempt count.

Use `Schedule.exponential` for the delay curve and `Schedule.during` for the
elapsed budget. Combined with `Schedule.both`, both policies must allow another
retry.

##### Problem

You are calling a dependency that sometimes returns retryable failures during
deploys, restarts, or load spikes. The caller can wait through a short recovery
window, but retrying should slow down after repeated failures and stop when that
window is exhausted.

You want one policy that makes both parts visible:

- the delay grows after each failed attempt
- the whole retry window has an elapsed-time budget
- the original attempt still runs immediately
- retrying stops when the budget is exhausted

##### When to use it

Use this recipe for idempotent dependency calls, startup checks, connection
setup, cache refresh, or background jobs where transient failure is expected but
unbounded retrying would create operational risk.

It is a good fit when the requirement is phrased as a time window: "try for up
to 30 seconds" or "give the service a short recovery window."

##### When not to use it

Do not use a time budget to retry permanent failures. Bad input, invalid
credentials, forbidden access, malformed requests, and unsafe non-idempotent
writes should be filtered before this schedule is allowed to run.

Do not treat `Schedule.during` as a timeout for an attempt that is already in
flight. A schedule is consulted between attempts; use an Effect timeout on the
attempt itself if one call needs a deadline.

Do not use `Schedule.during` alone for production retries. It describes an
elapsed window, but it does not provide useful spacing. Pair it with a delay
schedule such as `Schedule.exponential`.

##### Schedule shape

`Schedule.exponential("200 millis")` starts with a 200 millisecond delay and
then multiplies each later delay by the default factor of `2`: 200ms, 400ms,
800ms, 1.6s, and so on. By itself, it keeps recurring forever.

`Schedule.during("30 seconds")` keeps recurring while the schedule's elapsed
time is less than or equal to 30 seconds. It supplies the stopping window, not
the backoff cadence.

`Schedule.both` combines the two schedules with "both must continue" semantics.
The exponential side contributes the delay and the `during` side contributes the
elapsed budget. When the budget closes, the combined schedule stops even if the
exponential side could keep going.

This is different from an attempt count. A count limit such as
`Schedule.recurs(5)` says how many retries may be scheduled after the original
attempt. A time budget says how long the retry window may remain open. Slow
failed attempts can consume the budget before many retries happen; fast failed
attempts may fit more retries into the same budget.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class DependencyError extends Data.TaggedError("DependencyError")<{
  readonly attempt: number
}> {}

let attempts = 0

const callDependency = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`dependency attempt ${attempts}`)
  return yield* Effect.fail(new DependencyError({ attempt: attempts }))
})

const retryWithinBudget = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.during("70 millis"))
)

const program = callDependency.pipe(
  Effect.retry(retryWithinBudget),
  Effect.catch((error) => Console.log(`stopped after ${attempts} attempts; last error was attempt ${error.attempt}`))
)

Effect.runPromise(program)
// Output:
// dependency attempt 1
// dependency attempt 2
// dependency attempt 3
// dependency attempt 4
// stopped after 4 attempts; last error was attempt 4
```

The first call is immediate. After each failure, the schedule waits with
exponential backoff while the elapsed budget remains open. When the budget is
exhausted, `Effect.retry` fails with the last error, which the example logs.

In production, add error classification before or around this policy so only
retryable failures spend the budget.

##### Variants

Add an attempt cap with `Schedule.both(Schedule.recurs(n))` only when count is a
real secondary constraint. Both limits then apply: the elapsed window must still
be open, and no more than `n` retries may be scheduled after the original
attempt.

Use a shorter budget and smaller base delay for interactive paths. Use a larger
base delay for background work that should be conservative with a shared
dependency.

##### Notes and caveats

`Effect.retry` feeds failures into the schedule. If only some failures are
retryable, classify them before the schedule spends more of the budget.

`Schedule.during` measures the schedule's elapsed recurrence window. It is not
a hard wall-clock cancellation boundary for running work. If an individual
attempt also needs a deadline, apply a timeout to that effect separately.

The exact number of retries is intentionally not fixed by this recipe. The
budget is the primary limit; the exponential cadence determines how quickly
the operation consumes that budget through waiting between failed attempts.

#### 23.6 Retry with cap plus max attempts

Capped backoff combines early pressure relief with a visible ceiling on retry
delay and retry count.

This is a retry policy, so the first call still happens immediately.
`Schedule` controls only the decisions after a failure.

##### Problem

You call a dependency that may fail briefly during deploys, restarts, or load
spikes. Immediate retries create pressure, but pure exponential backoff can
eventually wait longer than the caller can tolerate. Reviewers should be able to
see both the maximum delay and the maximum number of follow-up attempts.

You want a policy that:

- starts with a small exponential delay
- never waits more than a fixed cap between retries
- stops after a fixed number of retry attempts
- makes the total number of executions obvious in code review

##### When to use it

Use this recipe for retryable, idempotent operations where a short recovery
window is useful: a control-plane request, a cache fill, a metadata fetch, or an
internal service call that sometimes returns a transient `5xx`.

It is a good default when you need a clear ceiling. For example,
`Schedule.recurs(5)` means at most five retries after the original attempt, so
the effect can execute at most six times total.

##### When not to use it

Do not use capped backoff to retry permanent failures. Bad input, authorization
failures, missing resources, and unsafe non-idempotent writes should usually fail
without retrying.

Also avoid treating the delay cap as a full request timeout. The schedule limits
the wait between retries. It does not interrupt one slow in-flight attempt.

##### Schedule shape

Start with `Schedule.exponential` for the growing delay curve. Use
`Schedule.modifyDelay` to replace any delay above the cap. Then combine the
capped delay schedule with `Schedule.recurs` so both constraints must
continue for another retry to happen.

`Schedule.both` has intersection semantics: the combined schedule recurs only
while both schedules recur, and it uses the larger of their delays. Since
`Schedule.recurs(5)` has no meaningful delay of its own, the capped backoff side
provides the wait time and the recurrence side provides the retry count.

##### Example

```ts runnable deterministic
import { Console, Duration, Effect, Schedule } from "effect"

type TransientError = {
  readonly _tag: "TransientError"
  readonly attempt: number
}

let attempts = 0

const fetchMetadata = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`metadata attempt ${attempts}`)
  return yield* Effect.fail({ _tag: "TransientError", attempt: attempts } satisfies TransientError)
})

const retryWithCappedBackoff = Schedule.exponential("10 millis").pipe(
  Schedule.modifyDelay((_, delay) => {
    const capped = Duration.min(delay, Duration.millis(40))
    return Console.log(`next delay: ${Duration.toMillis(capped)}ms`).pipe(
      Effect.as(capped)
    )
  }),
  Schedule.both(Schedule.recurs(4))
)

const program = fetchMetadata.pipe(
  Effect.retry(retryWithCappedBackoff),
  Effect.catch((error) => Console.log(`gave up after ${attempts} attempts; last error was attempt ${error.attempt}`))
)

Effect.runPromise(program)
// Output:
// metadata attempt 1
// next delay: 10ms
// metadata attempt 2
// next delay: 20ms
// metadata attempt 3
// next delay: 40ms
// metadata attempt 4
// next delay: 40ms
// metadata attempt 5
// next delay: 40ms
// gave up after 5 attempts; last error was attempt 5
```

The retry delays grow until they reach the cap, and `Schedule.recurs(4)` allows
at most four retries after the original call.

##### Variants

If you want the count limit to read as "take this many outputs from the backoff
schedule", put `Schedule.take(n)` directly on the backoff schedule. Use
`Schedule.recurs` when you want the retry-count guard to stand out as a separate
policy.

For a fleet of clients, add `Schedule.jittered` before the delay cap and keep
`Schedule.modifyDelay` after it, so randomization cannot push a computed delay
past the maximum.

##### Notes and caveats

`Effect.retry` feeds failures into the schedule. If only some errors are
retryable, classify them before applying the policy or add a schedule predicate
that stops on non-retryable failures.

`Schedule.exponential` is unbounded by itself. Pair it with `Schedule.recurs`,
`Schedule.take`, `Schedule.during`, or a domain-specific stop condition whenever
the policy can run in production.

### 24. Multi-Phase Policies

#### 24.1 Aggressive at startup, relaxed afterward

Some startup workflows benefit from a short fast phase before settling into a
calmer cadence. Model that handoff as two named schedules sequenced with
`Schedule.andThen`.

##### Problem

You need a readiness probe that catches the quick startup path without hammering
a service that takes longer to become ready. A single fast
`Schedule.spaced("100 millis")` policy is too noisy for a long startup, while a
single slow policy gives poor startup responsiveness. Scattered sleeps make the
transition hard to review.

Use a bounded warm-up phase followed by a steady-state phase: after the first
observation, check quickly for a limited number of recurrences, then check less
often.

##### When to use it

Use this recipe for readiness checks, startup dependency probes, leader election
observation, background job startup, cache warm-up, and similar workflows where
early completion is common but longer startup is still valid.

The key requirement is that both phases are operationally acceptable. The fast
phase should have a visible bound, and the relaxed phase should be slow enough
that it can continue for the expected startup window without creating avoidable
load.

##### When not to use it

Do not use this schedule to hide a failed startup. If the domain has a clear
terminal failure, stop on that value. If startup must fail after a known budget,
add `Schedule.during` or another explicit limit.

Do not apply an aggressive warm-up phase to many instances without considering
coordination. If a whole fleet starts at once, a deterministic 100 millisecond
cadence can still synchronize callers. Add jitter where that matters.

##### Schedule shape

The phase boundary belongs in the schedule, not in a loop:

1. `warmUp` is fast and finite.
2. `steadyState` is slower and may continue until the status or budget stops it.
3. `Schedule.andThen(warmUp, steadyState)` sequences the phases.
4. `Schedule.passthrough` lets the latest successful status decide whether to
   continue.
5. `Schedule.while` stops when the status is no longer a startup state.

The first effect run is not delayed. With `Effect.repeat`, the successful value
from each run is fed into the schedule. That is what allows the schedule to stop
when readiness is reached.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type Readiness =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Failed"; readonly reason: string }

const observations: ReadonlyArray<Readiness> = [
  { _tag: "Starting" },
  { _tag: "Starting" },
  { _tag: "Starting" },
  { _tag: "Starting" },
  { _tag: "Ready" }
]

let checks = 0

const checkReadiness = Effect.gen(function*() {
  const status = observations[Math.min(checks, observations.length - 1)]
  checks += 1
  yield* Console.log(`readiness check ${checks}: ${status._tag}`)
  return status
})

const warmUp = Schedule.spaced("10 millis").pipe(
  Schedule.take(3)
)

const steadyState = Schedule.spaced("40 millis")

const startupThenRelaxed = Schedule.andThen(warmUp, steadyState).pipe(
  Schedule.satisfiesInputType<Readiness>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Starting"),
  Schedule.bothLeft(
    Schedule.during("200 millis").pipe(
      Schedule.satisfiesInputType<Readiness>()
    )
  )
)

const program = Effect.repeat(checkReadiness, startupThenRelaxed).pipe(
  Effect.flatMap((status) => Console.log(`finished with ${status._tag}`))
)

Effect.runPromise(program)
// Output:
// readiness check 1: Starting
// readiness check 2: Starting
// readiness check 3: Starting
// readiness check 4: Starting
// readiness check 5: Ready
// finished with Ready
```

`program` performs one readiness check immediately. If that check returns
`Starting`, the schedule allows another check after the warm-up delay. Once the
fast phase is exhausted, the policy switches to the slower phase.

The repeat stops when `checkReadiness` returns `Ready` or `Failed`, because the
`Schedule.while` predicate only continues for `Starting`. The elapsed budget
prevents an indefinitely starting service from polling forever under this
workflow.

##### Variants

Use a smaller warm-up for user-facing paths, and a wider steady-state interval
for platform checks that can continue longer. For a fleet-wide startup policy,
add `Schedule.jittered` before the status predicate and elapsed budget.

##### Notes and caveats

`Schedule.andThen` is sequencing, not parallel composition. The second phase
does not participate until the first phase completes.

Keep the warm-up phase finite. If the first phase is an unbounded schedule, the
relaxed phase will never run.

`Schedule.take(20)` limits scheduled recurrences after the initial effect run.
It does not mean 20 total calls.

`Schedule.while` sees schedule metadata. In this recipe the predicate checks
`metadata.input`, because `Effect.repeat` feeds the successful `Readiness` value
into the schedule after each check.

The schedule controls the delay between checks. It does not time out an
individual readiness probe. If one probe can hang, apply a timeout to
`checkReadiness` itself before repeating it.

#### 24.2 Fast checks during initialization

Fast initialization checks are for dependencies that usually become ready
quickly. Keep the cadence and limits visible so the startup loop stays bounded.

##### Problem

At startup, database and broker checks may fail with `DependencyUnavailable`
while connections finish opening. Retry only that transient condition, and make
the policy answer three questions directly:

- how long to wait between checks
- how many follow-up checks are allowed
- how much startup time the check may consume

Without an explicit schedule, these rules tend to disappear into ad hoc sleeps
and counters.

##### When to use it

Use this recipe for initialization checks that are expected to settle quickly:
opening a connection pool, checking a local sidecar, validating that a required
topic exists, or confirming a warm cache is reachable.

The check must be safe to run more than once. It should observe readiness or
perform idempotent setup, not repeat a write that could create duplicate work.

##### When not to use it

Do not use a fast startup schedule for steady-state monitoring. Once the
service is running, switch to a slower runtime schedule so health checks do not
create constant pressure.

Do not retry permanent configuration failures. Missing credentials, malformed
connection strings, unsupported schema versions, and authorization failures
should fail startup immediately.

Do not treat the schedule as a hard timeout for an individual check.
`Schedule.during("2 seconds")` is evaluated at recurrence decision points. Add
a timeout to the check itself if one probe must not run too long.

##### Schedule shape

Combine a fast cadence with a retryable-error predicate, a count limit, and a
short elapsed budget.

`Schedule.spaced("100 millis")` waits briefly after each failed check.
`Schedule.while` prevents retries for permanent startup errors.
`Schedule.recurs(12)` allows at most twelve follow-up attempts.
`Schedule.during("2 seconds")` stops recurrence once the startup budget has
been used.

The `both` combinator gives intersection semantics: the retry continues only
while all pieces of the policy still allow another recurrence.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type StartupCheckError =
  | { readonly _tag: "DependencyUnavailable"; readonly dependency: string }
  | { readonly _tag: "InvalidConfiguration"; readonly message: string }

let databaseChecks = 0

const checkDatabase: Effect.Effect<void, StartupCheckError> = Effect.gen(function*() {
  databaseChecks += 1
  yield* Console.log(`database check ${databaseChecks}`)
  if (databaseChecks < 3) {
    return yield* Effect.fail(
      {
        _tag: "DependencyUnavailable",
        dependency: "database"
      } as const
    )
  }
})

const checkMessageBroker: Effect.Effect<void, StartupCheckError> = Console.log("broker check ok")

const startupChecks = Effect.fnUntraced(function*() {
  yield* checkDatabase
  yield* checkMessageBroker
})

const fastInitializationChecks = Schedule.spaced("20 millis").pipe(
  Schedule.satisfiesInputType<StartupCheckError>(),
  Schedule.while(({ input }) => input._tag === "DependencyUnavailable"),
  Schedule.both(Schedule.recurs(12)),
  Schedule.both(
    Schedule.during("200 millis").pipe(
      Schedule.satisfiesInputType<StartupCheckError>()
    )
  )
)

const initialize = startupChecks().pipe(
  Effect.retry(fastInitializationChecks)
)

const program = Effect.gen(function*() {
  yield* initialize
  yield* Console.log("initialized")
})

Effect.runPromise(program)
// Output:
// database check 1
// database check 2
// database check 3
// broker check ok
// initialized
```

`initialize` runs the first startup check immediately. If a dependency is not
available yet, it retries while the count and elapsed limits both still allow
another attempt. If the check fails with
`InvalidConfiguration`, the schedule stops and the original failure is returned.

##### Variants

For a purely local readiness check, reduce the delay and count, for example
`Schedule.spaced("25 millis").pipe(Schedule.both(Schedule.recurs(8)))`.
Keep the elapsed budget short so startup failure is reported quickly.

For startup across many replicas, add `Schedule.jittered` after the cadence is
correct. Jitter spreads retries so a fleet does not hit the same dependency in
lockstep during a rollout.

For checks that may hang, place `Effect.timeout` on the checked effect before
`Effect.retry`. The timeout bounds one probe; the schedule bounds the retry
window.

##### Notes and caveats

`Effect.retry` feeds failures into the schedule. That is why the error type is
made explicit with `Schedule.satisfiesInputType<StartupCheckError>()` before
reading `metadata.input` in `Schedule.while`.

The schedule does not delay the first check. It only decides whether to perform
another check after a failure.

The elapsed budget is checked between attempts. Time spent inside each startup
check contributes to the elapsed schedule time before the next recurrence
decision, but the schedule does not interrupt an in-flight check.

#### 24.3 Slow background cadence after readiness

Readiness and monitoring are different phases: check quickly until the
dependency is ready, then observe at a slower cadence. `Schedule.andThen` makes
that phase transition explicit.

##### Problem

A worker cannot do useful work until a dependency returns `Ready`. Probing too
slowly delays useful work, but keeping the startup cadence after readiness only
creates noise and unnecessary load.

The recurrence policy should make that operational intent visible:

- fast checks while readiness is still pending
- a clear switch once `Ready` is observed
- slow, steady background monitoring afterward

##### When to use it

Use this recipe for service readiness checks, cache warm-up probes,
leader-election status checks, or control-plane watches where startup latency
matters but long-term polling pressure should stay low.

It is especially useful when the same effect can be repeated in both phases:
first to discover readiness, then to continue observing the dependency at a
maintenance cadence.

##### When not to use it

Do not use this as a substitute for a real startup deadline. If the service must
fail fast when readiness never arrives, add an outer timeout or a separate
startup budget around the readiness workflow.

Also avoid polling when the dependency can push a readiness signal, emit an
event, or complete a handshake directly. In those cases, a schedule may be
unnecessary background work.

##### Schedule shape

The startup phase uses `Schedule.spaced("250 millis")` so each
failed-to-be-ready observation is followed by a short pause. `Schedule.passthrough`
makes the successful value from the repeated effect available as the schedule
output, and `Schedule.while` stops the startup phase once that value is `Ready`.

The steady-state phase uses a slower `Schedule.spaced("30 seconds")`. Because
it is sequenced with `Schedule.andThen`, it starts only after the startup phase
completes.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type Readiness =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready" }

let probes = 0

const probeDependency = Effect.gen(function*() {
  probes += 1
  const status: Readiness = probes < 3
    ? { _tag: "Starting" }
    : { _tag: "Ready" }
  yield* Console.log(`probe ${probes}: ${status._tag}`)
  return status
})

const waitUntilReady = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<Readiness>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag !== "Ready")
)

const backgroundCadence = Schedule.spaced("40 millis").pipe(
  Schedule.take(3),
  Schedule.satisfiesInputType<Readiness>()
)

const readinessThenBackground = Schedule.andThen(
  waitUntilReady,
  backgroundCadence
)

const program = Effect.repeat(
  probeDependency,
  readinessThenBackground
).pipe(
  Effect.flatMap(() => Console.log("background monitoring sample finished"))
)

Effect.runPromise(program)
// Output:
// probe 1: Starting
// probe 2: Starting
// probe 3: Ready
// probe 4: Ready
// probe 5: Ready
// probe 6: Ready
// background monitoring sample finished
```

The example bounds the background phase with `Schedule.take(3)` so it terminates
in `scratchpad/repro.ts`. A daemon would usually omit that bound and let scope
or supervision own the lifetime.

##### Variants

Use a shorter startup spacing when local readiness usually appears almost
immediately, and a longer spacing when the check itself is expensive. For
fleet-wide background monitoring, apply `Schedule.jittered` to the steady-state
cadence so ready instances do not all probe on the same boundary.

If the monitoring must run on wall-clock intervals, use `Schedule.fixed` for
the background phase instead of `Schedule.spaced`. `Schedule.fixed` targets
interval boundaries; `Schedule.spaced` waits after each probe completes.

##### Notes and caveats

`Effect.repeat` feeds each successful `probeDependency` value into the schedule.
That is what lets `waitUntilReady` inspect `Readiness` and complete when it sees
`Ready`.

The schedule does not make the first probe wait. The effect runs once, then the
schedule decides whether and when to run it again. After `Ready` is observed,
the sequenced schedule switches from startup responsiveness to slow background
cadence.

#### 24.4 Immediate retries first, backoff later

Some transient failures clear before a meaningful delay would help: a stale
pooled connection, a dependency that just became reachable, or a short
optimistic-concurrency conflict. A small immediate retry burst is reasonable
there, but only while the failure still looks brief.

If the failure survives that burst, switch to backoff. `Schedule.andThen`
models that handoff directly: one schedule runs to completion, then the next
schedule starts.

##### Problem

Build a retry policy with two visible phases: a bounded zero-delay burst, then
a bounded exponential backoff. If both phases are exhausted, `Effect.retry`
returns the last typed failure.

##### When to use it

Use this when one or two instant retries are acceptable, but continued failure
means the dependency needs time. It fits idempotent reads, health checks, cache
refreshes, and small remote calls. Idempotent means repeating the operation has
the same externally visible result as running it once.

##### When not to use it

Do not use this for permanent failures such as validation errors, authorization
failures, malformed requests, missing configuration, or non-idempotent writes.
Classify those before applying the schedule.

Do not make the immediate phase large. If you need many retries, start with
spacing or backoff instead.

##### Schedule shape

`Schedule.recurs(2)` allows two retry decisions after the original attempt.
`Schedule.exponential(...).pipe(Schedule.take(4))` allows four delayed retries.
Sequencing them with `Schedule.andThen` keeps the phase boundary reviewable.

For `Effect.retry`, the original effect execution is not counted by the
schedule. The schedule starts only after a typed failure.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly status: number
  readonly message: string
}> {}

let attempts = 0

const callGateway = Effect.gen(function*() {
  attempts++
  yield* Console.log(`gateway attempt ${attempts}`)

  if (attempts <= 4) {
    return yield* Effect.fail(
      new GatewayError({
        status: 503,
        message: `temporary failure ${attempts}`
      })
    )
  }

  return `gateway succeeded on attempt ${attempts}`
})

const isRetryable = (error: GatewayError) =>
  error.status === 408 ||
  error.status === 429 ||
  error.status >= 500

const immediateRetries = Schedule.recurs(2)

const delayedBackoff = Schedule.exponential("20 millis").pipe(
  Schedule.take(4)
)

const immediateThenBackoff = immediateRetries.pipe(
  Schedule.andThen(delayedBackoff),
  Schedule.satisfiesInputType<GatewayError>(),
  Schedule.while(({ input }) => isRetryable(input))
)

const program = callGateway.pipe(
  Effect.retry(immediateThenBackoff),
  Effect.flatMap((result) => Console.log(result))
)

Effect.runPromise(program)
// Output:
// gateway attempt 1
// gateway attempt 2
// gateway attempt 3
// gateway attempt 4
// gateway attempt 5
// gateway succeeded on attempt 5
```

The retry sequence is:

- attempt 1: run `callGateway`
- retry 1: immediate, if the first attempt fails with a retryable `GatewayError`
- retry 2: immediate, if the second attempt fails with a retryable `GatewayError`
- retry 3: wait according to the first backoff delay
- retry 4 and later: continue the bounded backoff phase

If all retry decisions are exhausted, `Effect.retry` returns the last typed
failure. If `isRetryable` returns `false`, the schedule stops immediately and
that failure is returned without entering the remaining phase.

##### Variants

For a user-facing request, reduce the backoff phase or add a short elapsed
budget with `Schedule.during`, so the caller gets a clear answer quickly.

For a fleet-wide remote dependency, consider adding `Schedule.jittered` to the
backoff phase after the base cadence is correct. Jitter means randomizing each
delay slightly to avoid synchronized retries across many instances. It belongs
in the delayed phase; adding randomness to the immediate burst weakens the
"immediate first" contract.

For startup checks, the immediate phase can be slightly larger when the
operation is local and cheap. Keep the backoff phase explicit so later startup
failure does not spin.

##### Notes and caveats

`Schedule.recurs(2)` means two retry decisions after the original attempt, not
two total executions.

`Schedule.exponential(...)` recurs forever by itself, so the example uses
`Schedule.take(4)` to bound the delayed phase.

`Schedule.andThen` is sequential composition, not parallel composition. Use it
when phase order is part of the policy. Use combinators such as `Schedule.both`
when two constraints should apply at the same time.

#### 24.5 Fast polling first, slower polling later

Some polling workflows need a brief responsive phase, then a calmer cadence. A
newly submitted export, payment, cache refresh, or provisioning request may
complete almost immediately. If it does not, polling every few hundred
milliseconds quickly becomes wasteful.

Use `Schedule.andThen` to run the fast polling phase to completion, then switch
to the slower phase.

##### Problem

Model a status loop without scattering sleeps, counters, or phase flags through
the polling code. The first status read should happen immediately; the schedule
describes only follow-up reads and stop conditions.

##### When to use it

Use this when a workflow has two natural operational phases:

- an early user-facing window where low latency matters
- a later background window where reducing load matters more

This is a good fit for jobs that often finish in the first few seconds but may
occasionally take minutes, such as exports, media processing, payment
settlement, indexing, cache warmups, and cloud provisioning.

##### When not to use it

Do not use this when the remote system already provides a callback, queue
message, webhook, or subscription that can replace polling.

Do not make the fast phase unbounded. Give it a small recurrence cap so a slow
workflow does not keep hammering the status endpoint.

Do not use this schedule by itself to retry failed status reads. `Effect.repeat`
feeds successful values into the schedule. Transport failures, authorization
failures, and decoding failures remain in the effect failure channel and should
be classified separately if they need their own retry policy.

##### Schedule shape

Build each phase separately, then sequence them. `Schedule.passthrough` changes
the schedule output to the latest successful status value, so `Effect.repeat`
returns the last observation. `Schedule.while` stops as soon as a terminal
status is observed.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type Status =
  | { readonly _tag: "Running"; readonly progress: number }
  | { readonly _tag: "Completed"; readonly resultId: string }
  | { readonly _tag: "Failed"; readonly reason: string }

type StatusReadError = {
  readonly _tag: "StatusReadError"
  readonly message: string
}

const observations: ReadonlyArray<Status> = [
  { _tag: "Running", progress: 10 },
  { _tag: "Running", progress: 35 },
  { _tag: "Running", progress: 70 },
  { _tag: "Completed", resultId: "export-123" }
]

let reads = 0

const readStatus = (jobId: string): Effect.Effect<Status, StatusReadError> =>
  Effect.gen(function*() {
    const status = observations[Math.min(reads, observations.length - 1)]
    reads++
    yield* Console.log(`${jobId}: read ${reads} -> ${status._tag}`)
    return status
  })

const fastPhase = Schedule.spaced("20 millis").pipe(
  Schedule.take(3)
)

const slowPhase = Schedule.spaced("60 millis").pipe(
  Schedule.both(Schedule.during("500 millis"))
)

const fastThenSlowPolling = Schedule.andThen(fastPhase, slowPhase).pipe(
  Schedule.satisfiesInputType<Status>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Running")
)

export const pollJob = (jobId: string) =>
  readStatus(jobId).pipe(
    Effect.repeat(fastThenSlowPolling)
  )

const program = pollJob("job-1").pipe(
  Effect.flatMap((status) => Console.log(`final status: ${status._tag}`))
)

Effect.runPromise(program)
// Output:
// job-1: read 1 -> Running
// job-1: read 2 -> Running
// job-1: read 3 -> Running
// job-1: read 4 -> Completed
// final status: Completed
```

`pollJob` reads the status immediately. If that first read is already
`"Completed"` or `"Failed"`, the repeat stops without waiting. If the job is
still `"Running"`, the schedule performs a short burst of fast spacing, then
moves to slower spacing.

The returned effect succeeds with the latest observed `Status`. That value can
be terminal, or it can still be `"Running"` if the slow phase exhausts its
budget before completion.

##### Variants

Use fewer fast recurrences when the endpoint is expensive or globally rate
limited. For example, four recurrences at 500 milliseconds still gives a short
responsive window without producing as much request pressure.

Use a longer slow interval for back-office workflows where completion can be
reported later. A 30 second or 1 minute slow phase is often more appropriate for
large exports, media processing, or asynchronous reconciliation.

Add `Schedule.jittered` to the slow phase when many clients may start polling at
roughly the same time. Jitter is usually more important in the slow phase
because that phase contains the long-lived population of pollers.

Use `Schedule.andThenResult` instead of `Schedule.andThen` when you need the
schedule output to preserve which phase produced it. For ordinary polling, the
phase is often less important than returning the latest observed status, so
`Schedule.passthrough` keeps the code simpler.

##### Notes and caveats

`Schedule.andThen` is phase sequencing, not intersection. The slow phase does
not start until the fast phase completes.

`Schedule.spaced` waits after each successful status read completes. Use
`Schedule.fixed` only when the policy must target fixed wall-clock boundaries.

The elapsed budget on `slowPhase` starts when that phase starts. If the whole
polling operation needs one overall deadline, combine the sequenced cadence with
a separate outer budget.

When a schedule reads `metadata.input`, constrain the input type before
`Schedule.while`. In this recipe, `Schedule.satisfiesInputType<Status>()` makes
the successful status values visible to the predicate.

#### 24.6 Phase-based control for long workflows

Long-running workflows often need more than one recurrence shape. The first few
minutes may need frequent observations because users are waiting for visible
progress. After that, the workflow may still be healthy, but checking it too
often only adds load. Much later, the policy may become a watchdog: keep enough
visibility to notice completion or failure, but do not pretend the workflow is
still latency-sensitive.

Model those phases as schedule values instead of encoding them with counters,
mutable phase flags, and scattered sleeps. Each phase can say how often it
recurs and when it is exhausted, and `Schedule.andThen` makes the handoff from
one phase to the next explicit.

##### Problem

Build a single polling schedule for follow-up status reads. The first status
read should happen immediately, so the schedule should describe only later reads
and their stopping conditions:

- a responsive phase while fast completion is common
- a steady phase while the workflow is still expected to finish normally
- a watchdog phase for long tails
- an overall budget that stops the whole policy

##### When to use it

Use this recipe for workflows where operational expectations change over time:
exports, imports, media processing, indexing jobs, data backfills, provisioning
requests, settlement flows, and asynchronous reconciliations.

It is especially useful when the same status endpoint serves both a user-visible
experience and a background monitoring path. The schedule keeps the early user
experience responsive without keeping the later background phase aggressive.

##### When not to use it

Do not poll when the producer can reliably notify you with a webhook, queue
message, subscription, or durable completion event.

Do not use a long watchdog phase to hide a workflow that should have a real
deadline. If the business rule says the workflow must finish within 30 minutes,
make that deadline part of the workflow state or the outer effect, not just a
large polling schedule.

Do not use this schedule to retry failed status reads. `Effect.repeat` feeds
successful status values into the schedule. Transport failures, decoding
failures, and authorization failures stay in the failure channel and need their
own retry or error handling policy if they are recoverable.

##### Schedule shape

Build the cadence from named phases and sequence them with `Schedule.andThen`.
The steady phase does not start until the responsive phase is exhausted, and the
watchdog phase does not start until the steady phase is exhausted. Then combine
that cadence with constraints that apply to the whole polling policy:

- `Schedule.during("2 hours")` gives the whole schedule an elapsed-time budget.
- `Schedule.both` requires both the cadence and the budget to continue.
- `Schedule.passthrough` returns the latest successful workflow status.
- `Schedule.while` stops as soon as the workflow is no longer running.

##### Example

```ts
import { Console, Effect, Schedule } from "effect"

type WorkflowStatus =
  | {
    readonly _tag: "Running"
    readonly phase: "Queued" | "Processing" | "Finalizing"
    readonly progress: number
  }
  | { readonly _tag: "Completed"; readonly artifactId: string }
  | { readonly _tag: "Failed"; readonly reason: string }

type StatusReadError = {
  readonly _tag: "StatusReadError"
  readonly message: string
}

const observations: ReadonlyArray<WorkflowStatus> = [
  { _tag: "Running", phase: "Queued", progress: 0 },
  { _tag: "Running", phase: "Processing", progress: 25 },
  { _tag: "Running", phase: "Processing", progress: 60 },
  { _tag: "Running", phase: "Finalizing", progress: 90 },
  { _tag: "Completed", artifactId: "artifact-123" }
]

let reads = 0

const readWorkflowStatus = (
  workflowId: string
): Effect.Effect<WorkflowStatus, StatusReadError> =>
  Effect.gen(function*() {
    const status = observations[Math.min(reads, observations.length - 1)]
    reads++
    yield* Console.log(`${workflowId}: observation ${reads} -> ${status._tag}`)
    return status
  })

const responsivePhase = Schedule.spaced("20 millis").pipe(
  Schedule.take(2)
)

const steadyPhase = Schedule.spaced("50 millis").pipe(
  Schedule.jittered,
  Schedule.take(2)
)

const watchdogPhase = Schedule.spaced("100 millis").pipe(
  Schedule.jittered,
  Schedule.take(2)
)

const phasedCadence = responsivePhase.pipe(
  Schedule.andThen(steadyPhase),
  Schedule.andThen(watchdogPhase)
)

const longWorkflowPolicy = phasedCadence.pipe(
  Schedule.both(Schedule.during("1 second")),
  Schedule.satisfiesInputType<WorkflowStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Running")
)

export const pollWorkflow = (workflowId: string) =>
  readWorkflowStatus(workflowId).pipe(
    Effect.repeat(longWorkflowPolicy)
  )

const program = pollWorkflow("workflow-1").pipe(
  Effect.flatMap((status) => Console.log(`final workflow status: ${status._tag}`))
)

Effect.runPromise(program)
```

`pollWorkflow` reads once immediately. If that first read returns
`"Completed"` or `"Failed"`, the repeat stops without waiting. If the workflow
is still `"Running"`, the schedule starts with responsive spacing, moves to a
steady cadence, then moves to watchdog checks.

The effect succeeds with the latest observed `WorkflowStatus`. That may be a
terminal status, or it may still be `"Running"` if the phase limits or the
overall budget are exhausted before the workflow reaches a terminal state.

##### Variants

For a user-facing request, shorten the overall budget and the watchdog phase.
The user experience should usually return a clear "still running" response
rather than hold a request open for the full operational tail.

For a back-office worker, lengthen the steady and watchdog phases but keep the
phase limits explicit. Long-running does not have to mean unbounded.

For fleet-wide polling, keep jitter on the longer phases. The responsive phase
is short-lived, but the steady and watchdog phases contain the larger population
of long-lived pollers, so they are where synchronized checks create the most
load.

For phase-specific telemetry, use `Schedule.andThenResult` instead of
`Schedule.andThen` on the boundary you need to observe. The result identifies
which side of the phase boundary produced the schedule output, which is useful
when metrics need separate labels for responsive, steady, and watchdog
behavior.

##### Notes and caveats

`Schedule.take(n)` limits the recurrences in that phase. It does not count the
initial status read before `Effect.repeat` starts using the schedule.

`Schedule.during` measures elapsed time for the schedule it is combined with.
When it is added outside the phased cadence with `Schedule.both`, it acts as an
overall budget rather than a per-phase budget.

`Schedule.spaced` waits after each status read completes. If the status read
itself can hang, put a timeout on `readWorkflowStatus`; the schedule controls
the delay between reads, not the duration of an individual read.

Keep the terminal-state predicate near the schedule. The phase limits answer
"how long and how often should we observe?" The `Schedule.while` predicate
answers "is another observation still useful?"

### 25. Express Operational Intent

#### 25.1 “Try hard, but only briefly”

Some failures deserve a real effort, but not a long wait. A request can hit a
short restart, a just-rotated connection, or a cache entry that is about to
appear. In those cases, the useful policy is not "retry forever" or "retry once"
but "try a few quick times inside a tiny window, then give the caller the
failure."

Model that operational phrase as a composed schedule. One piece says how hard
to try, another says how brief the window is, and `Schedule.both` makes both
limits visible in the policy.

##### Problem

Turn that operational phrase into concrete limits for a retry schedule. The
policy should answer three questions directly:

- how quickly to retry after a failure
- how many follow-up attempts are allowed
- how long the whole retry window may stay open

The first attempt still runs immediately. `Schedule` controls only the
decisions after a typed failure.

##### When to use it

Use this recipe for cheap, idempotent operations where a short recovery window
is useful: reading from a local service, fetching small metadata, refreshing a
cache value, or calling an internal dependency during a deploy.

It is a good fit when "try hard" means several quick attempts, not minutes of
persistence. For example, `Schedule.recurs(4)` means up to four retries after
the original attempt, so the effect can execute at most five times total.

##### When not to use it

Do not use this for permanent failures. Bad input, authorization failures,
missing resources, and rejected business rules should usually fail without a
retry policy.

Do not use it for expensive or unsafe operations unless the unit being retried
is idempotent. A short schedule can still repeat a side effect several times.

Also avoid this policy when the dependency is already overloaded. In that case,
"try hard" can make the outage worse; use a slower backoff policy with jitter
instead.

##### Schedule shape

Compose a short fast cadence with a retry-count limit and an elapsed-time
budget. `Schedule.exponential("50 millis")` starts with a small delay and
increases it on each recurrence. `Schedule.recurs(4)` bounds the number of
retries. `Schedule.during("500 millis")` bounds the retry window.

`Schedule.both` gives intersection semantics: the combined schedule recurs only
while both sides still want to recur, and it uses the larger delay from the
pieces being combined. The result is a policy that tries quickly, stops by
count, and also stops when the short time budget is exhausted.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type DependencyError = {
  readonly _tag: "DependencyUnavailable"
  readonly service: string
}

let attempts = 0

const readFromDependency = Effect.gen(function*() {
  attempts++
  yield* Console.log(`read attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(
      {
        _tag: "DependencyUnavailable",
        service: "catalog"
      } satisfies DependencyError
    )
  }

  return "catalog metadata"
})

const tryHardButBriefly = Schedule.exponential("20 millis").pipe(
  Schedule.both(Schedule.recurs(4)),
  Schedule.both(Schedule.during("250 millis"))
)

const program = readFromDependency.pipe(
  Effect.retry(tryHardButBriefly),
  Effect.flatMap((value) => Console.log(`result: ${value}`))
)

Effect.runPromise(program)
// Output:
// read attempt 1
// read attempt 2
// read attempt 3
// read attempt 4
// result: catalog metadata
```

`program` performs the first dependency read immediately. If it fails with
`DependencyUnavailable`, the retry policy starts with a small delay, then grows
from there, while the count limit and elapsed budget both remain open. If either
limit is exhausted, `Effect.retry` returns the last typed failure.

##### Variants

For an even tighter user-facing path, reduce the budget and retry count, for
example `Schedule.exponential("25 millis")` with `Schedule.recurs(2)` and a
`Schedule.during("150 millis")` budget.

For a small background task where a brief recovery window is still acceptable,
increase the budget slightly but keep the policy visibly bounded.

If many clients or workers can hit the same dependency at once, add
`Schedule.jittered` after the basic cadence and limits are correct.

##### Notes and caveats

`Schedule.during` is checked at recurrence decision points. It does not
interrupt an in-flight dependency call. If one attempt also needs a hard
deadline, add a timeout to the effect being retried.

`Schedule.recurs` counts retries after the original attempt. With
`Schedule.recurs(4)`, the effect can run up to five times total.

`Effect.retry` feeds failures into the schedule. Classify permanent failures
before applying this policy, or use a schedule predicate when only some typed
errors are retryable.

#### 25.2 “Keep trying, but never aggressively”

Some work should keep trying for as long as the process is alive, but it should
never turn a failure into pressure on an already weak dependency. Use a slow
`Schedule.spaced` cadence when persistence matters more than fast recovery.

Read the policy as: after each retryable failure, wait for a deliberate pause
before trying again. `Schedule.jittered` keeps the delay near that cadence while
preventing a fleet of workers from retrying at exactly the same instant.

##### Problem

Apply this shape to background work such as refreshing a cache, reconnecting to
a secondary service, resending an idempotent notification, or checking whether a
dependency has come back.

The policy should make three facts visible:

- retryable failures may be retried indefinitely
- every retry leaves a deliberate pause
- non-retryable failures still stop immediately

##### When to use it

Use this recipe for non-interactive workflows where eventual recovery is useful
and latency is not the primary concern. It is a good fit for background workers,
maintenance loops, cache warmers, telemetry delivery, and other idempotent work
that should continue quietly after transient outages.

Use it when the operational requirement sounds like "keep trying in the
background" or "do not page someone just because the dependency was unavailable
for a while."

##### When not to use it

Do not use this for user-facing requests that need a timely answer. A persistent
retry policy can leave the caller waiting forever unless the surrounding effect
has its own timeout or cancellation boundary.

Do not use it to retry permanent failures. Invalid configuration, malformed
input, missing authorization, and unsafe non-idempotent writes should be
classified before this schedule is applied.

Do not use a short spacing just because the schedule is simple. If the work is
allowed to continue forever, the delay should be generous enough to be safe
during an extended outage.

##### Schedule shape

`Schedule.spaced("30 seconds")` recurs indefinitely and waits 30 seconds between
recurrence decisions. With `Effect.retry`, the first execution of the effect is
still immediate; the schedule controls only the retries after failures.

`Schedule.jittered` adjusts each computed delay to a random value between 80%
and 120% of the original delay. For a 30 second base cadence, retries happen
roughly between 24 and 36 seconds apart. That keeps the policy low pressure
while avoiding synchronized retries across many workers.

There is intentionally no `Schedule.recurs` or `Schedule.during` in the base
policy. Persistence is the point of this recipe. The stopping condition belongs
to error classification, shutdown, cancellation, or a separate business rule.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class DeliveryError extends Data.TaggedError("DeliveryError")<{
  readonly reason: "Network" | "Unavailable" | "BadRecipient" | "InvalidPayload"
}> {}

let attempts = 0

const deliverNotification = Effect.gen(function*() {
  attempts++
  yield* Console.log(`delivery attempt ${attempts}`)

  if (attempts < 4) {
    return yield* Effect.fail(
      new DeliveryError({ reason: "Unavailable" })
    )
  }

  yield* Console.log("notification delivered")
})

const isRecoverable = (error: DeliveryError) => error.reason === "Network" || error.reason === "Unavailable"

const lowPressureRetry = Schedule.spaced("40 millis").pipe(
  Schedule.jittered
)

const program = deliverNotification.pipe(
  Effect.retry({
    schedule: lowPressureRetry,
    while: isRecoverable
  })
)

Effect.runPromise(program)
// Output:
// delivery attempt 1
// delivery attempt 2
// delivery attempt 3
// delivery attempt 4
// notification delivered
```

The demo uses a short delay so it terminates quickly. In production, choose a
low-pressure interval such as 30 seconds or several minutes. The first delivery
attempt runs immediately. If it fails with `Network` or `Unavailable`, the
program waits for the spaced cadence and tries again.

If the delivery succeeds, `program` succeeds. If the error is `BadRecipient` or
`InvalidPayload`, the retry predicate returns `false` and `program` fails with
that error instead of spending more time on a permanent problem.

##### Variants

Use a longer spacing when the dependency is shared or expensive. A five-minute
cadence can be appropriate for secondary background recovery.

Add an elapsed budget only when persistence is no longer the requirement. A
policy that combines `Schedule.spaced("30 seconds")`, `Schedule.jittered`, and
`Schedule.during("1 hour")` still retries gently, but it stops once the elapsed
window is closed.

Use an exponential policy when fast early recovery matters. That is a different
operational promise: it tries sooner at first, then backs off, and eventually
gives up.

##### Notes and caveats

`Effect.retry` feeds failures into the schedule. The `while` predicate is where
this recipe separates recoverable operational failures from permanent domain
failures.

`Schedule.spaced` waits after a failed attempt completes. It does not place a
timeout on an attempt that is already running. Add a timeout to
`deliverNotification` itself if each attempt needs a maximum duration.

Because this policy can retry forever, observability matters. Log or metric the
failure near the effect being retried, but keep the schedule focused on the
recurrence policy: low-pressure spacing, jitter, and no artificial retry count.

#### 25.3 “Be responsive first, conservative later”

Some failures are worth a fast second look, but not an indefinitely fast one. A
cache refresh, leader-election read, or request to a nearby dependency might
clear on the next attempt. If it does not, the policy should slow down before it
adds pressure to the same system it is waiting on.

Encode that intent as phases: a responsive phase first, then a conservative
phase. The schedule value tells the reader when the workflow switches from "try
again soon" to "back off and give the dependency room."

##### Problem

A single exponential schedule can express growing delay, but it does not name
the operational transition. Put that transition in the schedule value so the
responsive and conservative phases can be tuned independently.

##### When to use it

Use this when the first few failures are likely to be local, brief, or caused by
startup ordering, but continued failure should be treated as pressure on a
shared dependency. It is a good fit for retries around idempotent reads,
connection establishment, cache warming, discovery calls, and background
reconciliation loops.

##### When not to use it

Do not use this to blur permanent failures into retryable failures. Validation
errors, authorization failures, malformed requests, and unsafe non-idempotent
writes should be classified before the schedule is applied.

Avoid this shape when the caller needs a strict latency budget. In that case,
compose the retry schedule with a time limit or move the work out of the request
path.

##### Schedule shape

Build two named schedules and sequence them with `Schedule.andThen`.

- The first phase is short and responsive. It uses a small exponential delay and
  a low `Schedule.take` count.
- The second phase is conservative. It starts at a larger delay and is also
  bounded.

`Schedule.andThen(first, second)` runs the first schedule to completion, then
continues with the second schedule. The first execution of the effect is not
part of the schedule; the schedule controls the follow-up attempts after each
failure.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type TransientError = { readonly _tag: "TransientError" }

let attempts = 0

const refreshRemoteSnapshot = Effect.gen(function*() {
  attempts++
  yield* Console.log(`refresh attempt ${attempts}`)

  if (attempts < 5) {
    return yield* Effect.fail(
      {
        _tag: "TransientError"
      } satisfies TransientError
    )
  }

  return "snapshot refreshed"
})

const responsivePhase = Schedule.exponential("15 millis").pipe(
  Schedule.take(3)
)

const conservativePhase = Schedule.exponential("80 millis").pipe(
  Schedule.take(4)
)

const responsiveThenConservative = Schedule.andThen(
  responsivePhase,
  conservativePhase
)

const program = refreshRemoteSnapshot.pipe(
  Effect.retry(responsiveThenConservative),
  Effect.flatMap((value) => Console.log(value))
)

Effect.runPromise(program)
// Output:
// refresh attempt 1
// refresh attempt 2
// refresh attempt 3
// refresh attempt 4
// refresh attempt 5
// snapshot refreshed
```

The first few retry decisions come from the responsive phase. If the operation
keeps failing, the conservative phase takes over with larger delays and its own
limit.

##### Variants

For user-facing requests, keep both phases small or add an outer timeout around
the whole operation so the caller gets a predictable answer.

For background workers, make the conservative phase longer and add logging or
metrics with `Schedule.tapInput` or `Schedule.tapOutput`.

For fleet-wide retries, add jitter after the base cadence is correct so many
instances do not retry at the same boundaries.

If operators need to distinguish the phase in telemetry, use
`Schedule.andThenResult` instead of `Schedule.andThen`; its output records
whether the current recurrence came from the first or second phase.

##### Notes and caveats

With `Effect.retry`, failures are fed into the schedule. That matters if you
observe inputs with `Schedule.tapInput` or stop based on the error value with
`Schedule.while`. Keep error classification close to the effect being retried,
then let the schedule describe only recurrence mechanics: responsive phase,
conservative phase, and final stop condition.

#### 25.4 “Avoid overload at all costs”

When the requirement is "avoid overload at all costs", the retry policy should
prefer giving up over adding pressure to a dependency that is already
struggling. That means conservative spacing, increasing waits, fleet-wide
desynchronization, and explicit limits.

Use the schedule to make that operational promise reviewable. A reader should
be able to see the first retry delay, the backoff curve, the maximum final
delay, the retry count, and the elapsed budget without hunting through a custom
loop.

##### Problem

Define a retry schedule for callers seeing a slow, unavailable, or rate-limited
downstream service. The schedule must make overload control explicit:
conservative initial delay, growing waits, jitter, a maximum wait, and finite
count and time limits.

##### When to use it

Use this for shared infrastructure paths where extra traffic is more dangerous
than a delayed or failed caller response: broker reconnects, cache refreshes,
webhook delivery, background synchronization, dependency readiness checks, and
batch workers.

It is especially useful when many processes may observe the same outage at the
same time. The policy should spread retries across the fleet and cap the amount
of work each caller contributes.

##### When not to use it

Do not use this policy for validation failures, authorization failures,
permanent configuration errors, or unsafe non-idempotent writes. Classify those
before retrying and fail without entering the schedule.

Do not treat client-side backoff as admission control. It reduces retry
pressure, but it does not replace server-side rate limits, quotas, queues,
backpressure, load shedding, or circuit breaking.

##### Schedule shape

Start with a slow exponential backoff, add jitter, cap the final delay, and add
both count and elapsed-time limits. `Schedule.exponential("2 seconds")` starts
with a two-second delay and then grows by the default factor of `2`. That is
intentionally slower than a latency-oriented retry policy.

`Schedule.jittered` adjusts each recurrence delay between 80% and 120% of the
incoming delay. If many workers fail at the same time, their later retries are
less likely to stay synchronized.

Use `Schedule.modifyDelay` to cap the final delay after jitter. Add
`Schedule.recurs` and `Schedule.during` with `Schedule.both` so the policy stops
when either the retry count or elapsed budget is exhausted.

##### Example

```ts runnable deterministic
import { Console, Duration, Effect, Schedule } from "effect"

type InventorySnapshot = {
  readonly sku: string
  readonly available: number
}

type DownstreamError =
  | { readonly _tag: "Timeout"; readonly service: string }
  | { readonly _tag: "Unavailable"; readonly service: string }
  | { readonly _tag: "RateLimited"; readonly service: string }
  | { readonly _tag: "Rejected"; readonly service: string }

const isRetryable = (error: DownstreamError): boolean =>
  error._tag === "Timeout" ||
  error._tag === "Unavailable" ||
  error._tag === "RateLimited"

let attempts = 0

const loadInventorySnapshot = Effect.gen(function*() {
  attempts++
  yield* Console.log(`inventory attempt ${attempts}`)

  if (attempts === 1) {
    return yield* Effect.fail(
      {
        _tag: "RateLimited",
        service: "inventory"
      } satisfies DownstreamError
    )
  }
  if (attempts < 4) {
    return yield* Effect.fail(
      {
        _tag: "Unavailable",
        service: "inventory"
      } satisfies DownstreamError
    )
  }

  return {
    sku: "sku-123",
    available: 42
  } satisfies InventorySnapshot
})

const avoidOverloadRetryPolicy = Schedule.exponential("40 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(120)))),
  Schedule.both(Schedule.recurs(8)),
  Schedule.both(Schedule.during("500 millis"))
)

const program = loadInventorySnapshot.pipe(
  Effect.retry({
    schedule: avoidOverloadRetryPolicy,
    while: isRetryable
  }),
  Effect.flatMap((snapshot) => Console.log(`${snapshot.sku}: ${snapshot.available} available`))
)

Effect.runPromise(program)
// Output:
// inventory attempt 1
// inventory attempt 2
// inventory attempt 3
// inventory attempt 4
// sku-123: 42 available
```

The demo uses short durations so it finishes quickly. In production, the same
shape would usually start at seconds, cap at tens of seconds or minutes, and
use an operational budget that matches the caller.

`program` performs the first call immediately. If it fails with a retryable
typed error, the retry schedule waits for a jittered exponential delay before
trying again. If the error is `"Rejected"`, the `while` predicate prevents the
retry policy from adding more traffic.

The policy allows at most eight retries after the original attempt, and only
while the elapsed budget is still open. If every allowed retry fails,
`Effect.retry` propagates the last typed failure.

##### Variants

For interactive requests, make the policy stricter: start closer to one second,
cap at a few seconds, and use a small retry count or a short `Schedule.during`
budget. Avoid making a user wait through a background-worker retry profile.

For background recovery jobs, use a larger base delay and a smaller retry count
when the dependency is known to be fragile. A policy such as "start at 10
seconds, cap at 2 minutes, retry 5 times" is often clearer than trying to keep
a failing workflow alive indefinitely.

For APIs that return a trusted retry-after signal, keep this overload policy as
the default and handle the server-provided delay in a separate, named policy.
Do not mix "server told us when to return" with "client chose a conservative
backoff" unless the composition is still obvious in review.

##### Notes and caveats

`Schedule.exponential`, `Schedule.spaced`, and `Schedule.jittered` do not stop
by themselves. Pair them with `Schedule.recurs`, `Schedule.take`,
`Schedule.during`, or an input-aware condition.

`Schedule.jittered` in Effect uses an 80%-120% range. If the final maximum
delay must be strict, cap after jitter with `Schedule.modifyDelay`.

`Effect.retry` feeds failures into the schedule. `Effect.repeat` feeds
successful values into the schedule. This recipe is about retrying typed
transient failures; polling successful observations should use `Effect.repeat`
and a success-value stop condition instead.

#### 25.5 “Keep background work steady and predictable”

Steady background work should be easy to explain: run the task, wait a known
amount of time, then run it again. The schedule should not look like a retry
policy, a catch-up mechanism, or a hidden control loop unless those behaviors
are actually required.

For most maintenance work, `Schedule.spaced` is the clearest contract. It waits
for the interval after a successful run completes. That makes the load
predictable from the worker's point of view: one run at a time, followed by one
deliberate pause.

##### Problem

Represent a recurring maintenance task such as refreshing a cache, reconciling
records, publishing metrics, or pruning expired state with the simplest schedule
that states its cadence. Keep normal cadence separate from retry, catch-up, or
overload-control behavior.

##### When to use it

Use this recipe when the important property is a stable gap between completed
runs. It fits work where freshness is approximate, overlapping runs would be
undesirable, and the next run should naturally move later if the current run
takes longer than usual.

This is also a good default when operators need a simple answer to "how often
does this worker create load?" With a spaced schedule, the answer is the run
duration plus the configured pause.

##### When not to use it

Do not use this as failure recovery by accident. `Effect.repeat` repeats
successful values; the first failure stops the repeated effect. If transient
failures should be retried, handle that inside the repeated operation or use a
separate retry policy around the part that can fail.

Do not use `Schedule.spaced` when starts must stay close to wall-clock
boundaries. Use `Schedule.fixed` for that shape. A fixed schedule maintains an
interval-based cadence and, if a run takes longer than the interval, the next
run may happen immediately; missed runs do not pile up.

Avoid adding jitter, elapsed budgets, and count limits just to make the policy
feel more robust. Add each piece only when it states a real operational
constraint.

##### Schedule shape

Start with a named cadence such as `Schedule.spaced("30 seconds")`. It outputs
the recurrence count and delays each follow-up run by thirty seconds after the
previous successful run completes. The initial run is not delayed by the
schedule; `Effect.repeat` runs the effect once before consulting the schedule.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type RefreshError = { readonly _tag: "RefreshError" }

let refreshes = 0

const refreshSearchIndex: Effect.Effect<void, RefreshError> = Effect.gen(function*() {
  refreshes++
  yield* Console.log(`refresh ${refreshes}`)
})

const backgroundCadence = Schedule.spaced("40 millis")

const demoCadence = backgroundCadence.pipe(
  Schedule.take(3)
)

const program = refreshSearchIndex.pipe(
  Effect.repeat(demoCadence),
  Effect.flatMap(() => Console.log("demo complete"))
)

Effect.runPromise(program)
// Output:
// refresh 1
// refresh 2
// refresh 3
// refresh 4
// demo complete
```

The demo bounds the repeat with `Schedule.take(3)` so it terminates quickly.
For a supervised worker, the cadence would usually stay unbounded and the
supervisor or application scope would own shutdown.

The policy says only one thing: after a successful refresh, wait before
refreshing again. If `refreshSearchIndex` fails, `program` fails. That is
usually better than silently continuing with an unclear health state.

##### Variants

Use `Schedule.fixed("30 seconds")` when the cadence itself is the contract,
such as a metrics flush that should stay close to a regular interval. Slow runs
can cause the next recurrence to happen immediately, but fixed scheduling does
not enqueue every missed interval.

Use `Schedule.spaced("30 seconds").pipe(Schedule.take(10))` for a bounded
diagnostic or migration pass. The first run still happens immediately, followed
by up to ten scheduled recurrences.

Use `Schedule.jittered` only when many instances running the same cadence would
otherwise synchronize and create fleet-wide spikes. Jitter is useful for
aggregate load, but it makes a single worker less predictable.

##### Notes and caveats

`Schedule.spaced` measures the delay after completion. `Schedule.fixed` aims at
fixed interval boundaries. Choose between them before adding any other
combinator.

Keep failure handling separate from cadence. A common shape is a small retry
policy inside one background iteration, followed by a simple repeat schedule
around the iteration. That keeps "recover this attempt" distinct from "run the
background task again later."

An unbounded repeat is long-lived work. Give it an owner such as a scope,
supervisor, or shutdown race so it can be interrupted deliberately.

## Part VII — Real-World Recipes

### 26. Backend Recipes

#### 26.1 Retry HTTP GET on timeout

Retry a `GET` only when the endpoint is safe to repeat and the failure is a
temporary transport problem.

##### Problem

You call `GET /users/:id`. The request can time out, return a non-success HTTP
status, or produce a response that cannot be decoded.

In this recipe, only the timeout is retryable. Authentication failures,
authorization failures, missing resources, and decoding failures should return
immediately. Retrying them adds load without making the request valid.

##### When to use it

Use this for idempotent reads, where repeating the request has the same logical
effect as sending it once. It fits metadata lookups, status reads, configuration
fetches, and similar paths where a short delay is acceptable.

Make the retryable condition explicit in the error model. A `HttpTimeout` tag is
clearer and safer than parsing exception messages.

##### When not to use it

Do not retry a `GET` blindly if it starts work, marks records as viewed,
advances a cursor, or depends on one-time credentials. HTTP method names are a
signal; the endpoint behavior is what matters.

Do not leave the schedule unbounded. `Schedule.exponential("100 millis")` keeps
recurring unless you add a retry count, elapsed budget, or both.

##### Schedule shape

Use `Effect.retry` with a typed `while` predicate and a finite schedule.
`Schedule.exponential` spaces retries, `Schedule.jittered` avoids synchronized
clients, `Schedule.recurs(3)` allows three retries after the first request, and
`Schedule.during` adds an elapsed retry budget. `Schedule.both` means both
limits must still allow recurrence.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

interface User {
  readonly id: string
  readonly name: string
}

class HttpTimeout extends Data.TaggedError("HttpTimeout")<{
  readonly url: string
}> {}

class HttpStatusError extends Data.TaggedError("HttpStatusError")<{
  readonly url: string
  readonly status: number
}> {}

class DecodeError extends Data.TaggedError("DecodeError")<{
  readonly message: string
}> {}

type GetUserError = HttpTimeout | HttpStatusError | DecodeError

let attempts = 0

const httpGetJson = (url: string): Effect.Effect<unknown, HttpTimeout | HttpStatusError> =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`GET ${url}, attempt ${attempts}`)

    if (attempts <= 2) {
      return yield* Effect.fail(new HttpTimeout({ url }))
    }

    return { id: "user-123", name: "Ada" }
  })

const decodeUser = (body: unknown): Effect.Effect<User, DecodeError> => {
  if (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    "name" in body &&
    typeof body.id === "string" &&
    typeof body.name === "string"
  ) {
    return Effect.succeed({ id: body.id, name: body.name })
  }
  return Effect.fail(new DecodeError({ message: "Expected a user object" }))
}

const getUser = Effect.fnUntraced(function*(id: string) {
  const url = `/users/${id}`
  const body = yield* httpGetJson(url)
  return yield* decodeUser(body)
})

const isHttpTimeout = (error: GetUserError): error is HttpTimeout => error._tag === "HttpTimeout"

const retryGetTimeouts = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3)),
  Schedule.both(Schedule.during("200 millis"))
)

const program = getUser("user-123").pipe(
  Effect.retry({
    schedule: retryGetTimeouts,
    while: isHttpTimeout
  }),
  Effect.tap((user) => Console.log(`loaded ${user.name}`))
)

Effect.runPromise(program).then(console.log, console.error)
// Output:
// GET /users/user-123, attempt 1
// GET /users/user-123, attempt 2
// GET /users/user-123, attempt 3
// loaded Ada
// { id: 'user-123', name: 'Ada' }
```

The example uses small delays so it terminates quickly. The first request is
immediate; only accepted timeout failures are delayed and retried.

If the request fails with `HttpStatusError`, or if decoding fails with
`DecodeError`, the predicate returns `false` and the failure is returned without
another HTTP request.

##### Variants

For an interactive path, use fewer retries or a smaller elapsed budget. For a
background read path, keep the same timeout predicate but allow a wider bounded
policy.

Keep the predicate separate from the timing policy. The predicate answers
whether the failure is retryable; the schedule answers how retrying proceeds
after that failure is accepted.

##### Notes and caveats

`Effect.retry` feeds typed failures from the effect's error channel into the
retry policy. The first HTTP request is not delayed.

Timeouts are ambiguous: the server may have produced a response the client did
not receive. Retrying a `GET` is normally reasonable, but only when the specific
endpoint is actually idempotent.

Bounded retry is part of the contract. A retry count protects the downstream
service from unbounded pressure; an elapsed budget protects the caller from
spending too long on one dependency.

#### 26.2 Retry HTTP GET on 503

A `503 Service Unavailable` response can be retryable for an idempotent HTTP
`GET`. Keep it narrower than a generic HTTP retry policy.

##### Problem

You fetch a resource with `GET`. If the service responds with `503`, retry
briefly with backoff. If it responds with any other failure, return that failure
to the caller immediately.

The predicate decides whether the current typed failure is retryable. The
schedule decides when another attempt is allowed and when retrying stops.

##### When to use it

Use this for idempotent HTTP reads where a `503` really means temporary
unavailability: dependency warm-up, rolling deploys, overloaded gateways, or a
backend pool with short-lived capacity trouble.

It is a good fit when callers need an answer quickly but a small number of
retries can hide brief service interruptions.

##### When not to use it

Do not retry every HTTP status. A `400 Bad Request`, `401 Unauthorized`,
`403 Forbidden`, `404 Not Found`, or `422 Unprocessable Entity` usually needs a
different request, credentials, or domain decision.

Do not treat `503` as the same thing as `429 Too Many Requests`. A rate-limit
response often needs `Retry-After` handling, client-side admission control, or a
different budget.

Do not apply this recipe blindly to writes. `GET` is normally safe to retry; a
non-idempotent `POST` needs an idempotency key or another duplicate-safety
guarantee before adding retries.

##### Schedule shape

With `Effect.retry`, failures from the error channel are the schedule inputs.
Use the options form when retryability is a predicate over the typed error.

Start with `Schedule.exponential`, then intersect it with explicit limits using
`Schedule.both`. The combined schedule recurs only while both sides still allow
another recurrence. For example, a backoff schedule combined with
`Schedule.recurs(4)` and `Schedule.during("3 seconds")` allows at most four
retries after the first request, and only while the elapsed retry budget is
still open.

Add `Schedule.jittered` when many instances may hit the same service at once.
It adjusts each recurrence delay between 80% and 120% of the original delay,
which helps avoid synchronized retry waves.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

type HttpStatus = 200 | 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | 504

interface HttpResponse {
  readonly status: HttpStatus
  readonly body: string
}

class TransportError extends Data.TaggedError("TransportError")<{
  readonly url: string
  readonly reason: string
}> {}

class HttpResponseError extends Data.TaggedError("HttpResponseError")<{
  readonly method: "GET"
  readonly url: string
  readonly status: Exclude<HttpStatus, 200>
}> {}

type GetCatalogError = TransportError | HttpResponseError

let attempts = 0

const rawGet = (url: string): Effect.Effect<HttpResponse, TransportError> =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`GET ${url}, attempt ${attempts}`)

    if (attempts <= 2) {
      return { status: 503, body: "warming up" }
    }

    return { status: 200, body: "catalog-v1" }
  })

const classifyGetResponse = (
  url: string,
  response: HttpResponse
): Effect.Effect<string, HttpResponseError> =>
  response.status === 200
    ? Effect.succeed(response.body)
    : Effect.fail(
      new HttpResponseError({
        method: "GET",
        url,
        status: response.status as Exclude<HttpStatus, 200>
      })
    )

const getCatalog = (url: string): Effect.Effect<string, GetCatalogError> =>
  rawGet(url).pipe(
    Effect.flatMap((response) => classifyGetResponse(url, response))
  )

const isServiceUnavailableGet = (error: GetCatalogError): boolean =>
  error._tag === "HttpResponseError" &&
  error.method === "GET" &&
  error.status === 503

const retry503WithBackoff = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(4)),
  Schedule.both(Schedule.during("300 millis")),
  Schedule.jittered
)

const program = getCatalog("https://api.example.test/catalog").pipe(
  Effect.retry({
    schedule: retry503WithBackoff,
    while: isServiceUnavailableGet
  }),
  Effect.tap((body) => Console.log(`received ${body}`))
)

Effect.runPromise(program).then(console.log, console.error)
// Output:
// GET https://api.example.test/catalog, attempt 1
// GET https://api.example.test/catalog, attempt 2
// GET https://api.example.test/catalog, attempt 3
// received catalog-v1
// catalog-v1
```

The example uses short delays so it finishes quickly. The first `GET` is sent
immediately. A `503` is retried; any other status is surfaced immediately.

If the transport layer fails with `TransportError`, this policy also does not
retry it. That can be a separate timeout or network-failure recipe.

If every permitted retry still receives `503`, retrying stops when the count
limit or elapsed-time limit is exhausted, and the last typed failure is
propagated.

##### Variants

Use a count-only policy when elapsed time is less important than a fixed number
of attempts. Use a shorter user-facing budget when the caller is waiting.

If you want the reusable schedule itself to carry the 503 filter, use
`Schedule.while(({ input }) => isServiceUnavailableGet(input))` after setting
the schedule input type to the HTTP error.

##### Notes and caveats

The retry predicate is evaluated after a failed attempt. It cannot prevent the
initial request; it only decides whether another request should be attempted.

`Schedule.recurs(4)` means four retries after the original attempt, not four
total HTTP requests. With the first request included, this policy can perform up
to five `GET` requests.

`Schedule.during("3 seconds")` is checked at schedule decision points. It keeps
the retry window bounded, but it is not a timeout for the individual HTTP
request. Use request-level timeouts separately when a single attempt can hang.

Keep non-503 classification close to the HTTP adapter. The schedule should not
parse response bodies or error messages to discover whether a failure is
retryable; it should receive a typed error that already carries the status code.

#### 26.3 Retry HTTP POST with idempotency key

HTTP `POST` retries need a duplicate-safety contract before any schedule is
added. An idempotency key is a request identifier the server uses to treat
repeated attempts as one logical write.

##### Problem

You need to retry an HTTP `POST` when the failure is ambiguous, such as a
timeout, dropped connection, gateway error, or temporary service outage. In
those cases, the client may not know whether the server committed the write.

The retry must reuse the same idempotency key for every attempt. Generating a
fresh key inside the retried effect usually turns retries into independent
writes.

##### When to use it

Use this recipe when the downstream HTTP API explicitly supports idempotency
keys for the `POST` endpoint you are calling. Typical examples include payment
creation, order submission, subscription changes, shipment creation, and
command-style API calls.

It is especially useful for failures where the outcome is unknown to the
client: a timeout after the request was sent, a connection reset before the
response arrived, a transient gateway error, or a retryable overload response.

Create or load the idempotency key before entering `Effect.retry`, then pass
that same key to the HTTP request effect on every attempt.

##### When not to use it

Do not retry a non-idempotent `POST` unless the downstream service provides a
deduplication contract you can rely on. A local retry schedule cannot make an
unsafe write safe by itself.

Do not retry permanent failures such as invalid payloads, authentication
failures, authorization failures, or domain rejections. Classify those errors
before retrying.

Do not let the retry run forever. Idempotency keys reduce duplicate-write risk;
they do not remove load from a struggling downstream service.

##### Schedule shape

Use a bounded schedule for HTTP `POST` retries:

Use exponential backoff so repeated failures slow down, jitter so many clients
do not retry at the same moment, a finite retry count, and an error predicate
that accepts only ambiguous or transient failures.

`Schedule.recurs(4)` means four retries after the initial request. It is not a
total-attempt count.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class PostOrderError extends Data.TaggedError("PostOrderError")<{
  readonly reason:
    | "Timeout"
    | "ConnectionReset"
    | "BadGateway"
    | "ServiceUnavailable"
    | "InvalidRequest"
    | "Unauthorized"
}> {}

interface Order {
  readonly id: string
  readonly status: "Created" | "AlreadyCreated"
}

interface OrderRequest {
  readonly customerId: string
  readonly sku: string
  readonly quantity: number
  readonly idempotencyKey: string
}

let attempts = 0

const postOrder = (request: OrderRequest): Effect.Effect<Order, PostOrderError> =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(
      `POST /orders attempt ${attempts} with key ${request.idempotencyKey}`
    )

    if (attempts === 1) {
      return yield* Effect.fail(new PostOrderError({ reason: "Timeout" }))
    }

    return {
      id: "order-1000",
      status: attempts === 2 ? "Created" : "AlreadyCreated"
    }
  })

const retryPost = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const isRetryablePostFailure = (error: PostOrderError): boolean => {
  switch (error.reason) {
    case "Timeout":
    case "ConnectionReset":
    case "BadGateway":
    case "ServiceUnavailable":
      return true
    case "InvalidRequest":
    case "Unauthorized":
      return false
  }
}

const submitOrder = Effect.fnUntraced(function*(
  customerId: string,
  sku: string,
  quantity: number,
  idempotencyKey: string
) {
  return yield* postOrder({ customerId, sku, quantity, idempotencyKey }).pipe(
    Effect.retry({
      schedule: retryPost,
      while: isRetryablePostFailure
    })
  )
})

const program = submitOrder("customer-1", "sku-1", 2, "order-key-123").pipe(
  Effect.tap((order) => Console.log(`order ${order.id}: ${order.status}`))
)

Effect.runPromise(program).then(console.log, console.error)
// Output:
// POST /orders attempt 1 with key order-key-123
// POST /orders attempt 2 with key order-key-123
// order order-1000: Created
// { id: 'order-1000', status: 'Created' }
```

The key detail is that `idempotencyKey` is an input to `submitOrder`. Every
attempt sends the same logical request with the same key.

If the first `POST` succeeds on the server but the response is lost, a later
attempt with the same key should return the same logical result, such as
`Created` or `AlreadyCreated`, according to the downstream API contract.
`Schedule` only decides how many times to ask again and how much delay to put
between attempts.

##### Variants

For a user-facing request path, reduce the retry count so the caller gets a
prompt result.

For a background worker or outbox processor, use a larger bounded policy and
persist the idempotency key with the job record.

If the provider returns a specific "already processed" response for a repeated
key, model it as a successful domain value when it represents the same logical
write. Do not turn a successful deduplication response into another retryable
failure.

##### Notes and caveats

`Effect.retry` feeds failures into the schedule. The first `POST` attempt runs
immediately; the schedule controls only the follow-up attempts after failures.

`Schedule.recurs(4)` means four retries after the original attempt, not four
total attempts.

The idempotency key must identify one logical command. Reusing the same key for
a different payload can cause the downstream service to reject the request or
return a previous result for the wrong local intent.

Check the downstream API's idempotency-key retention window. Some services
deduplicate keys for hours or days, not forever. Your retry and reconciliation
workflow should fit within that documented window.

#### 26.4 Retry rate-limited requests carefully

Rate-limit retries need a different shape from generic transient-error retries:
they should reduce pressure and honor server guidance such as `Retry-After`.

##### Problem

A downstream HTTP API sometimes responds with `429` and may include a
`Retry-After` value. You want to retry those responses without turning every
HTTP failure into a retry and without ignoring a server-supplied delay that is
longer than your local backoff.

The first request still happens outside the schedule. The schedule controls only
the follow-up attempts after a failed request is classified as retryable.

##### When to use it

Use this recipe for idempotent requests, safe reads, or writes protected by an
idempotency key when the remote service explicitly reports rate limiting. It is
also useful for background workers that call APIs with shared tenant, account,
or application quotas.

The important precondition is classification. Convert raw HTTP failures into a
small domain error first, and retry only the `RateLimited` case. Timeouts and
`503` responses may have their own retry policy, but `400`, `401`, `403`, `404`,
validation failures, and unsafe non-idempotent writes should not be hidden
behind a rate-limit schedule.

##### When not to use it

Do not use this as a generic HTTP retry wrapper. A rate limit says "wait before
asking again"; it does not say the original request is valid, safe to replay, or
worth retrying forever.

Also avoid short fixed delays such as "retry every 100 millis" for `429`
responses. They make recovery look fast in tests but create exactly the kind of
pressure that the server is trying to reduce.

##### Schedule shape

Build the policy from four parts:

`Schedule.exponential` spaces retries progressively. `Schedule.jittered`
spreads clients so they do not retry in lockstep. `Schedule.recurs` caps the
number of follow-up attempts. `Schedule.while` stops immediately when the
failure is not rate limited.

To honor `Retry-After`, combine the backoff schedule with `Schedule.identity`.
`Effect.retry` feeds each failure into the schedule, so `identity` lets the
schedule output the current error. Then `Schedule.modifyDelay` can choose the
larger of the local backoff delay and the server-provided retry delay.

##### Example

```ts runnable deterministic
import { Console, Duration, Effect, Schedule } from "effect"

type HttpError =
  | {
    readonly _tag: "RateLimited"
    readonly retryAfter: Duration.Duration | undefined
  }
  | {
    readonly _tag: "Unauthorized" | "Forbidden" | "BadRequest" | "Unavailable"
  }

let attempts = 0

const callApi: Effect.Effect<string, HttpError> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`calling API, attempt ${attempts}`)

  if (attempts === 1) {
    return yield* Effect.fail(
      {
        _tag: "RateLimited",
        retryAfter: Duration.millis(30)
      } as const
    )
  }

  return "accepted"
})

const rateLimitPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.identity<HttpError>()),
  Schedule.modifyDelay(([_, error], delay) =>
    Effect.succeed(
      error._tag === "RateLimited" && error.retryAfter !== undefined
        ? Duration.max(delay, error.retryAfter)
        : delay
    )
  ),
  Schedule.both(Schedule.recurs(5)),
  Schedule.while(({ input }) => input._tag === "RateLimited")
)

const program = Effect.retry(callApi, rateLimitPolicy).pipe(
  Effect.tap((result) => Console.log(`result: ${result}`))
)

Effect.runPromise(program).then(console.log, console.error)
// Output:
// calling API, attempt 1
// calling API, attempt 2
// result: accepted
// accepted
```

##### Variants

If the provider returns `Retry-After` as a header, parse it before constructing
the domain error. Header parsing belongs with HTTP decoding, not inside the
schedule. Store the parsed value as a `Duration.Duration`, reject invalid or
negative values, and consider clamping very large values to the caller's
business deadline.

For user-facing calls, keep the recurrence count small and combine the policy
with a short elapsed-time budget so the user gets a clear answer. For background
workers, use a larger base delay and let the queue or work scheduler re-enqueue
the job when the server asks for a long pause.

For APIs with per-tenant quotas, include tenant or account information in
metrics around the retried effect. The schedule controls local timing; it does
not coordinate all callers that share the same quota.

##### Notes and caveats

`Schedule.both` continues only while both schedules continue, uses the maximum
delay from the two sides, and returns both outputs as a tuple. In this recipe the
timing side provides the backoff delay, while `Schedule.identity` carries the
current `HttpError` into `modifyDelay`. The recipe then chooses the larger of
the local backoff delay and the parsed `Retry-After` delay.

`Schedule.while` sees schedule metadata, including the latest retry input. When
the predicate returns `false`, the retry stops and the original failure remains
visible to the caller. That is what you want for carefully classified HTTP
errors: retry `429`, but surface authorization, validation, and other permanent
failures immediately.

#### 26.5 Poll a job-based HTTP API

Job-based HTTP APIs are polling problems when the status endpoint returns
successful "still running" responses rather than errors.

##### Problem

You submit a job to an HTTP API and receive a `jobId`. The status endpoint can
return `"queued"` or `"running"` for a while before returning a terminal
`"succeeded"` or `"failed"` status.

You need the first status check to happen right away, but you do not want an
unbounded loop. Readers should be able to see the polling interval, the terminal
condition, and the deadline in one place.

##### When to use it

Use this recipe when an API models long-running work as a job resource and the
status response is a successful domain value. A pending status is not an error;
it is the input that tells the schedule whether another poll should happen.

This is a good fit for export generation, report rendering, media processing,
provisioning, and other backend workflows where completion is eventually visible
through a status endpoint.

##### When not to use it

Do not use polling to hide request errors. Authorization failures, invalid job
IDs, decode failures, and transient transport failures should stay in the error
channel and be handled separately from domain statuses.

Also prefer a webhook, queue message, server-sent event, or direct callback when
the system already offers a push-based completion signal.

##### Schedule shape

Combine a spaced cadence, a terminal-state predicate, and an elapsed budget.
`Schedule.spaced("2 seconds")` waits after each successful status response
before the next poll. `Schedule.while` allows another recurrence only while the
latest status is non-terminal. `Schedule.during("1 minute")` gives the polling
loop an elapsed budget.

`Schedule.passthrough` makes the latest `JobStatus` the schedule output.
`Schedule.bothLeft` adds the deadline while preserving that status output.

##### Example

```ts runnable
import { Console, Effect, Schedule } from "effect"

type JobStatus =
  | { readonly state: "queued"; readonly jobId: string }
  | { readonly state: "running"; readonly jobId: string; readonly progress: number }
  | { readonly state: "succeeded"; readonly jobId: string; readonly artifactUrl: string }
  | { readonly state: "failed"; readonly jobId: string; readonly reason: string }

type JobStatusError = {
  readonly _tag: "JobStatusError"
  readonly message: string
}

const isTerminal = (status: JobStatus): boolean => status.state === "succeeded" || status.state === "failed"

let polls = 0

const readJobStatus = (jobId: string): Effect.Effect<JobStatus, JobStatusError> =>
  Effect.gen(function*() {
    polls += 1

    const status: JobStatus = polls === 1
      ? { state: "queued", jobId }
      : polls === 2
      ? { state: "running", jobId, progress: 60 }
      : { state: "succeeded", jobId, artifactUrl: "/exports/job-1.csv" }

    yield* Console.log(`poll ${polls}: ${status.state}`)
    return status
  })

const pollJobUntilTerminalOrDeadline = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminal(input)),
  Schedule.bothLeft(
    Schedule.during("200 millis").pipe(
      Schedule.satisfiesInputType<JobStatus>()
    )
  )
)

const waitForJob = (jobId: string) =>
  readJobStatus(jobId).pipe(
    Effect.repeat(pollJobUntilTerminalOrDeadline),
    Effect.tap((status) => Console.log(`final status: ${status.state}`))
  )

Effect.runPromise(waitForJob("job-1")).then(console.log, console.error)
// Output may vary: elapsed timing can cross the polling budget boundary differently under load
// poll 1: queued
// poll 2: running
// poll 3: succeeded
// final status: succeeded
// {
//   state: 'succeeded',
//   jobId: 'job-1',
//   artifactUrl: '/exports/job-1.csv'
// }
```

`waitForJob` performs the first status request immediately. If that first
response is `"succeeded"` or `"failed"`, it returns without waiting. If the
response is `"queued"` or `"running"`, the schedule waits two seconds before
polling again.

The returned effect succeeds with the final observed `JobStatus`. That value is
terminal when the API returned `"succeeded"` or `"failed"` before the deadline.
It can still be `"queued"` or `"running"` when the one-minute polling budget was
used up first.

##### Variants

Use shorter spacing when the caller is waiting interactively and the status
endpoint is cheap. Use longer spacing for background jobs where completion
latency matters less than endpoint load.

Add `Schedule.jittered` after the base cadence when many workers may begin
polling similar jobs at the same time.

If each individual HTTP request needs its own deadline, put a timeout on
`readJobStatus(jobId)` separately. `Schedule.during` limits recurrence
decisions; it is not a hard timeout for an in-flight request.

##### Notes and caveats

`Effect.repeat` feeds successful values into the schedule. That is why the
predicate sees `JobStatus` values and can stop on terminal domain states.
`Effect.retry` would feed failures into the schedule instead.

The first status request is not delayed. Schedules describe the recurrence after
the original effect has run.

`Schedule.spaced` waits after a status request completes. Use `Schedule.fixed`
only when you need polling aligned to wall-clock intervals.

Keep terminal domain states distinct from infrastructure failures. A job-level
`"failed"` status is a successful HTTP observation that should stop polling; a
failed status request is an effect failure that should be retried, reported, or
classified outside this repeat schedule.

### 27. Frontend and Client Recipes

#### 27.1 Retry config fetch at startup

Startup configuration fetches sit on the first-render path, where a tiny outage
should not leave the UI stuck on a loading screen.

##### Problem

You want the first config request to happen immediately, retry a few transient
failures with increasing delay, and then stop so the client can show a clear
degraded state.

##### When to use it

Use this for read-only startup fetches where a retry can realistically recover:
a timeout, a brief network drop, a `503`, or a short CDN edge failure. The
schedule should be small enough that the maximum wait before fallback is easy to
explain.

##### When not to use it

Do not retry configuration errors that are deterministic for this client:
malformed JSON, an unsupported app version, a missing tenant, or an
authorization failure. Those should fail fast and route the user to an upgrade,
sign-in, or support path.

Avoid a long startup retry loop for optional configuration. Render with defaults
and refresh in the background instead.

##### Schedule shape

Use exponential spacing combined with a small retry count. `Effect.retry` runs
the fetch once before consulting the schedule; the schedule describes the
follow-up attempts after failures. `Schedule.recurs(3)` means at most three
retries after the initial request.

Add `while` classification so deterministic configuration failures do not spend
the transient-failure budget.

##### Example

```ts runnable
import { Console, Effect, Schedule } from "effect"

type ClientConfig = {
  readonly apiBaseUrl: string
  readonly featureFlags: ReadonlyArray<string>
}

type ConfigFetchError =
  | { readonly _tag: "NetworkUnavailable" }
  | { readonly _tag: "ServiceUnavailable" }
  | { readonly _tag: "MalformedConfig" }

let attempts = 0

const fetchStartupConfig: Effect.Effect<ClientConfig, ConfigFetchError> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`fetch config attempt ${attempts}`)

  if (attempts <= 2) {
    return yield* Effect.fail({ _tag: "ServiceUnavailable" } as const)
  }

  return {
    apiBaseUrl: "https://api.example.test",
    featureFlags: ["new-profile"]
  }
})

const isTransientConfigFailure = (error: ConfigFetchError): boolean =>
  error._tag === "NetworkUnavailable" || error._tag === "ServiceUnavailable"

const startupConfigRetryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const loadStartupConfig = fetchStartupConfig.pipe(
  Effect.retry({
    schedule: startupConfigRetryPolicy,
    while: isTransientConfigFailure
  }),
  Effect.tap((config) => Console.log(`loaded config for ${config.apiBaseUrl}`))
)

Effect.runPromise(loadStartupConfig).then(console.log, console.error)
// Output may vary: elapsed timing can cross the monitoring budget boundary differently under load
// fetch config attempt 1
// fetch config attempt 2
// fetch config attempt 3
// loaded config for https://api.example.test
// {
//   apiBaseUrl: 'https://api.example.test',
//   featureFlags: [ 'new-profile' ]
// }
```

##### Variants

For a very latency-sensitive first paint, reduce the retry count or use a
shorter base delay and fall back to cached defaults. For a config request made
by many clients at once, add jitter after choosing the base cadence so clients
do not retry in lockstep. For mandatory configuration, keep the retry policy
bounded but show a blocking error with a manual retry button after exhaustion.

##### Notes and caveats

Bounded startup retries protect the user experience as much as the service. A
schedule that retries forever can make the app look broken, while a schedule
that gives up too quickly can turn a tiny outage into a visible failure.

Keep permanent error classification near `fetchStartupConfig`, keep the retry
policy short, and make the post-retry UI behavior explicit.

#### 27.2 Retry profile loading on transient network failure

Profile reads are user-facing, but they are usually safe to retry only when the
failure is clearly transient.

##### Problem

You need to load the signed-in user's profile in a frontend flow. The initial
request may fail for reasons that are worth retrying, such as the browser being
temporarily offline or the server returning `502`, `503`, or `504`. Other
failures are terminal for this interaction and should reach the UI immediately.

The retry policy should retry only classified transient failures and stop after
a small number of attempts so the screen can show an actionable failure state.

##### When to use it

Use this recipe for idempotent profile reads where a short delay is acceptable
and a successful retry improves the user experience. It fits page boot, account
menus, settings screens, and other client reads where the same GET can be safely
attempted again.

##### When not to use it

Do not use this policy for authentication failures, validation errors, `404`
responses, or other outcomes that another attempt cannot fix. Also avoid it for
profile writes: changing display names, avatars, or preferences needs separate
idempotency and conflict-handling rules.

##### Schedule shape

Use a short exponential backoff, add jitter so many clients do not retry at the
same instant, and combine it with `Schedule.recurs` to cap retries. Because
`Effect.retry` sees each typed failure, use the retry `while` predicate to
continue only while the failure is classified as transient.

The combined schedule stops as soon as either condition stops recurring: the
error is no longer transient, or the retry count has been exhausted.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

interface Profile {
  readonly id: string
  readonly name: string
}

interface HttpResponse {
  readonly status: number
  readonly body: unknown
}

class ProfileLoadError extends Data.TaggedError("ProfileLoadError")<{
  readonly reason:
    | "BadResponse"
    | "Forbidden"
    | "NotFound"
    | "Offline"
    | "ServerUnavailable"
  readonly status?: number
  readonly cause?: unknown
}> {}

const isTransient = (error: ProfileLoadError): boolean =>
  error.reason === "Offline" || error.reason === "ServerUnavailable"

const classifyHttpStatus = (response: HttpResponse): ProfileLoadError => {
  if (response.status === 401 || response.status === 403) {
    return new ProfileLoadError({ reason: "Forbidden", status: response.status })
  }
  if (response.status === 404) {
    return new ProfileLoadError({ reason: "NotFound", status: response.status })
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return new ProfileLoadError({ reason: "ServerUnavailable", status: response.status })
  }
  return new ProfileLoadError({ reason: "BadResponse", status: response.status })
}

const retryTransientProfileLoad = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(3))
)

const decodeProfile = (body: unknown): Effect.Effect<Profile, ProfileLoadError> => {
  if (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    "name" in body &&
    typeof body.id === "string" &&
    typeof body.name === "string"
  ) {
    return Effect.succeed({ id: body.id, name: body.name })
  }
  return Effect.fail(new ProfileLoadError({ reason: "BadResponse", cause: body }))
}

let attempts = 0

const requestProfile = (userId: string): Effect.Effect<HttpResponse, ProfileLoadError> =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`load profile ${userId}, attempt ${attempts}`)

    if (attempts === 1) {
      return yield* Effect.fail(new ProfileLoadError({ reason: "Offline" }))
    }
    if (attempts === 2) {
      return { status: 503, body: "service unavailable" }
    }
    return { status: 200, body: { id: userId, name: "Ada" } }
  })

const fetchProfile = (userId: string): Effect.Effect<Profile, ProfileLoadError> =>
  requestProfile(userId).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? decodeProfile(response.body)
        : Effect.fail(classifyHttpStatus(response))
    )
  )

const loadProfile = (userId: string) =>
  fetchProfile(userId).pipe(
    Effect.retry({
      schedule: retryTransientProfileLoad,
      while: isTransient
    }),
    Effect.tap((profile) => Console.log(`loaded ${profile.name}`))
  )

Effect.runPromise(loadProfile("user-123")).then(console.log, console.error)
// Output:
// load profile user-123, attempt 1
// load profile user-123, attempt 2
// load profile user-123, attempt 3
// loaded Ada
// { id: 'user-123', name: 'Ada' }
```

##### Variants

For a more latency-sensitive screen, reduce the cap to one or two retries. For a
less critical background refresh, increase the base delay and keep the cap
explicit. If the server returns a structured rate-limit response, classify it
separately instead of treating every `429` as an ordinary network failure.

##### Notes and caveats

`Schedule.recurs(3)` allows three retries after the first profile request. The
example uses tiny delays so it terminates quickly; use larger delays for a real
frontend path. `Schedule.jittered` randomly adjusts each delay between 80% and
120% of the base delay.

Keep classification close to the HTTP boundary. The schedule should not parse
responses or guess whether a status is retryable; it should receive a domain
error and decide whether recurrence is still allowed.

#### 27.3 Retry token refresh briefly

Token refresh retries sit on an interactive path, so the policy must stay
narrow and brief.

##### Problem

An access token has expired and the client needs to exchange a refresh token
for a new access token. The refresh call can fail because the network timed out,
because the auth service returned a temporary `503`, or because the refresh
token is invalid, expired, revoked, or already rotated.

Only the transient cases should be retried. Authentication failures must fail
fast so the client can sign the user out, ask for re-authentication, or follow
your product's session-recovery path.

Use `Effect.retry` with a typed `while` predicate and a small finite `Schedule`.

##### When to use it

Use this recipe when token refresh is safe to attempt again and the caller can
tolerate a brief delay. It fits browser clients, mobile clients, and API
gateways that refresh credentials immediately before retrying the original
request.

The refresh operation should have a clear error model. A specific
`RefreshTimeout` or `RefreshServiceUnavailable` tag is better than retrying every
failure from a generic HTTP client.

##### When not to use it

Do not retry `invalid_grant`, revoked-token, expired-token, malformed-request,
or client-authentication failures. Those are not made valid by waiting another
hundred milliseconds.

Do not use a long backoff on an interactive token refresh path. If refresh is
still failing after a brief retry window, return control to the caller and let
the application decide whether to show an error, redirect to login, or continue
offline.

Be careful with refresh-token rotation. If your identity provider treats a
duplicate refresh request as token reuse, retry only failures that are safe for
your provider, or use the provider's idempotency mechanism if it offers one.

##### Schedule shape

Start with a small exponential delay and bound it by both retry count and
elapsed time.

`Schedule.exponential` chooses the next delay after an accepted failure.
`Schedule.jittered` randomizes each delay between 80% and 120% of the base
delay so many clients do not retry at exactly the same moment.

`Schedule.recurs(2)` allows at most two retries after the original refresh.
`Schedule.during("1 second")` adds a short elapsed-time budget. Because
`Schedule.both` continues only while both schedules continue, retrying stops as
soon as either limit is exhausted.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

interface Tokens {
  readonly accessToken: string
  readonly refreshToken: string
}

class RefreshTimeout extends Data.TaggedError("RefreshTimeout")<{
  readonly endpoint: string
}> {}

class RefreshServiceUnavailable extends Data.TaggedError("RefreshServiceUnavailable")<{
  readonly endpoint: string
}> {}

class RefreshRejected extends Data.TaggedError("RefreshRejected")<{
  readonly reason: "invalid_grant" | "revoked" | "expired"
}> {}

type RefreshError =
  | RefreshTimeout
  | RefreshServiceUnavailable
  | RefreshRejected

let attempts = 0

const postRefreshToken = (refreshToken: string): Effect.Effect<Tokens, RefreshError> =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(`refresh attempt ${attempts}`)

    if (refreshToken === "revoked") {
      return yield* Effect.fail(new RefreshRejected({ reason: "revoked" }))
    }
    if (attempts === 1) {
      return yield* Effect.fail(new RefreshTimeout({ endpoint: "/oauth/token" }))
    }

    return {
      accessToken: "access-token-2",
      refreshToken: "refresh-token-2"
    }
  })

const isTransientRefreshFailure = (
  error: RefreshError
): error is RefreshTimeout | RefreshServiceUnavailable =>
  error._tag === "RefreshTimeout" ||
  error._tag === "RefreshServiceUnavailable"

const retryTokenRefreshBriefly = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(2)),
  Schedule.both(Schedule.during("150 millis"))
)

const refreshSession = (refreshToken: string) =>
  postRefreshToken(refreshToken).pipe(
    Effect.retry({
      schedule: retryTokenRefreshBriefly,
      while: isTransientRefreshFailure
    }),
    Effect.tap((tokens) => Console.log(`new access token: ${tokens.accessToken}`))
  )

Effect.runPromise(refreshSession("refresh-token-1")).then(console.log, console.error)
// Output:
// refresh attempt 1
// refresh attempt 2
// new access token: access-token-2
// { accessToken: 'access-token-2', refreshToken: 'refresh-token-2' }
```

`refreshSession` sends the refresh request once immediately. If the request
fails with `RefreshTimeout` or `RefreshServiceUnavailable`, `Effect.retry`
consults the schedule before trying again.

If the provider rejects the token with `RefreshRejected`, the predicate returns
`false`, so the failure is returned without another refresh request.

##### Variants

For a very latency-sensitive path, retry once and use a smaller budget.

For a backend-for-frontend or gateway where refresh does not block direct UI
interaction, you can allow a little more time while still keeping the policy
bounded.

Keep the classification predicate separate from the schedule. The predicate
answers whether the failure is retryable; the schedule answers how brief and how
paced the retry window is.

##### Notes and caveats

`Effect.retry` retries typed failures from the effect's error channel. Defects
and interruptions are not turned into retryable token-refresh failures by the
schedule.

The first refresh attempt is not delayed. Delays apply only after a failure has
been accepted by the `while` predicate.

`Schedule.recurs(2)` means two retries after the original attempt, not two total
attempts. With the policy above, the client can make up to three refresh
requests total.

Token refresh is security-sensitive. Keep retry brief, classify permanent
authentication failures explicitly, and verify the retry behavior against your
identity provider's refresh-token rotation rules.

#### 27.4 Reconnect WebSocket with backoff

WebSocket reconnect policies need to balance quick recovery with restraint
during real outages.

##### Problem

You have a browser or client application that opens a WebSocket connection. If
the connection cannot be opened because of a transient network failure, the
client should retry. Reconnecting immediately in a loop can create noisy UI and
extra load on the server, especially when many clients lose connectivity at the
same time.

You want a reconnect policy that:

- starts with a small delay
- grows after repeated failed opens
- caps the final wait so the UI remains understandable
- stops after a bounded number of retries

##### When to use it

Use this recipe for user-facing WebSocket reconnects where a temporary loss of
connectivity is expected: chat presence, live dashboards, collaborative editing,
notifications, subscriptions, and browser tabs that may move between networks.

It is a good fit when the application can show intermediate states such as
"connecting", "reconnecting", and "offline" while the reconnect policy runs.

##### When not to use it

Do not retry permanent setup failures. Invalid URLs, unsupported protocols,
authentication failures, authorization failures, and application-level rejection
messages should be classified before the schedule is applied.

Do not use the reconnect schedule as the only user experience. A person staring
at a disconnected screen needs visible state, a clear failure after the retry
budget is exhausted, and often a manual "try again" action.

Do not use the schedule to supervise an already-open socket by itself.
`Effect.retry` retries failed effect evaluations. If a socket opens
successfully and later closes, model that close as a failure in the effect that
owns the connection lifecycle, then apply the reconnect policy around that
effect.

##### Schedule shape

Start with `Schedule.exponential`. It recurs forever by itself and doubles the
delay by default: 250 ms, 500 ms, 1 second, 2 seconds, and so on.

For a user-facing reconnect, cap the final delay with `Schedule.modifyDelay`
and add a retry limit with `Schedule.recurs`. `Schedule.both` combines the
backoff and retry limit with intersection semantics, so reconnecting stops as
soon as the limit stops.

##### Example

```ts runnable deterministic
import { Console, Data, Duration, Effect, Schedule } from "effect"

class WebSocketOpenError extends Data.TaggedError("WebSocketOpenError")<{
  readonly reason: "network" | "timeout" | "server-restarting" | "unauthorized"
}> {}

interface LiveSocket {
  readonly id: string
}

let attempts = 0

const openLiveSocket: Effect.Effect<LiveSocket, WebSocketOpenError> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`open WebSocket attempt ${attempts}`)

  if (attempts <= 2) {
    return yield* Effect.fail(new WebSocketOpenError({ reason: "network" }))
  }

  return { id: "live-socket-1" }
})

const isRetryableOpenError = (error: WebSocketOpenError): boolean =>
  error.reason === "network" ||
  error.reason === "timeout" ||
  error.reason === "server-restarting"

const websocketReconnectPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(50)))),
  Schedule.both(Schedule.recurs(8))
)

const connectLiveSocket = openLiveSocket.pipe(
  Effect.retry({
    schedule: websocketReconnectPolicy,
    while: isRetryableOpenError
  }),
  Effect.tap((socket) => Console.log(`connected ${socket.id}`))
)

Effect.runPromise(connectLiveSocket).then(console.log, console.error)
// Output:
// open WebSocket attempt 1
// open WebSocket attempt 2
// open WebSocket attempt 3
// connected live-socket-1
// { id: 'live-socket-1' }
```

`openLiveSocket` is evaluated once immediately. If opening the socket fails with
a `WebSocketOpenError`, `Effect.retry` feeds that failure into the schedule. The
schedule then decides whether another attempt is allowed and how long to wait
before trying again.

##### Variants

For a highly interactive screen, use fewer retries or a shorter cap. It is
usually better to show "offline" quickly and let the user retry manually than to
hide a long reconnect sequence behind a spinner.

For a passive background tab or non-critical live feed, use a larger cap and a
larger retry budget. Keep the retry state observable so the UI can stop showing
stale data as if it were live.

For large deployments, add jitter to this backoff. The cap protects the person
waiting in the UI; jitter protects the server from many clients retrying
together. Section 44.5 focuses on that version.

For a socket that opens successfully and then closes later, wrap the whole
connection lifecycle in the effect being retried. The schedule should surround
the effect that can fail when the connection drops, not only the initial
constructor call.

##### Notes and caveats

The schedule controls delays between attempts. It does not time out a single
WebSocket opening attempt. If the open handshake can hang, add an effect-level
timeout to `openLiveSocket` before applying `Effect.retry`.

The retry budget counts scheduled retries, not total connection attempts.
`Schedule.recurs(8)` means one immediate open attempt plus up to eight later
attempts.

Be careful with authentication and authorization failures. Retrying a token that
is expired, missing, or forbidden usually makes the UI slower and the logs
noisier. Refresh credentials or ask the user to sign in before reconnecting.

When the retry policy is exhausted, surface that state to the user. A bounded
WebSocket reconnect policy is only helpful if the application clearly moves from
"reconnecting" to "offline" or "connection lost" when the final attempt fails.

#### 27.5 Reconnect WebSocket with jitter

Jitter keeps WebSocket reconnect attempts from many clients from landing on the
same backoff boundaries.

##### Problem

A browser, mobile app, or frontend service owns a WebSocket connection. When the
socket closes for a transient reason, the client should reconnect without making
the user refresh the page.

You want a reconnect policy that:

- starts quickly for short network interruptions
- backs off after repeated failed reconnect attempts
- jitters each delay so many clients do not reconnect together
- caps each wait so the UI does not disappear into a long exponential tail
- stops after a bounded number of retries so the caller can surface a clear
  disconnected state

##### When to use it

Use this recipe for reconnecting browser WebSockets, mobile realtime sessions,
dashboard event streams, collaborative editing channels, notification sockets,
and client-side presence connections.

It is especially useful when many clients share the same gateway or realtime
backend. Jitter reduces the chance that a fleet of clients dropped by the same
event will all retry at the same 100 millisecond, 200 millisecond, 400
millisecond, and 800 millisecond boundaries.

Use it when reconnecting is safe and expected: the client can resubscribe,
refresh missed state, or resume from a known cursor after the socket is opened
again.

##### When not to use it

Do not retry authentication or authorization failures as if they were transient
socket failures. Expired credentials should refresh through the authentication
path; forbidden users should see the appropriate domain state.

Do not use reconnect backoff as the only protection for the realtime service.
Gateways still need connection limits, admission control, heartbeats, and
server-side overload behavior. The schedule only controls when this client tries
again.

Do not keep retrying forever in an interactive path without changing the user
state. After the retry budget is exhausted, surface that realtime updates are
disconnected and provide an explicit recovery path.

##### Schedule shape

Start with exponential backoff, add jitter, then clamp the final delay.

`Schedule.exponential` starts with a short reconnect delay and doubles by
default. `Schedule.jittered` randomly adjusts each computed delay between 80%
and 120% of that delay. `Schedule.modifyDelay` applies the cap after jitter, so
the final sleep never exceeds the cap.

`Schedule.recurs(8)` is the retry budget. With `Effect.retry`, the first
reconnect attempt runs immediately. If it fails, the schedule may allow up to
eight more attempts, each separated by the capped jittered backoff.

##### Example

```ts runnable deterministic
import { Console, Data, Duration, Effect, Schedule } from "effect"

class WebSocketReconnectError extends Data.TaggedError("WebSocketReconnectError")<{
  readonly reason: "closed" | "timeout" | "gateway-unavailable" | "unauthorized"
}> {}

let attempts = 0

const reconnectWebSocket: Effect.Effect<string, WebSocketReconnectError> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`reconnect attempt ${attempts}`)

  if (attempts === 1) {
    return yield* Effect.fail(new WebSocketReconnectError({ reason: "gateway-unavailable" }))
  }
  if (attempts === 2) {
    return yield* Effect.fail(new WebSocketReconnectError({ reason: "timeout" }))
  }

  return "socket-open"
})

const isRetryableReconnect = (error: WebSocketReconnectError) =>
  error.reason === "closed" ||
  error.reason === "timeout" ||
  error.reason === "gateway-unavailable"

const webSocketReconnectPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.satisfiesInputType<WebSocketReconnectError>(),
  Schedule.jittered,
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(50)))),
  Schedule.both(Schedule.recurs(8)),
  Schedule.while(({ input }) => isRetryableReconnect(input))
)

const program = reconnectWebSocket.pipe(
  Effect.retry(webSocketReconnectPolicy),
  Effect.tap((state) => Console.log(`connected: ${state}`))
)

Effect.runPromise(program).then(console.log, console.error)
// Output:
// reconnect attempt 1
// reconnect attempt 2
// reconnect attempt 3
// connected: socket-open
// socket-open
```

`program` calls `reconnectWebSocket` once immediately. If the attempt fails with
`closed`, `timeout`, or `gateway-unavailable`, the first retry waits around 100
milliseconds in a production-sized policy, adjusted by jitter. Later failures
use the exponential sequence as the base delay, then jitter and cap the final
sleep. The example uses 10 milliseconds so it terminates quickly.

If the failure is `unauthorized`, the `Schedule.while` predicate stops retrying
immediately. If all permitted retries fail, `Effect.retry` returns the last
`WebSocketReconnectError`, and the UI can move to an explicit disconnected
state.

##### Variants

For a very latency-sensitive UI, lower the cap and retry count. This gives the
client a few fast attempts before asking the user to retry or showing a degraded
realtime state.

For background clients, kiosks, or long-lived internal dashboards, use a larger
elapsed budget while keeping the per-delay cap. This lets the client keep
trying through a short outage without allowing any single sleep to grow beyond
the UI contract.

##### Notes and caveats

`Schedule.jittered` changes only delays. In Effect, it adjusts each delay between
`80%` and `120%` of the original delay. It does not classify errors, cap delays,
or decide how many retries are allowed.

Apply the cap after jitter when the maximum sleep is part of the user-facing
contract. Without the final `Schedule.modifyDelay`, a jittered exponential delay
can still grow past the amount of time the UI is willing to wait silently.

`Effect.retry` feeds the typed reconnect failure into the schedule. That is why
`Schedule.while` can stop retries for `unauthorized` while allowing transient
close, timeout, and gateway failures to use the reconnect policy.

Across a large client population, jitter is a load-shaping tool, not just a
latency detail. The cap protects one client from waiting too long; jitter helps
the realtime backend avoid synchronized reconnect waves from many clients.

### 28. Infrastructure and Platform Recipes

#### 28.1 Retry dependency checks during startup

Startup dependency checks sit between process boot and readiness. They can
absorb short platform races, but they should not hide configuration or schema
failures.

##### Problem

A service must prove that a required dependency is reachable before it marks
itself ready. DNS lookup failures, refused connections, and timeouts may clear
after a short wait. Bad credentials or schema mismatches should fail startup
immediately.

Use one retry policy for the dependency check, not for the whole boot sequence.
The policy should slow repeated failures, cap the number of retries, and keep
the total startup wait bounded.

##### When to use it

Use this recipe for idempotent startup probes such as database connectivity,
cache reachability, message broker readiness, feature flag client
initialization, or a search cluster health check.

It fits services that have not opened traffic yet and can afford a short
readiness delay while still giving operators a clear failure when the dependency
does not recover.

##### When not to use it

Do not retry permanent startup failures. Missing secrets, bad credentials,
invalid endpoints, incompatible schema versions, and malformed configuration
should fail startup immediately.

Do not put the whole boot sequence inside the retry. Keep the retry boundary
around the small dependency check. Initialization steps that create records,
run migrations, or perform writes need their own idempotency guarantees before
they are retried.

##### Schedule shape

Start with `Schedule.exponential` for backoff. It does not stop by itself, so
combine it with `Schedule.recurs` for the retry count and `Schedule.during` for
the elapsed startup budget.

Use `Schedule.modifyDelay` with `Duration.min` when no individual sleep should
grow beyond a maximum. `Schedule.both` keeps the policy running only while both
sides still allow another retry; the backoff supplies the delay, and the count
and time schedules supply stopping conditions.

##### Example

```ts runnable deterministic
import { Console, Data, Duration, Effect, Schedule } from "effect"

class DependencyCheckError extends Data.TaggedError("DependencyCheckError")<{
  readonly reason:
    | "DnsLookup"
    | "ConnectionRefused"
    | "Timeout"
    | "BadCredentials"
    | "SchemaMismatch"
}> {}

let attempts = 0

const checkDatabase = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`database check ${attempts}`)

  if (attempts === 1) {
    return yield* Effect.fail(new DependencyCheckError({ reason: "DnsLookup" }))
  }
  if (attempts === 2) {
    return yield* Effect.fail(new DependencyCheckError({ reason: "Timeout" }))
  }

  yield* Console.log("database reachable")
})

const isRetryableStartupFailure = (error: DependencyCheckError) =>
  error.reason === "DnsLookup" ||
  error.reason === "ConnectionRefused" ||
  error.reason === "Timeout"

const startupDependencyPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(30)))),
  Schedule.both(Schedule.recurs(5)),
  Schedule.both(Schedule.during("200 millis"))
)

const program = checkDatabase.pipe(
  Effect.retry({ schedule: startupDependencyPolicy, while: isRetryableStartupFailure }),
  Effect.flatMap(() => Console.log(`startup ready after ${attempts} checks`)),
  Effect.catch((error: DependencyCheckError) => Console.log(`startup failed: ${error.reason}`))
)

void Effect.runPromise(program)
// Output:
// database check 1
// database check 2
// database check 3
// database reachable
// startup ready after 3 checks
```

The demo runs quickly by using millisecond delays. In production, use larger
values that match the orchestrator's readiness budget. The first dependency
check runs immediately; only follow-up attempts are scheduled.

##### Variants

For a stricter container readiness path, reduce both the deadline and retry
count. For dependencies that commonly take longer during deploys, keep the first
retry quick but allow a longer total budget. If many instances start at the same
time, add `Schedule.jittered` before the delay cap so they do not retry on the
same boundaries.

##### Notes and caveats

`Effect.retry` feeds each typed failure into the schedule after the effect
fails. The original startup check is not delayed.

`Schedule.exponential` controls the waits between retries. It is not a total
timeout. Pair it with `Schedule.recurs` and `Schedule.during` when startup must
either become ready or fail within a known budget.

The deadline here is a schedule deadline, not a timeout for a single check. If
one dependency check can hang, put an Effect timeout on that check before
retrying it.

#### 28.2 Poll until all required services are ready

Startup readiness polling coordinates several platform services before traffic
opens. Keep readiness classification in domain code; let the schedule decide
when another successful observation is allowed.

##### Problem

At boot, the service reads a readiness snapshot for the database, broker, and
cache. It should keep polling while any required service is still starting, stop
immediately if a required service reports failure, and return a timeout result
if the startup budget expires.

##### When to use it

Use this recipe for boot-time coordination where readiness is eventually
consistent and a short wait is normal. It fits container startup, deployment
hooks, worker initialization, and control-plane checks where the caller needs
one final answer: ready, failed, or timed out.

##### When not to use it

Do not poll when the dependency provides a reliable startup event, health
stream, or orchestration signal. Also avoid this shape when a failed dependency
should not block the process; start in degraded mode and monitor readiness
separately.

##### Schedule shape

Use a spaced cadence, pass each successful readiness snapshot through as the
schedule output, and stop recurring once the latest snapshot is terminal. Add a
budget so startup cannot wait indefinitely.

The first readiness check happens before the schedule decides whether to recur.
The schedule controls only the follow-up checks.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

type ServiceName = "database" | "broker" | "cache"

type ServiceReadiness =
  | { readonly _tag: "Ready"; readonly service: ServiceName }
  | { readonly _tag: "Starting"; readonly service: ServiceName }
  | { readonly _tag: "Failed"; readonly service: ServiceName; readonly reason: string }

type FailedServiceReadiness = Extract<ServiceReadiness, { readonly _tag: "Failed" }>

interface ReadinessSnapshot {
  readonly services: ReadonlyArray<ServiceReadiness>
}

class ReadinessCheckError extends Data.TaggedError("ReadinessCheckError")<{
  readonly reason: string
}> {}

class StartupDependencyFailed extends Data.TaggedError("StartupDependencyFailed")<{
  readonly failed: ReadonlyArray<FailedServiceReadiness>
}> {}

class StartupReadinessTimedOut extends Data.TaggedError("StartupReadinessTimedOut")<{
  readonly latest: ReadinessSnapshot
}> {}

const snapshots: ReadonlyArray<ReadinessSnapshot> = [
  {
    services: [
      { _tag: "Starting", service: "database" },
      { _tag: "Starting", service: "broker" },
      { _tag: "Ready", service: "cache" }
    ]
  },
  {
    services: [
      { _tag: "Ready", service: "database" },
      { _tag: "Starting", service: "broker" },
      { _tag: "Ready", service: "cache" }
    ]
  },
  {
    services: [
      { _tag: "Ready", service: "database" },
      { _tag: "Ready", service: "broker" },
      { _tag: "Ready", service: "cache" }
    ]
  }
]

let reads = 0

const readPlatformReadiness = Effect.gen(function*() {
  const snapshot = snapshots[Math.min(reads, snapshots.length - 1)]
  reads += 1
  const summary = snapshot.services
    .map((service) => `${service.service}:${service._tag}`)
    .join(", ")
  yield* Console.log(
    `readiness ${reads}: ${summary}`
  )
  return snapshot
})

const allReady = (snapshot: ReadinessSnapshot) => snapshot.services.every((service) => service._tag === "Ready")

const failedServices = (snapshot: ReadinessSnapshot) =>
  snapshot.services.filter(
    (service): service is FailedServiceReadiness => service._tag === "Failed"
  )

const isTerminal = (snapshot: ReadinessSnapshot) => allReady(snapshot) || failedServices(snapshot).length > 0

const readinessPolling = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<ReadinessSnapshot>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminal(input)),
  Schedule.bothLeft(Schedule.during("200 millis")),
  Schedule.bothLeft(Schedule.recurs(5))
)

const waitForRequiredServices = Effect.gen(function*() {
  const latest = yield* Effect.repeat(readPlatformReadiness, readinessPolling)
  const failed = failedServices(latest)

  if (failed.length > 0) {
    return yield* Effect.fail(new StartupDependencyFailed({ failed }))
  }

  if (!allReady(latest)) {
    return yield* Effect.fail(new StartupReadinessTimedOut({ latest }))
  }

  return latest
})

const program = waitForRequiredServices.pipe(
  Effect.flatMap(() => Console.log("all required services are ready")),
  Effect.catch((error) => Console.log(`startup stopped: ${error._tag}`))
)

void Effect.runPromise(program)
// Output:
// readiness 1: database:Starting, broker:Starting, cache:Ready
// readiness 2: database:Ready, broker:Starting, cache:Ready
// readiness 3: database:Ready, broker:Ready, cache:Ready
// all required services are ready
```

##### Variants

For a single instance startup path, a short fixed cadence is usually enough. For
a large fleet, add jitter after choosing the base cadence so instances do not
poll the same platform APIs at the same time. For slow infrastructure, increase
the budget deliberately rather than leaving the schedule unbounded.

If readiness reads themselves can fail transiently, handle that separately from
terminal service state. Retry `readPlatformReadiness` on transport errors with a
small retry policy, then repeat successful snapshots with the readiness polling
policy.

##### Notes and caveats

`Effect.repeat` feeds successful values into the schedule, so
`Schedule.passthrough` lets the predicate inspect the latest
`ReadinessSnapshot`. The final check after `Effect.repeat` is still necessary:
the schedule can stop because every service is ready, because a service failed,
or because the budget was exhausted.

`Schedule.during` is a budget for recurrence decisions, not a replacement for
domain classification. Keep terminal states explicit so operators can
distinguish "dependency failed" from "startup waited long enough."

#### 28.3 Poll rollout status

Rollout polling turns an external deployment's progress into a bounded wait.
The status endpoint reports domain states as successful responses, so the
schedule should inspect those values rather than treat unfinished work as an
error.

##### Problem

A deploy controller has a rollout id and needs one final outcome: succeeded,
failed, or still running when the polling budget expires. While the latest
status is `"running"`, it should wait and read again.

Keep read failures separate from rollout failures. A timeout or malformed
response from the status endpoint belongs in the Effect error channel. A rollout
status of `"failed"` is a successful read that stops polling just like
`"succeeded"` does.

##### When to use it

Use this recipe when the rollout API exposes terminal domain states and callers
need to distinguish all three outcomes:

- the rollout is still `"running"` when the polling budget is exhausted
- the rollout finished with `"succeeded"`
- the rollout finished with `"failed"`

This is a good fit for deployment controllers, progressive delivery systems,
schema migrations, feature-flag rollouts, and infrastructure provisioning where
the operation continues outside the current process.

##### When not to use it

Do not use this as a retry policy for failed status reads. With `Effect.repeat`,
a failed read stops the repeat before the schedule can inspect a status. If
transient reads should be retried, add a separate `Effect.retry` around the
single status read.

Do not encode a rollout's terminal `"failed"` status as an Effect failure just
to stop polling. Keep it as a successful status value, stop the schedule, and
decide what it means after polling completes.

Do not leave a fleet-wide polling policy unbounded. Add an elapsed budget,
recurrence limit, or owner fiber that can interrupt the poller.

##### Schedule shape

Start with a cadence, add jitter for fleet-wide polling, pass the latest status
through as the schedule output, and continue only while the latest status is
running. Add a count or elapsed budget so a rollout that never becomes terminal
does not poll forever.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type RolloutStatus =
  | {
    readonly state: "running"
    readonly rolloutId: string
    readonly completedInstances: number
    readonly totalInstances: number
  }
  | {
    readonly state: "succeeded"
    readonly rolloutId: string
    readonly version: string
  }
  | {
    readonly state: "failed"
    readonly rolloutId: string
    readonly reason: string
  }

type StatusReadError = {
  readonly _tag: "StatusReadError"
  readonly rolloutId: string
}

type RolloutTimedOut = {
  readonly _tag: "RolloutTimedOut"
  readonly lastStatus: Extract<RolloutStatus, { readonly state: "running" }>
}

type RolloutFailed = {
  readonly _tag: "RolloutFailed"
  readonly rolloutId: string
  readonly reason: string
}

const statuses: ReadonlyArray<RolloutStatus> = [
  {
    state: "running",
    rolloutId: "rollout-42",
    completedInstances: 1,
    totalInstances: 3
  },
  {
    state: "running",
    rolloutId: "rollout-42",
    completedInstances: 2,
    totalInstances: 3
  },
  {
    state: "succeeded",
    rolloutId: "rollout-42",
    version: "2026.05.17"
  }
]

let reads = 0

const readRolloutStatus: (rolloutId: string) => Effect.Effect<RolloutStatus, StatusReadError> = Effect.fnUntraced(
  function*(rolloutId: string) {
    const status = statuses[Math.min(reads, statuses.length - 1)]
    reads += 1
    yield* Console.log(`rollout read ${reads} for ${rolloutId}: ${status.state}`)
    return status
  }
)

const pollRolloutStatus = Schedule.spaced("10 millis").pipe(
  Schedule.jittered,
  Schedule.satisfiesInputType<RolloutStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "running"),
  Schedule.bothLeft(Schedule.during("200 millis")),
  Schedule.bothLeft(Schedule.recurs(5))
)

const waitForRollout = (rolloutId: string) =>
  readRolloutStatus(rolloutId).pipe(
    Effect.repeat(pollRolloutStatus),
    Effect.flatMap((status): Effect.Effect<
      Extract<RolloutStatus, { readonly state: "succeeded" }>,
      RolloutFailed | RolloutTimedOut
    > => {
      switch (status.state) {
        case "succeeded":
          return Effect.succeed(status)
        case "failed":
          return Effect.fail(
            {
              _tag: "RolloutFailed",
              rolloutId: status.rolloutId,
              reason: status.reason
            } satisfies RolloutFailed
          )
        case "running":
          return Effect.fail(
            {
              _tag: "RolloutTimedOut",
              lastStatus: status
            } satisfies RolloutTimedOut
          )
      }
    })
  )

const program = waitForRollout("rollout-42").pipe(
  Effect.flatMap((status) => Console.log(`rollout ${status.rolloutId} finished on ${status.version}`)),
  Effect.catch((error: RolloutFailed | RolloutTimedOut | StatusReadError) =>
    Console.log(`rollout stopped: ${error._tag}`)
  )
)

void Effect.runPromise(program)
// Output:
// rollout read 1 for rollout-42: running
// rollout read 2 for rollout-42: running
// rollout read 3 for rollout-42: succeeded
// rollout rollout-42 finished on 2026.05.17
```

`waitForRollout` reads immediately. If the first result is `"succeeded"` or
`"failed"`, there is no delay and no second request. If the result is
`"running"`, the schedule waits, applies jitter, and reads again.

The repeat returns the last observed `RolloutStatus`. The final `flatMap` keeps
the three outcomes separate: success returns the succeeded status, rollout
failure becomes `RolloutFailed`, and exhausting the polling budget while still
running becomes `RolloutTimedOut`.

##### Variants

For a command-line tool, use a smaller budget. For a background reconciler, use
a slower cadence and a recurrence cap when each read already has its own request
timeout. For transient status-read failures, retry the read itself and then
repeat successful statuses:

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type StatusReadError = { readonly _tag: "StatusReadError" }
type RolloutStatus = { readonly state: "running" | "succeeded" }

let attempts = 0

const readStatus = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`status read attempt ${attempts}`)
  if (attempts === 1) {
    return yield* Effect.fail({ _tag: "StatusReadError" } satisfies StatusReadError)
  }
  return { state: attempts < 3 ? "running" : "succeeded" } satisfies RolloutStatus
})

const readRetry = Schedule.exponential("10 millis").pipe(
  Schedule.both(Schedule.recurs(2))
)

const pollStatus = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<RolloutStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.state === "running"),
  Schedule.bothLeft(Schedule.recurs(4))
)

const program = readStatus.pipe(
  Effect.retry(readRetry),
  Effect.repeat(pollStatus),
  Effect.flatMap((status) => Console.log(`final status: ${status.state}`)),
  Effect.catch((error: StatusReadError) => Console.log(`status read failed: ${error._tag}`))
)

void Effect.runPromise(program)
// Output:
// status read attempt 1
// status read attempt 2
// status read attempt 3
// final status: succeeded
```

The retry schedule sees status-read errors. The repeat schedule sees successful
`RolloutStatus` values.

##### Notes and caveats

The first status read is not delayed. Schedule delays apply only before later
recurrences.

`Schedule.while` is evaluated after a successful status read. It does not cancel
a read that is already in progress.

`Schedule.during` limits recurrence decisions. If the budget is exhausted before
a terminal status is observed, `Effect.repeat` still returns the last successful
status, which can be `"running"`.

Use `Schedule.passthrough` when the caller needs the final domain status. If you
omit it, the repeat returns the timing schedule's output instead of the rollout
status.

#### 28.4 Retry deployment hooks

Deployment hooks bridge a deploy system and external platform services. They
can be retried only when the hook call has a duplicate-safe contract and the
retry policy is bounded.

##### Problem

After a deployment reaches the point where post-deploy hooks should run, the
hook endpoint sometimes returns a timeout, `429`, or `503`. The hook operation is
idempotent because the request includes a stable deployment id and hook id, so
the receiver can collapse duplicates.

The retry policy should run the first call immediately, back off after failures,
add jitter for fleet-wide deploys, cap the delay, stop after a small number of
retries, and retry only transient hook failures.

##### When to use it

Use this recipe for deployment hooks that have an explicit duplicate-suppression
boundary: an idempotency key, a natural resource identity, or a receiver-side
record keyed by deployment and hook name.

It fits post-deploy notifications, audit writes, cache purge requests, smoke
test triggers, and control-plane updates where a retry can reasonably succeed
after a short outage or rate-limit window.

##### When not to use it

Do not retry a hook that is not idempotent. If the receiver creates a ticket,
sends a page, advances a workflow, or mutates deployment state without a
duplicate key, retrying can perform the action more than once.

Do not retry permanent errors. Bad hook configuration, missing credentials,
forbidden access, unknown deployment ids, and validation failures should surface
as deployment problems instead of being hidden behind backoff.

##### Schedule shape

Use exponential backoff with jitter, cap each sleep, and combine it with
`Schedule.recurs`. `Effect.retry` feeds typed failures into the schedule, so a
`while` predicate can stop immediately for non-retryable hook errors.

##### Example

```ts runnable deterministic
import { Console, Data, Duration, Effect, Schedule } from "effect"

class DeploymentHookError extends Data.TaggedError("DeploymentHookError")<{
  readonly status: number
  readonly message: string
}> {}

interface HookReceipt {
  readonly deploymentId: string
  readonly hookName: string
  readonly accepted: boolean
}

let attempts = 0

const invokeDeploymentHook: (request: {
  readonly deploymentId: string
  readonly hookName: string
  readonly idempotencyKey: string
}) => Effect.Effect<HookReceipt, DeploymentHookError> = Effect.fnUntraced(function*(request) {
  attempts += 1
  yield* Console.log(`hook attempt ${attempts}: ${request.hookName}`)

  if (attempts === 1) {
    return yield* Effect.fail(
      new DeploymentHookError({
        status: 503,
        message: "hook receiver unavailable"
      })
    )
  }
  if (attempts === 2) {
    return yield* Effect.fail(
      new DeploymentHookError({
        status: 429,
        message: "hook receiver is throttling"
      })
    )
  }

  return {
    deploymentId: request.deploymentId,
    hookName: request.hookName,
    accepted: true
  } satisfies HookReceipt
})

const isRetryableHookError = (error: DeploymentHookError) =>
  error.status === 408 ||
  error.status === 409 ||
  error.status === 429 ||
  error.status >= 500

const deploymentHookRetryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.satisfiesInputType<DeploymentHookError>(),
  Schedule.jittered,
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(40)))),
  Schedule.both(Schedule.recurs(5)),
  Schedule.while(({ input }) => isRetryableHookError(input))
)

const program = invokeDeploymentHook({
  deploymentId: "deploy-2026-05-16-001",
  hookName: "post-deploy-smoke-test",
  idempotencyKey: "deploy-2026-05-16-001:post-deploy-smoke-test"
}).pipe(
  Effect.retry(deploymentHookRetryPolicy),
  Effect.flatMap((receipt) => Console.log(`hook accepted: ${receipt.deploymentId}/${receipt.hookName}`)),
  Effect.catch((error: DeploymentHookError) => Console.log(`hook failed with status ${error.status}: ${error.message}`))
)

void Effect.runPromise(program)
// Output:
// hook attempt 1: post-deploy-smoke-test
// hook attempt 2: post-deploy-smoke-test
// hook attempt 3: post-deploy-smoke-test
// hook accepted: deploy-2026-05-16-001/post-deploy-smoke-test
```

##### Variants

For a latency-sensitive deploy gate, reduce the retry count or combine the
policy with `Schedule.during` so the deployment controller gets a clear failure
within its rollout budget.

For a best-effort notification hook, keep the deployment path short and enqueue
the hook for a worker that can use a longer retry policy outside the critical
rollout path.

For hooks called by many services at once, keep jitter enabled even when the
maximum delay is low. Backoff reduces pressure after repeated failures; jitter
reduces synchronization across callers.

##### Notes and caveats

The original hook call is not counted by `Schedule.recurs(5)`. The schedule
controls only follow-up retries after a failure, so this policy permits one
initial call plus at most five retries.

`Schedule.exponential` has no retry limit by itself. Always pair it with
`Schedule.recurs`, `Schedule.take`, `Schedule.during`, or a predicate that stops
when retrying no longer makes sense.

Backoff does not make a hook safe to retry. The safety boundary must come from
the hook protocol: a stable idempotency key, deterministic operation identity,
or receiver-side deduplication.

`Effect.retry` feeds `DeploymentHookError` values into the schedule. That is why
`Schedule.while` can classify retryable statuses without mixing sleeps and
counters into the hook implementation.

#### 28.5 Retry infrastructure API calls

Infrastructure retries happen against shared control-plane capacity. A useful
retry policy gives transient failures time to clear without turning automation
into a traffic spike.

##### Problem

A provisioning worker calls a provider API to create a subnet. The request may
time out, receive a `503`, or hit a `429`; invalid requests and unsafe writes
should leave the retry path immediately.

Retrying immediately can make the incident worse. Retrying forever can hold a
worker or deployment open past its useful deadline. Retrying an unsafe write can
duplicate side effects. Model retryable infrastructure failures explicitly and
put the recurrence policy in one named schedule.

##### When to use it

Use this recipe when the operation is safe to attempt more than once and the
failure is plausibly temporary. Good examples include reading instance status,
refreshing a load balancer target, creating a resource with an idempotency key,
or applying the same desired state to the same resource identifier.

It is especially useful for platform workers that may run in parallel. Backoff
reduces pressure on a struggling dependency, jitter prevents many workers from
retrying in the same millisecond, and a time budget gives operators a clear
deadline for when the retry window closes.

##### When not to use it

Do not retry authorization failures, malformed requests, missing tenants,
invalid resource names, or other permanent errors. Those failures should leave
the retry path immediately.

Do not retry non-idempotent writes unless the API gives you a duplicate-safe
contract, such as an idempotency key, a stable client token, an upsert by
resource name, or a documented "set desired state" endpoint.

Do not treat `429 Too Many Requests` like an ordinary `503`. A rate limit is
feedback from the provider that this caller should slow down. Preserve
`Retry-After` or quota metadata when the API gives it to you.

##### Schedule shape

Start with exponential backoff, add jitter, and combine it with both a retry
count and an elapsed retry budget. `Schedule.both` continues only while both
sides continue and uses the maximum of their delays; the backoff side supplies
the waits while the count and duration schedules supply stopping conditions.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class ApiTimeout extends Data.TaggedError("ApiTimeout")<{
  readonly operation: "CreateSubnet"
}> {}

class ApiUnavailable extends Data.TaggedError("ApiUnavailable")<{
  readonly status: 502 | 503 | 504
}> {}

class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly retryAfterMillis?: number
}> {}

class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly reason: string
}> {}

type InfrastructureApiError =
  | ApiTimeout
  | ApiUnavailable
  | RateLimited
  | InvalidRequest

let attempts = 0

const createSubnet: (request: {
  readonly vpcId: string
  readonly cidrBlock: string
  readonly clientToken: string
}) => Effect.Effect<string, InfrastructureApiError> = Effect.fnUntraced(function*(request) {
  attempts += 1
  yield* Console.log(`create subnet attempt ${attempts} with ${request.clientToken}`)

  if (attempts === 1) {
    return yield* Effect.fail(new ApiTimeout({ operation: "CreateSubnet" }))
  }
  if (attempts === 2) {
    return yield* Effect.fail(new ApiUnavailable({ status: 503 }))
  }

  return `subnet-${request.cidrBlock}`
})

const retryInfrastructureApi = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
  Schedule.both(Schedule.during("200 millis"))
)

const program = createSubnet({
  vpcId: "vpc-123",
  cidrBlock: "10.0.8.0/24",
  clientToken: "deploy-2026-05-16-subnet-10-0-8"
}).pipe(
  Effect.retry({
    schedule: retryInfrastructureApi,
    while: (error) =>
      error._tag === "ApiTimeout" ||
      error._tag === "ApiUnavailable" ||
      error._tag === "RateLimited"
  }),
  Effect.flatMap((subnetId) => Console.log(`created ${subnetId}`)),
  Effect.catch((error: InfrastructureApiError) => Console.log(`infrastructure call failed: ${error._tag}`))
)

void Effect.runPromise(program)
// Output:
// create subnet attempt 1 with deploy-2026-05-16-subnet-10-0-8
// create subnet attempt 2 with deploy-2026-05-16-subnet-10-0-8
// create subnet attempt 3 with deploy-2026-05-16-subnet-10-0-8
// created subnet-10.0.8.0/24
```

The `clientToken` is the idempotency guard. If the first request reached the
provider but the response was lost, the retry represents the same logical
operation rather than a second independent subnet creation.

`InvalidRequest` is deliberately excluded from the retry predicate. Repeating
the same malformed request would only spend retry budget and add control-plane
traffic.

##### Variants

When a rate-limit response includes provider guidance, keep that information in
the typed error and prefer the provider's `Retry-After` timing over a guessed
delay. For background reconciliation, use a larger budget but keep the same
shape. For an interactive deployment command, shorten the budget so the caller
gets a clear result quickly.

##### Notes and caveats

`Effect.retry` feeds typed failures into the schedule after an attempt fails.
The first infrastructure API call is not delayed, and defects or interruptions
are not treated as typed retry failures.

`Schedule.during` is a retry-window budget, not a hard deadline for an
individual HTTP request. If each API attempt also needs its own timeout, put
that timeout around the API call itself and then retry the resulting typed
timeout failure.

Backoff and jitter protect the provider, but they do not make a write safe.
Idempotency is a property of the API request and the provider contract. Use a
stable client token, resource name, deduplication key, or "set desired state"
operation before retrying writes.

Keep rate-limit handling explicit. A generic jittered backoff is acceptable
when no retry hint exists, but provider guidance such as `Retry-After` should
usually win over a guessed delay.

### 29. Data and Batch Recipes

#### 29.1 Poll ETL status until completion

ETL polling observes work that continues in a data platform after submission.
Treat status responses as domain values; let the schedule decide when to ask
again and let surrounding Effect code interpret the final state.

##### Problem

A caller has an ETL run id and needs the last observed status: terminal if the
run finishes, or still active when the polling window expires. Active states
should be spaced out with waits between reads instead of a tight loop.

The status check itself can also hang or fail. That is a separate concern from
the polling schedule: use an operation timeout for each status read, and use a
schedule budget for the overall recurrence window.

##### When to use it

Use this when the ETL platform exposes completion as a status endpoint and the
non-terminal statuses are normal successful values.

This is a good fit for batch imports, warehouse loads, dbt or Spark jobs,
materialized-view refreshes, and vendor APIs where completion is observed by
polling a run id.

##### When not to use it

Do not use this to hide a broken status endpoint. With `Effect.repeat`, a
failure from the status read stops polling. Add a separate retry policy around
the status read only when transport or decoding failures are transient and safe
to retry.

Do not turn ETL terminal states such as `"failed"` or `"canceled"` into effect
failures inside the polling loop unless every caller wants that behavior. It is
usually clearer to poll until a terminal status is observed, then map the final
status into the caller's domain result.

Do not treat `Schedule.during` as a hard timeout for an in-flight HTTP request.
It is evaluated at recurrence decision points. Use `Effect.timeout` on the
status read when each request needs its own interruption limit.

##### Schedule shape

Combine a polling cadence, a terminal-state predicate, and an elapsed recurrence
budget. `Schedule.spaced` waits after each completed status read before the next
poll. `Schedule.while` continues only while the latest successful status is
non-terminal. `Schedule.during` bounds the recurrence window.

`Schedule.passthrough` makes the schedule output the latest `EtlStatus`, and
`Schedule.bothLeft` preserves that output after composing the elapsed budget.
The repeated effect therefore returns the final observed ETL status, not the
schedule's timing or count output.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type EtlStatus =
  | { readonly state: "queued" }
  | { readonly state: "extracting"; readonly rowsRead: number }
  | { readonly state: "loading"; readonly rowsWritten: number }
  | { readonly state: "succeeded"; readonly outputTable: string }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "canceled" }

type StatusReadError = {
  readonly _tag: "StatusReadError"
  readonly message: string
}

const isTerminal = (status: EtlStatus): boolean =>
  status.state === "succeeded" ||
  status.state === "failed" ||
  status.state === "canceled"

const statuses: ReadonlyArray<EtlStatus> = [
  { state: "queued" },
  { state: "extracting", rowsRead: 1_000 },
  { state: "loading", rowsWritten: 1_000 },
  { state: "succeeded", outputTable: "analytics.daily_orders" }
]

let reads = 0

const readEtlStatus: (runId: string) => Effect.Effect<EtlStatus, StatusReadError> = Effect.fnUntraced(
  function*(runId: string) {
    const status = statuses[Math.min(reads, statuses.length - 1)]
    reads += 1
    yield* Console.log(`ETL ${runId} read ${reads}: ${status.state}`)
    return status
  }
)

const pollEtlStatusBudget = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<EtlStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminal(input)),
  Schedule.bothLeft(Schedule.during("300 millis")),
  Schedule.bothLeft(Schedule.recurs(8))
)

const pollEtlStatus = (runId: string) =>
  readEtlStatus(runId).pipe(
    Effect.timeout("50 millis"),
    Effect.repeat(pollEtlStatusBudget)
  )

const program = pollEtlStatus("etl-run-7").pipe(
  Effect.flatMap((status) =>
    status.state === "succeeded"
      ? Console.log(`ETL completed: ${status.outputTable}`)
      : Console.log(`ETL stopped while ${status.state}`)
  ),
  Effect.catch((error) => Console.log(`ETL status read failed: ${String(error)}`))
)

void Effect.runPromise(program)
// Output:
// ETL etl-run-7 read 1: queued
// ETL etl-run-7 read 2: extracting
// ETL etl-run-7 read 3: loading
// ETL etl-run-7 read 4: succeeded
// ETL completed: analytics.daily_orders
```

`pollEtlStatus` performs the first status read immediately. If the first
successful response is `"succeeded"`, `"failed"`, or `"canceled"`, polling stops
without waiting. If the response is still active, the schedule waits before the
next read and continues while the recurrence budget allows another poll.

The effect succeeds with the last observed `EtlStatus`. That status may be
terminal, or it may still be active if the schedule budget stopped allowing
further recurrences. The effect fails only if a status read fails or if a
per-read timeout interrupts a status read.

##### Variants

For a user-facing request, shorten both limits: a one-second status-read timeout
and a 30-second recurrence budget often make more sense than a long batch
worker budget.

For a background reconciler, increase the spacing and add `Schedule.jittered`
after the basic policy is correct so many workers do not poll the ETL control
plane at the same instant.

If the caller must fail when the ETL run ends in `"failed"` or `"canceled"`,
keep that decision after polling. This keeps polling mechanics separate from the
business rule for incomplete or unsuccessful ETL runs.

##### Notes and caveats

The first status read is not delayed. The schedule controls only recurrences
after a successful status read.

`Effect.repeat` feeds successful `EtlStatus` values into the schedule. Failed
status reads do not become schedule inputs.

`Schedule.during` is a recurrence budget, not a hard deadline for the whole
program. `Effect.timeout` is the per-read timeout in this example.

When a timing schedule reads the latest status through `metadata.input`,
constrain the schedule with `Schedule.satisfiesInputType<EtlStatus>()` before
using `Schedule.while`.

#### 29.2 Retry export generation

Export retries spend real batch capacity, so the policy should be conservative.
Keep transient-error classification and the retry limit visible next to the
generation call.

##### Problem

A report, invoice bundle, or customer data export may fail because the database
is temporarily unavailable, the renderer is saturated, or object storage is
down. Invalid requests and permission failures should surface immediately.

The retry schedule should recover from short outages without regenerating large
exports indefinitely.

##### When to use it

Use this recipe when export generation is idempotent or protected by an export
job id, so a repeated attempt resumes or replaces the same logical export rather
than creating duplicate user-visible artifacts. It is also a good fit when the
caller can wait a short time for recovery, but the system must not keep retrying
large batch work indefinitely.

##### When not to use it

Do not retry malformed filters, missing authorization, unsupported formats, or
other permanent request problems. Do not use this policy for non-idempotent
exports that create a new billable artifact on every attempt unless the
generation layer has a deduplication key.

##### Schedule shape

Use `Effect.retry` because export generation is retried after failures. The
retry options receive each failure in `while`, so the classifier can stop the
retry loop for permanent errors. Combine that classifier with bounded backoff
and jitter so export workers do not retry in lockstep.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type ExportRequest = {
  readonly exportId: string
  readonly accountId: string
  readonly format: "csv" | "parquet"
}

type ExportFile = {
  readonly exportId: string
  readonly location: string
}

type ExportError =
  | { readonly _tag: "DatabaseUnavailable" }
  | { readonly _tag: "RendererBusy" }
  | { readonly _tag: "ObjectStorageUnavailable" }
  | { readonly _tag: "InvalidExportRequest"; readonly reason: string }
  | { readonly _tag: "PermissionDenied" }

let attempts = 0

const generateExport: (request: ExportRequest) => Effect.Effect<ExportFile, ExportError> = Effect.fnUntraced(
  function*(request: ExportRequest) {
    attempts += 1
    yield* Console.log(`export attempt ${attempts}: ${request.exportId}`)

    if (attempts === 1) {
      return yield* Effect.fail({ _tag: "RendererBusy" } satisfies ExportError)
    }
    if (attempts === 2) {
      return yield* Effect.fail({ _tag: "ObjectStorageUnavailable" } satisfies ExportError)
    }

    return {
      exportId: request.exportId,
      location: `s3://exports/${request.accountId}/${request.exportId}.${request.format}`
    }
  }
)

const isTransientExportError = (error: ExportError): boolean => {
  switch (error._tag) {
    case "DatabaseUnavailable":
    case "RendererBusy":
    case "ObjectStorageUnavailable":
      return true
    case "InvalidExportRequest":
    case "PermissionDenied":
      return false
  }
}

const retryTransientExportFailures = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(4))
)

const runExport = (request: ExportRequest) =>
  generateExport(request).pipe(
    Effect.retry({
      schedule: retryTransientExportFailures,
      while: isTransientExportError
    })
  )

const program = runExport({
  exportId: "export-2026-05-17",
  accountId: "acct-123",
  format: "csv"
}).pipe(
  Effect.flatMap((file) => Console.log(`export ready: ${file.location}`)),
  Effect.catch((error: ExportError) => Console.log(`export failed: ${error._tag}`))
)

void Effect.runPromise(program)
// Output:
// export attempt 1: export-2026-05-17
// export attempt 2: export-2026-05-17
// export attempt 3: export-2026-05-17
// export ready: s3://exports/acct-123/export-2026-05-17.csv
```

##### Variants

For an interactive download, reduce the retry count or add
`Schedule.during("10 seconds")` so the caller gets a timely failure. For a
background export queue, use a larger job-level timeout outside the retry policy
and keep this schedule focused on short transient recovery. For a large worker
fleet, keep `Schedule.jittered`; synchronized retries from many failed exports
can become a second incident.

##### Notes and caveats

`Schedule.recurs(4)` allows at most four retries after the first generation
attempt. The `while` predicate passed to `Effect.retry` inspects each typed
failure; when the error is permanent, retrying stops and the original export
error is returned. Keep the classifier conservative. It is better to surface a
permanent export failure than to repeatedly regenerate a large file that can
never succeed.

#### 29.3 Retry file upload to object storage

Object storage uploads are retryable only when duplicate attempts are harmless.
The upload protocol supplies the stable identity; the schedule supplies bounded
retry pressure.

##### Problem

A batch worker is writing a deterministic export object to storage. The network
can drop, the service can throttle, and the worker can lose the response after
the server has already accepted bytes.

Blind retrying is risky. A second attempt might create a duplicate object, leave
an incomplete multipart upload behind, or put avoidable pressure on a shared
storage account. The retry policy must be bounded, and the upload operation must
be written so a repeated attempt has a well-defined outcome.

##### When to use it

Use this recipe when the upload target is idempotent by design: the object key
is deterministic, the content checksum is stable, conditional writes are used,
or the storage API supports an idempotency token or resumable upload id.

It is a good fit for batch exports, reports, media processing outputs, data lake
ingestion, and checkpoint files where transient failures should recover without
requiring an operator to restart the whole job.

##### When not to use it

Do not apply this schedule to an upload that generates a new object key on every
attempt. That turns a transient failure into possible duplicate data.

Do not retry validation failures, forbidden writes, missing buckets, unsupported
storage classes, checksum mismatches, or request bodies that cannot be replayed.
Those are not timing problems.

Do not rely on retry alone for multipart uploads. Multipart protocols also need
cleanup or resume rules for abandoned parts, and retries must not complete two
different upload sessions for the same logical file.

##### Schedule shape

`Schedule.exponential("250 millis")` spaces repeated failures with a growing
delay. This reduces pressure on object storage when the service is already slow
or throttling.

`Schedule.jittered` randomizes the selected delay so many workers do not retry
the same storage bucket at the same instant.

`Schedule.recurs(5)` caps the number of retries after the original attempt. The
first upload still runs immediately; the schedule only controls follow-up
attempts after typed failures.

`Schedule.during("30 seconds")` caps the elapsed retry window. Combining the
count limit and elapsed budget with `Schedule.both` means both limits must
allow another retry.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class UploadError extends Data.TaggedError("UploadError")<{
  readonly reason:
    | "Timeout"
    | "Throttled"
    | "Unavailable"
    | "ChecksumMismatch"
    | "Forbidden"
    | "BadRequest"
}> {}

interface UploadRequest {
  readonly bucket: string
  readonly key: string
  readonly body: Uint8Array
  readonly checksumSha256: string
  readonly idempotencyKey: string
}

let attempts = 0

const uploadObject: (request: UploadRequest) => Effect.Effect<void, UploadError> = Effect.fnUntraced(
  function*(request: UploadRequest) {
    attempts += 1
    yield* Console.log(`upload attempt ${attempts}: ${request.bucket}/${request.key}`)

    if (attempts === 1) {
      return yield* Effect.fail(new UploadError({ reason: "Throttled" }))
    }
    if (attempts === 2) {
      return yield* Effect.fail(new UploadError({ reason: "Timeout" }))
    }

    yield* Console.log(`stored checksum ${request.checksumSha256}`)
  }
)

const isTransientStorageError = (error: UploadError) =>
  error.reason === "Timeout" ||
  error.reason === "Throttled" ||
  error.reason === "Unavailable"

const uploadRetryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
  Schedule.both(Schedule.during("200 millis"))
)

const uploadReport = (body: Uint8Array, checksumSha256: string) =>
  uploadObject({
    bucket: "reports",
    key: `daily/${checksumSha256}.json`,
    body,
    checksumSha256,
    idempotencyKey: checksumSha256
  }).pipe(
    Effect.retry({
      schedule: uploadRetryPolicy,
      while: isTransientStorageError
    })
  )

const program = uploadReport(
  new TextEncoder().encode("{\"rows\":3}"),
  "sha256-demo"
).pipe(
  Effect.flatMap(() => Console.log("upload complete")),
  Effect.catch((error: UploadError) => Console.log(`upload failed: ${error.reason}`))
)

void Effect.runPromise(program)
// Output:
// upload attempt 1: reports/daily/sha256-demo.json
// upload attempt 2: reports/daily/sha256-demo.json
// upload attempt 3: reports/daily/sha256-demo.json
// stored checksum sha256-demo
// upload complete
```

The object key and idempotency key are derived from the content checksum. If the
worker retries after losing a response, it is still asking storage to create the
same logical object, not a new one. In a real client, pair this with the storage
provider's conditional write, checksum, or idempotency feature so a duplicate
attempt is recognized as the same upload.

If the service returns `Timeout`, `Throttled`, or `Unavailable`, the failure is
fed to the schedule. If it returns `ChecksumMismatch`, `Forbidden`, or
`BadRequest`, retrying stops immediately and the typed failure is returned.

##### Variants

For small user-facing uploads, shorten both limits. For large batch uploads,
prefer a slower policy over a larger retry count.

For multipart uploads, retry the smallest safe unit. Retrying an individual part
with a stable upload id, part number, and part checksum is usually safer than
restarting the whole object. Retrying completion is only safe when the complete
request is deterministic and the provider treats duplicate completion as
idempotent or already completed.

##### Notes and caveats

`Effect.retry` feeds typed failures into the schedule. The `while` predicate
classifies storage errors before the schedule spends another retry.

`Schedule.during` bounds the retry window at recurrence decision points. It does
not cancel an upload attempt that is already in flight. If each attempt needs an
individual deadline, apply a timeout to `uploadObject` separately.

Retry policy cannot replace storage-level correctness. Use deterministic object
names, checksums, conditional writes, idempotency keys, resumable upload ids, and
multipart cleanup rules so retrying a failed attempt is operationally safe.

#### 29.4 Retry import processing after transient failures

Import retry policies belong around one idempotent processing step. They should
show the retry cadence, the retry budget, and the failure classifier without
hiding permanent data problems.

##### Problem

An import worker is processing one batch from object storage into a staging
database and an enrichment service. Storage timeouts or temporary database
unavailability may clear on another attempt; invalid CSV structure or a
violated domain rule should stop immediately.

The retry policy needs to be local to the idempotent processing step. Do not
wrap the whole worker loop in a retry if only the batch write or enrichment call
is transient. Retrying too much work can duplicate side effects, hide a bad
record, or keep an unhealthy dependency under pressure.

##### When to use it

Use this recipe when a single import batch can be safely attempted more than
once. That usually means the processor uses a stable import id, deduplicates
records, writes through upserts or transactions, and can resume without creating
duplicate rows or duplicate external events.

It fits batch imports from files, queue-backed import jobs, and ETL staging
steps where operational failures are expected but should remain bounded.

##### When not to use it

Do not retry malformed input. A missing required column, invalid encoding,
failed schema validation, or rejected business rule will usually fail again
after the delay.

Do not retry processing that is not idempotent. If a retry can insert the same
customer twice, send the same notification twice, or publish the same accounting
event twice, fix that boundary first with an idempotency key, unique constraint,
transactional write, or outbox.

Do not use a retry schedule as a queue visibility timeout or leasing mechanism.
Let the queue or job coordinator own claiming and redelivery. Use `Schedule` for
the local decision to reattempt one failed effect.

##### Schedule shape

Use `Effect.retry` around the idempotent import step. With retry, the original
attempt runs immediately; the schedule controls only follow-up attempts after
typed failures.

For transient import failures, a small exponential backoff is a better default
than a fixed interval because it backs away from overloaded storage, databases,
or enrichment services. `Schedule.exponential` keeps increasing the delay and
does not stop by itself, so combine it with `Schedule.recurs`. Add
`Schedule.jittered` when many workers may retry similar imports at the same
time.

Keep retry eligibility in an error predicate. The schedule describes timing and
limits; the predicate decides whether the typed failure is transient enough to
retry.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

class StorageTimeout extends Data.TaggedError("StorageTimeout")<{
  readonly importId: string
}> {}

class StagingDatabaseUnavailable extends Data.TaggedError("StagingDatabaseUnavailable")<{
  readonly importId: string
}> {}

class InvalidImportFile extends Data.TaggedError("InvalidImportFile")<{
  readonly importId: string
  readonly reason: string
}> {}

class DuplicateExternalEventRisk extends Data.TaggedError("DuplicateExternalEventRisk")<{
  readonly importId: string
}> {}

type ImportError =
  | StorageTimeout
  | StagingDatabaseUnavailable
  | InvalidImportFile
  | DuplicateExternalEventRisk

interface ImportBatch {
  readonly importId: string
  readonly sourceUri: string
}

const batch: ImportBatch = {
  importId: "import-2026-05-17",
  sourceUri: "s3://imports/customers.csv"
}

let attempts = 0

const processImportBatch: (batch: ImportBatch) => Effect.Effect<void, ImportError> = Effect.fnUntraced(
  function*(batch: ImportBatch) {
    attempts += 1
    yield* Console.log(`import attempt ${attempts}: ${batch.sourceUri}`)

    if (attempts === 1) {
      return yield* Effect.fail(new StorageTimeout({ importId: batch.importId }))
    }
    if (attempts === 2) {
      return yield* Effect.fail(new StagingDatabaseUnavailable({ importId: batch.importId }))
    }

    yield* Console.log(`imported batch ${batch.importId}`)
  }
)

const isTransientImportError = (error: ImportError): boolean => {
  switch (error._tag) {
    case "StorageTimeout":
    case "StagingDatabaseUnavailable":
      return true
    case "InvalidImportFile":
    case "DuplicateExternalEventRisk":
      return false
  }
}

const retryTransientImportFailure = Schedule.exponential("10 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5))
)

const program = processImportBatch(batch).pipe(
  Effect.retry({
    schedule: retryTransientImportFailure,
    while: isTransientImportError
  }),
  Effect.flatMap(() => Console.log("import finished")),
  Effect.catch((error: ImportError) => Console.log(`import failed: ${error._tag}`))
)

void Effect.runPromise(program)
// Output:
// import attempt 1: s3://imports/customers.csv
// import attempt 2: s3://imports/customers.csv
// import attempt 3: s3://imports/customers.csv
// imported batch import-2026-05-17
// import finished
```

`program` processes the batch once immediately. If object storage times out or
the staging database is temporarily unavailable, the retry policy uses jittered
exponential backoff for at most five retries after the original attempt. If the
file is invalid, or the processor detects that retrying could duplicate an
external event, retrying stops immediately and the typed error is propagated.

The example assumes `processImportBatch` is idempotent for the retryable cases:
it uses `importId` as the stable identity for writes, can observe already
imported records, and does not emit irreversible side effects until the
transactional import state says it is safe.

##### Variants

For a short interactive import preview, keep the budget smaller. For a
background import worker, use a slower base delay and `Schedule.tapInput` to log
each retry input.

For a dependency that exposes a precise `Retry-After` value, keep that timing
near the adapter and make the schedule responsible for the maximum number of
reattempts. Do not mix retry-after handling with validation or idempotency
checks.

##### Notes and caveats

`Effect.retry` feeds typed failures into the schedule. That is why
`Schedule.tapInput` can observe an `ImportError` in the background-worker
variant. `Effect.repeat` is the wrong tool for this recipe because it feeds
successful values into the schedule and stops on failure unless the failure is
handled separately.

`Schedule.recurs(5)` means five retries after the original attempt, not five
total executions. Because `Schedule.exponential` is unbounded, keep an explicit
limit on import retries unless another operational budget is enforcing a
stricter bound.

A retry policy cannot make an unsafe import safe. Make idempotency part of the
processor contract, and treat any uncertainty about duplicate side effects as a
non-retryable typed failure.

#### 29.5 Pace reprocessing of failed records

Failed-record reprocessing is a background repair path. It should make steady
progress without turning stale failures into constant database pressure.

##### Problem

A worker reads records marked failed, re-runs the operation for a small batch,
and updates each record as completed or still failed. Without a spaced
recurrence policy, it can fall into a tight scan/write loop against the same
rows.

The recurrence policy needs to answer three operational questions:

- how much time to leave between reprocessing passes
- how many follow-up passes the worker will run
- whether each pass is safe to repeat when the same record is seen again

##### Schedule shape

Model one reprocessing pass as an `Effect`, then repeat that pass with
`Schedule.spaced`. `Schedule.spaced("30 seconds")` waits for thirty seconds
after a pass completes before the next pass starts. That is usually the right
shape for database repair work because a slow pass naturally reduces the rate of
future database reads and writes.

Limit the schedule with `Schedule.take` when the worker is invoked as a bounded
job. A daemon can use the same base cadence with a larger limit, a longer
interval, or an outer supervisor that starts the worker again.

##### Example

```ts runnable deterministic
import { Console, Data, Effect, Schedule } from "effect"

type FailedRecord = {
  readonly id: string
  readonly payload: unknown
}

class ReprocessError extends Data.TaggedError("ReprocessError")<{
  readonly recordId: string
}> {}

let pass = 0
const remainingAttempts = new Map([
  ["record-a", 1],
  ["record-b", 2]
])

const loadFailedRecords = Effect.gen(function*() {
  pass += 1
  const records = Array.from(remainingAttempts.keys()).map((id) => ({
    id,
    payload: { id }
  }))
  yield* Console.log(`pass ${pass}: loaded ${records.length} failed records`)
  return records
})

const reprocessRecord: (record: FailedRecord) => Effect.Effect<void, ReprocessError> = Effect.fnUntraced(
  function*(record: FailedRecord) {
    const attemptsLeft = remainingAttempts.get(record.id) ?? 0
    if (attemptsLeft > 1) {
      remainingAttempts.set(record.id, attemptsLeft - 1)
      return yield* Effect.fail(new ReprocessError({ recordId: record.id }))
    }
    remainingAttempts.delete(record.id)
    yield* Console.log(`reprocessed ${record.id}`)
  }
)

const markRecordProcessed = (id: string) => Console.log(`marked ${id} processed`)

const markRecordStillFailed = (id: string, _error: ReprocessError) => Console.log(`kept ${id} failed for another pass`)

const reprocessFailedRecord = (record: FailedRecord) =>
  reprocessRecord(record).pipe(
    Effect.andThen(markRecordProcessed(record.id)),
    Effect.catchTag("ReprocessError", (error) => markRecordStillFailed(record.id, error))
  )

const reprocessFailedBatch = Effect.gen(function*() {
  const records = yield* loadFailedRecords

  yield* Effect.forEach(records, reprocessFailedRecord, {
    concurrency: 4
  })
})

const reprocessingCadence = Schedule.spaced("10 millis").pipe(
  Schedule.take(3)
)

const program = Effect.repeat(
  reprocessFailedBatch,
  reprocessingCadence
).pipe(
  Effect.flatMap(() => Console.log("reprocessing job finished")),
  Effect.catch((error) => Console.log(`reprocessing failed: ${String(error)}`))
)

void Effect.runPromise(program)
// Output:
// pass 1: loaded 2 failed records
// reprocessed record-a
// marked record-a processed
// kept record-b failed for another pass
// pass 2: loaded 1 failed records
// reprocessed record-b
// marked record-b processed
// pass 3: loaded 0 failed records
// pass 4: loaded 0 failed records
// reprocessing job finished
```

##### Why spaced

`Schedule.spaced` recurs continuously with the specified duration from the
previous run. In this recipe, the worker does not start the next database scan
until the previous batch has finished and the spacing delay has elapsed.

That behavior is different from `Schedule.fixed`. A fixed schedule targets a
wall-clock interval. If a pass takes longer than the interval, the next pass may
start immediately. That is useful for heartbeats and sampling, but it is often
too aggressive for failed-record repair because slow database work is already a
signal to back off.

##### Idempotency

The record operation must be safe to run more than once. A failed-record table
can contain stale rows, workers can be restarted, and a previous pass can succeed
after writing only part of its bookkeeping. Use stable record identifiers,
idempotency keys, unique constraints, or compare-and-set updates so repeating
`reprocessRecord(record)` does not duplicate external writes.

Keep classification outside the schedule. Permanent failures such as invalid
payloads should be marked as terminal or moved to a dead-letter workflow before
the scheduled repair loop sees them. The schedule controls timing; it should not
be the only thing preventing bad records from being retried forever.

##### Database pressure

The batch size, concurrency, and spacing are one policy. Increasing concurrency
without increasing the spacing can still overload the database because each pass
can issue more reads, writes, locks, and index updates. Start with a small batch
and a conservative concurrency value, then tune from observed queue depth and
database latency.

For a fleet of workers, avoid making every instance wake at the same time. Once
the base cadence is correct, use `Schedule.jittered` to spread reprocessing
passes across the interval. Jitter reduces synchronized scans while preserving
the same reader-facing policy: failed records are retried gradually, not in a
burst.

##### Notes and caveats

`Effect.repeat` feeds successful values into the schedule. In this recipe the
batch effect handles individual record failures and succeeds after recording
their status, so the schedule controls the cadence of completed batch passes.

If a whole batch fails because the database is unavailable, let that failure
escape and use a separate retry policy around the worker startup path. Mixing
record-level repair and infrastructure retry in one schedule makes the database
load profile harder to reason about.

### 30. Product and Business Workflow Recipes

#### 30.1 Poll payment settlement status

Payment settlement is often asynchronous: the provider accepts the payment
first, then moves it through pending, processing, and terminal states. Model
those non-terminal states as successful observations and use a repeat schedule
to decide when another read is worth doing.

##### Problem

You need to poll a provider until settlement reaches a terminal state, but the
caller still needs a bounded answer. `Pending` and `Processing` are not errors;
they are successful responses that mean "poll again after a pause."

##### When to use it

Use this for checkout confirmation, payment reconciliation, and short-lived
API calls where the current request should wait briefly for settlement. The
status endpoint must be safe to call repeatedly.

##### When not to use it

Do not use this to hide provider failures. Authentication errors, invalid
payment ids, malformed requests, and transport failures belong in the error
channel or in a separate retry policy. Do not treat a timeout as a failed
payment; it only means this polling window ended before a terminal status was
seen.

##### Schedule shape

Use `Effect.repeat` because the decision is based on successful statuses. The
schedule keeps the latest status with `Schedule.passthrough`, continues while
the status is open, and also enforces a time budget.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type SettlementStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Processing" }
  | { readonly _tag: "Settled"; readonly settlementId: string }
  | { readonly _tag: "Declined"; readonly reason: string }

const statuses: ReadonlyArray<SettlementStatus> = [
  { _tag: "Pending" },
  { _tag: "Processing" },
  { _tag: "Settled", settlementId: "set_123" }
]

let reads = 0

const fetchSettlementStatus = Effect.gen(function*() {
  const status = statuses[Math.min(reads, statuses.length - 1)]
  reads += 1
  yield* Console.log(`provider status: ${status._tag}`)
  return status
})

const isOpen = (status: SettlementStatus) => status._tag === "Pending" || status._tag === "Processing"

const pollOpenSettlements = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<SettlementStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => isOpen(input)),
  Schedule.bothLeft(
    Schedule.during("100 millis").pipe(
      Schedule.satisfiesInputType<SettlementStatus>()
    )
  )
)

const program = fetchSettlementStatus.pipe(
  Effect.repeat(pollOpenSettlements),
  Effect.flatMap((status) => {
    switch (status._tag) {
      case "Settled":
        return Console.log(`settled as ${status.settlementId}`)
      case "Declined":
        return Console.log(`declined: ${status.reason}`)
      case "Pending":
      case "Processing":
        return Console.log(`timed out while ${status._tag}`)
    }
  })
)

Effect.runPromise(program)
// Output:
// provider status: Pending
// provider status: Processing
// provider status: Settled
// settled as set_123
```

The first read happens immediately. The schedule controls only follow-up reads.
When the terminal `Settled` status appears, the repeat stops and the domain code
decides what to report.

##### Variants

Use a shorter budget for a checkout request and a slower cadence for background
reconciliation. Add `Schedule.jittered` when many payments may start polling at
the same time.

##### Notes and caveats

Keep settlement interpretation outside the schedule. The schedule answers
"should another status read happen?"; the payment workflow decides what
`Settled`, `Declined`, or a still-open timeout means.

#### 30.2 Retry payment-status fetches

Payment systems often separate the mutation that starts a payment from the read
that reports its state. Retrying a safe status read is different from retrying
the payment mutation itself.

##### Problem

You already have a payment id and need to fetch its latest status. The read can
fail because the provider times out, rate-limits briefly, or returns a transient
server error. Retry only those failures, with a bounded policy.

##### When to use it

Use this for safe reads such as `GET /payments/:id/status`. Repeating the read
must not create another charge, capture, refund, or ledger write.

##### When not to use it

Do not apply this policy to `POST /payments`, `POST /captures`, or
`POST /refunds` unless the provider contract gives you idempotency protection.
Do not retry permanent failures such as invalid credentials, malformed payment
ids, unsupported payment methods, or `404` responses for a payment that should
exist.

##### Schedule shape

Use `Effect.retry` because the schedule observes typed failures. Exponential
backoff controls pressure, `Schedule.jittered` avoids synchronized callers,
`Schedule.recurs` bounds retries, and `Schedule.while` filters retryable
failures.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type PaymentStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Captured" }

type PaymentStatusFetchError = {
  readonly _tag: "PaymentStatusFetchError"
  readonly status: number
}

let attempts = 0

const fetchPaymentStatus = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`status fetch attempt ${attempts}`)

  if (attempts === 1) {
    return yield* Effect.fail(
      {
        _tag: "PaymentStatusFetchError",
        status: 503
      } as const
    )
  }
  if (attempts === 2) {
    return yield* Effect.fail(
      {
        _tag: "PaymentStatusFetchError",
        status: 429
      } as const
    )
  }

  return { _tag: "Captured" } as const
})

const isRetryableStatusFetch = (error: PaymentStatusFetchError) =>
  error.status === 408 || error.status === 429 || error.status >= 500

const paymentStatusFetchRetry = Schedule.exponential("10 millis").pipe(
  Schedule.satisfiesInputType<PaymentStatusFetchError>(),
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
  Schedule.while(({ input }) => isRetryableStatusFetch(input)),
  Schedule.tapInput((error) => Console.log(`retryable payment read failure: HTTP ${error.status}`))
)

const program = fetchPaymentStatus.pipe(
  Effect.retry(paymentStatusFetchRetry),
  Effect.flatMap((status) => Console.log(`final status: ${status._tag}`))
)

Effect.runPromise(program)
// Output:
// status fetch attempt 1
// retryable payment read failure: HTTP 503
// status fetch attempt 2
// retryable payment read failure: HTTP 429
// status fetch attempt 3
// final status: Captured
```

The first read runs immediately. Only failures are fed to the retry schedule,
and only retryable status-fetch failures are allowed through the predicate.

##### Variants

Use a smaller budget for a user-facing request. Use a slower base delay for a
background reconciliation worker. Honor provider retry hints such as
`Retry-After` before falling back to local timing.

##### Notes and caveats

This recipe retries failed status fetches. It does not poll successful
`Pending` statuses until they become terminal; that is a repeat recipe over
successful values.

#### 30.3 Poll order fulfillment progress

Fulfillment moves through normal domain states: received, picking, packing,
shipped, delivered, canceled, or failed. Poll those states as successful data,
not as failures.

##### Problem

You need to show recent fulfillment progress without keeping a user request open
forever. The schedule should pause between reads, stop on terminal states, and
return the latest status when the budget ends.

##### When to use it

Use this for order pages, support tools, and checkout follow-up flows where a
short polling window is acceptable and a later push update or refresh can finish
the story.

##### When not to use it

Do not use this as a retry policy for a failing fulfillment endpoint. Add a
separate retry around the read if transport failures are expected. Do not turn
terminal business states into defects just to stop polling.

##### Schedule shape

Use `Schedule.spaced` for the read cadence, `Schedule.passthrough` to keep the
latest status, `Schedule.while` to continue only for non-terminal states, and
`Schedule.during` for the user-facing budget.

##### Example

```ts runnable
import { Console, Effect, Schedule } from "effect"

type FulfillmentStatus =
  | { readonly state: "received"; readonly orderId: string }
  | { readonly state: "picking"; readonly orderId: string }
  | { readonly state: "shipped"; readonly orderId: string }
  | { readonly state: "delivered"; readonly orderId: string }
  | { readonly state: "canceled"; readonly orderId: string }

const statuses: ReadonlyArray<FulfillmentStatus> = [
  { state: "received", orderId: "order-123" },
  { state: "picking", orderId: "order-123" },
  { state: "shipped", orderId: "order-123" },
  { state: "delivered", orderId: "order-123" }
]

let reads = 0

const readFulfillmentStatus = Effect.sync(() => {
  const status = statuses[Math.min(reads, statuses.length - 1)]
  reads += 1
  console.log(`fulfillment status: ${status.state}`)
  return status
})

const isTerminal = (status: FulfillmentStatus) => status.state === "delivered" || status.state === "canceled"

const userFacingPolling = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<FulfillmentStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => !isTerminal(input)),
  Schedule.bothLeft(
    Schedule.during("100 millis").pipe(
      Schedule.satisfiesInputType<FulfillmentStatus>()
    )
  )
)

const program = readFulfillmentStatus.pipe(
  Effect.repeat(userFacingPolling),
  Effect.flatMap((status) =>
    isTerminal(status)
      ? Console.log(`terminal fulfillment state: ${status.state}`)
      : Console.log(`still in progress: ${status.state}`)
  )
)

Effect.runPromise(program)
// Output may vary: elapsed timing can cross the user-facing polling budget boundary differently under load
// fulfillment status: received
// fulfillment status: picking
// fulfillment status: shipped
// fulfillment status: delivered
// terminal fulfillment state: delivered
```

The first status read is immediate. The schedule waits only before follow-up
reads and returns the final observed status.

##### Variants

Shorten the budget for checkout confirmation. Increase spacing for support
dashboards. Add jitter when many open views may poll together.

##### Notes and caveats

`Effect.repeat` feeds successful statuses into the schedule. Keep the mapping
from fulfillment status to UI behavior outside the schedule.

#### 30.4 Retry notification delivery

Notification delivery is externally visible. Retrying an email, SMS, webhook,
or push message is safe only when every attempt carries the same logical
identity and the receiver can deduplicate it.

##### Problem

You need to retry transient delivery failures without sending duplicates. The
retry policy should be bounded, spaced, and tied to a stable idempotency key.

##### When to use it

Use this for background notification workers and webhook dispatchers where the
provider accepts idempotency keys, message ids, or deduplication windows.

##### When not to use it

Do not retry malformed messages, invalid recipients, authorization failures, or
provider rejections that mean the notification will never be accepted. Do not
retry if the downstream system cannot tolerate duplicate delivery.

##### Schedule shape

Use `Effect.retry` because delivery failures drive recurrence. Use a short
exponential backoff, jitter for fleet safety, and a small retry count.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type Notification = {
  readonly idempotencyKey: string
  readonly recipient: string
  readonly body: string
}

type DeliveryError =
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "ProviderUnavailable" }

const notification: Notification = {
  idempotencyKey: "notification-01HZYX8R7P0J9PAW4Q6V7N3QYB",
  recipient: "user@example.com",
  body: "Your export is ready."
}

let attempts = 0

const sendWithIdempotency = (notification: Notification) =>
  Effect.gen(function*() {
    attempts += 1
    yield* Console.log(
      `send attempt ${attempts} with key ${notification.idempotencyKey}`
    )

    if (attempts < 3) {
      return yield* Effect.fail({ _tag: "Timeout" } as const)
    }

    yield* Console.log(`delivered to ${notification.recipient}`)
  })

const retryTransientDelivery = Schedule.exponential("10 millis").pipe(
  Schedule.satisfiesInputType<DeliveryError>(),
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5)),
  Schedule.tapInput((error) => Console.log(`delivery retry after ${error._tag}`))
)

const program = sendWithIdempotency(notification).pipe(
  Effect.retry(retryTransientDelivery)
)

Effect.runPromise(program)
// Output:
// send attempt 1 with key notification-01HZYX8R7P0J9PAW4Q6V7N3QYB
// delivery retry after Timeout
// send attempt 2 with key notification-01HZYX8R7P0J9PAW4Q6V7N3QYB
// delivery retry after Timeout
// send attempt 3 with key notification-01HZYX8R7P0J9PAW4Q6V7N3QYB
// delivered to user@example.com
```

The first attempt happens immediately. The same `idempotencyKey` is used for
every retry, so duplicate suppression can happen outside the schedule.

##### Variants

Use fewer retries for a user-facing request. Use slower spacing for queue
workers under provider throttling. Keep jitter when many workers may retry the
same provider together.

##### Notes and caveats

`Schedule.recurs(5)` means at most five retries after the initial send attempt.
Generate the idempotency key for the logical notification, not for each attempt.

#### 30.5 Repeat CRM sync every few minutes

A CRM sync is a successful background workflow repeated over time. The schedule
should describe the cadence between completed sync passes; the sync itself
should handle idempotent writes and transient request retries internally.

##### Problem

You need to keep CRM data fresh by running a sync every few minutes, but a
hidden loop with sleeps makes spacing, overlap, and shutdown behavior hard to
review.

##### When to use it

Use `Effect.repeat` with `Schedule.spaced` when each sync pass should complete
before the quiet period begins. This fits cursor-based or updated-at-window CRM
integrations.

##### When not to use it

Do not use this as a retry policy for failed CRM requests. `Effect.repeat`
repeats successes and stops on failure. Keep transient retries inside the
single sync pass. Do not rely on scheduling to make writes idempotent.

##### Schedule shape

`Schedule.spaced("5 minutes")` waits after each successful sync before the next
run. The first sync starts immediately.

##### Example

```ts runnable deterministic
import { Console, Effect, Schedule } from "effect"

type SyncSummary = {
  readonly cursor: string
  readonly contactsUpserted: number
  readonly companiesUpserted: number
}

let pass = 0

const syncCrmOnce = Effect.gen(function*() {
  pass += 1
  const summary = {
    cursor: `cursor-${pass}`,
    contactsUpserted: pass * 3,
    companiesUpserted: pass
  }
  yield* Console.log(
    `CRM sync ${pass}: ${summary.contactsUpserted} contacts, ` +
      `${summary.companiesUpserted} companies`
  )
  return summary
})

const demoCadence = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<SyncSummary>(),
  Schedule.passthrough,
  Schedule.take(2)
)

const program = syncCrmOnce.pipe(
  Effect.repeat(demoCadence),
  Effect.flatMap((summary) => Console.log(`last cursor written: ${summary.cursor}`))
)

Effect.runPromise(program)
// Output:
// CRM sync 1: 3 contacts, 1 companies
// CRM sync 2: 6 contacts, 2 companies
// CRM sync 3: 9 contacts, 3 companies
// last cursor written: cursor-3
```

The demo runs the first sync immediately and then two scheduled recurrences. In
production, use the real interval and tie the repeated fiber to service
lifetime.

##### Variants

Use `Schedule.fixed` only when wall-clock alignment matters more than a quiet
gap after completion. Add jitter when many instances run the same sync cadence.

##### Notes and caveats

Avoid overlap outside the local fiber too. If several processes can run the same
CRM sync, use a lease, partition ownership, advisory lock, queue assignment, or
another coordination mechanism.

## Part VIII — Observability and Testing

### 31. Observability, Logging, and Diagnostics

#### 31.1 Log each retry attempt

Retry logs should answer what failed, which policy handled it, and whether
another attempt was scheduled. Logging belongs at the boundary that owns the
retry policy.

##### Problem

You have a retried dependency call and want one clear log event for retry
behavior without duplicating final error reporting.

##### When to use it

Use this around HTTP requests, database calls, queue publishing, cache fills,
and startup probes where retry behavior matters during incident review.

##### When not to use it

Do not log large payloads, credentials, or full causes on every retry. Do not
use logging as a substitute for filtering permanent failures before retrying.

##### Schedule shape

Use `Schedule.tapInput` to observe the failure fed to `Effect.retry`. Use
`Schedule.tapOutput` to log only accepted retry steps.

##### Example

```ts runnable deterministic
import { Console, Duration, Effect, Schedule } from "effect"

type RequestError =
  | { readonly _tag: "RequestTimeout"; readonly endpoint: string }
  | { readonly _tag: "ServiceUnavailable"; readonly endpoint: string }

let attempts = 0

const fetchInventory = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`inventory attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail(
      {
        _tag: "RequestTimeout",
        endpoint: "/inventory"
      } as const
    )
  }

  return ["sku-1", "sku-2"]
})

const retryInventoryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.satisfiesInputType<RequestError>(),
  Schedule.both(Schedule.recurs(5)),
  Schedule.tapInput((error) => Console.log(`retry input: ${error._tag} at ${error.endpoint}`)),
  Schedule.tapOutput(([delay, retry]) =>
    Console.log(
      `retry ${retry + 1} scheduled after ${Duration.format(delay)}`
    )
  )
)

const program = fetchInventory.pipe(
  Effect.retry(retryInventoryPolicy),
  Effect.flatMap((items) => Console.log(`loaded ${items.length} items`))
)

Effect.runPromise(program)
// Output:
// inventory attempt 1
// retry input: RequestTimeout at /inventory
// retry 1 scheduled after 10ms
// inventory attempt 2
// retry input: RequestTimeout at /inventory
// retry 2 scheduled after 20ms
// inventory attempt 3
// loaded 2 items
```

The input log records the typed failure. The output log runs only when the
schedule accepts another recurrence.

##### Variants

For hot paths, log only `tapOutput` so final non-retried failures are not logged
twice. Keep detailed error reporting at the final failure boundary.

##### Notes and caveats

`Schedule.recurs(5)` outputs a zero-based recurrence count, so the log prints
`retry + 1` for a human-facing retry number.

#### 31.2 Log computed delays

Backoff policies are easier to operate when the selected wait is visible. A log
line that only says "retrying" leaves operators guessing whether the next wait
is milliseconds or seconds.

##### Problem

You want retry logs to include the computed delay while keeping the policy
declarative. Do not duplicate the backoff formula in logging code.

##### When to use it

Use this for exponential, fibonacci, capped, or jittered policies where timing
explains caller latency and downstream pressure.

##### When not to use it

Do not log sensitive request or response data just because it is available near
the retry. Keep permanent-error classification separate from delay logging.

##### Schedule shape

For `Schedule.exponential`, the output is the base duration. Log it with
`Schedule.tapOutput`. If later combinators modify the actual delay, log close
to the combinator whose output you want to observe.

##### Example

```ts runnable deterministic
import { Console, Duration, Effect, Schedule } from "effect"

type RetryError = {
  readonly _tag: "Timeout" | "Unavailable"
}

let attempts = 0

const callWebhook = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`webhook attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail({ _tag: "Timeout" } as const)
  }
})

const retryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.satisfiesInputType<RetryError>(),
  Schedule.tapOutput((delay) => Console.log(`base retry delay: ${Duration.format(delay)}`)),
  Schedule.jittered,
  Schedule.take(5)
)

const program = callWebhook.pipe(
  Effect.retry(retryPolicy),
  Effect.flatMap(() => Console.log("webhook delivered"))
)

Effect.runPromise(program)
// Output:
// webhook attempt 1
// base retry delay: 10ms
// webhook attempt 2
// base retry delay: 20ms
// webhook attempt 3
// webhook delivered
```

The example logs the base exponential delay. `Schedule.jittered` changes the
sleep around that base delay, but the log still explains the shape of the
policy.

##### Variants

For a capped policy, log both the base delay and the capped delay at the point
where the cap is applied. For high-volume paths, export the delay as a metric
instead of logging every retry.

##### Notes and caveats

`Schedule.tapOutput` observes outputs and does not change them. With
`Effect.retry`, schedule inputs are failures; with `Effect.repeat`, inputs are
successful values.

#### 31.3 Track total retry duration

Retry count says how many follow-up attempts were scheduled. It does not say
how much time the caller spent inside the retry window.

##### Problem

You need logs or metrics that show total elapsed retry time, not only the next
delay. The elapsed value helps explain user latency and how much of the retry
budget has already been consumed.

##### When to use it

Use this for dependency calls, queue publication, webhook delivery, startup
checks, and background workers where retry latency is part of the service
contract.

##### When not to use it

Do not use `Schedule.elapsed` as the whole policy. It observes elapsed schedule
time; it does not provide spacing or a stopping condition by itself.

##### Schedule shape

Combine the real retry cadence with `Schedule.elapsed`. The cadence still owns
delays and limits; elapsed time is additional output for observability.

##### Example

```ts runnable
import { Console, Duration, Effect, Schedule } from "effect"

type DependencyError = {
  readonly _tag: "DependencyError"
  readonly status: number
}

let attempts = 0

const callDependency = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`dependency attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail(
      {
        _tag: "DependencyError",
        status: 503
      } as const
    )
  }

  return "ok"
})

const isRetryable = (error: DependencyError) => error.status === 408 || error.status === 429 || error.status >= 500

const retryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.satisfiesInputType<DependencyError>(),
  Schedule.both(Schedule.recurs(5)),
  Schedule.bothWith(
    Schedule.elapsed,
    ([nextDelay, retryIndex], elapsed) => ({
      elapsed,
      nextDelay,
      retryIndex
    })
  ),
  Schedule.tapOutput(({ elapsed, nextDelay, retryIndex }) =>
    Console.log(
      `retry=${retryIndex + 1} elapsed=${Duration.toMillis(elapsed)}ms ` +
        `next=${Duration.toMillis(nextDelay)}ms`
    )
  )
)

const program = callDependency.pipe(
  Effect.retry({
    schedule: retryPolicy,
    while: isRetryable
  }),
  Effect.flatMap((value) => Console.log(`dependency result: ${value}`))
)

Effect.runPromise(program)
// Output may vary: measured elapsed time and selected delays depend on runtime timing
// dependency attempt 1
// retry=1 elapsed=0ms next=10ms
// dependency attempt 2
// retry=2 elapsed=11ms next=20ms
// dependency attempt 3
// dependency result: ok
```

The next delay explains immediate pressure on the dependency. The elapsed value
explains how long the retry window has been active.

##### Variants

For user-facing paths, keep the elapsed budget small and the retry count low.
For background work, use a slower base delay and a wider budget, but still log
elapsed retry time separately from the final operation outcome.

##### Notes and caveats

`Schedule.during` and `Schedule.elapsed` are about recurrence windows. They do
not interrupt an already-running attempt; add an Effect timeout around the
operation when each attempt needs a hard deadline.

#### 31.4 Surface termination reasons

Schedules decide whether another recurrence is allowed. They do not invent
business meaning for the final value or failure. Put that interpretation in the
Effect code around the schedule.

##### Problem

Callers and operators need to distinguish success, terminal domain failure,
timeout, fatal read failure, and exhausted retry budget. A schedule gives you
mechanics; your workflow should surface the reason.

##### When to use it

Use this for job polling, provisioning workflows, dependency probes, and remote
API retries where "completed", "failed", "timed out", and "gave up" are
different outcomes.

##### When not to use it

Do not ask `Schedule.during` to throw a timeout error. It simply stops allowing
future recurrences. Do not classify fatal errors as retryable just so the
schedule can see them.

##### Schedule shape

For polling, keep the latest status as output and stop when the status is no
longer running or the budget is exhausted. Then inspect the final value.

##### Example

```ts runnable
import { Console, Effect, Schedule } from "effect"

type JobStatus =
  | { readonly _tag: "Running"; readonly jobId: string }
  | { readonly _tag: "Done"; readonly jobId: string; readonly resultId: string }
  | { readonly _tag: "Failed"; readonly jobId: string; readonly reason: string }

type PollTermination =
  | { readonly _tag: "Completed" }
  | { readonly _tag: "TerminalFailure"; readonly reason: string }
  | { readonly _tag: "TimedOut"; readonly lastStatus: "Running" }

let reads = 0

const checkJobStatus = Effect.sync((): JobStatus => {
  reads += 1
  const status: JobStatus = reads < 4
    ? { _tag: "Running", jobId: "job-1" }
    : { _tag: "Done", jobId: "job-1", resultId: "result-1" }
  console.log(`job status: ${status._tag}`)
  return status
})

const pollUntilTerminalOrBudget = Schedule.spaced("10 millis").pipe(
  Schedule.satisfiesInputType<JobStatus>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input._tag === "Running"),
  Schedule.bothLeft(
    Schedule.during("25 millis").pipe(
      Schedule.satisfiesInputType<JobStatus>()
    )
  )
)

const toTermination = (status: JobStatus): PollTermination => {
  switch (status._tag) {
    case "Done":
      return { _tag: "Completed" }
    case "Failed":
      return { _tag: "TerminalFailure", reason: status.reason }
    case "Running":
      return { _tag: "TimedOut", lastStatus: "Running" }
  }
}

const program = checkJobStatus.pipe(
  Effect.repeat(pollUntilTerminalOrBudget),
  Effect.flatMap((status) => Console.log(`termination reason: ${toTermination(status)._tag}`))
)

Effect.runPromise(program)
// Output may vary: elapsed timing can cross the polling budget boundary differently under load
// job status: Running
// job status: Running
// job status: Running
// job status: Done
// termination reason: Completed
```

The timeout reason comes from interpreting the final `Running` status. It is
not produced directly by `Schedule.during`.

##### Variants

For retry workflows, interpret the final failure from `Effect.retry`: a final
transient error can mean the retry budget was exhausted, while a fatal error
means the retry predicate stopped recurrence immediately.

##### Notes and caveats

Keep retryability or terminal-state information in typed domain data. That
makes the final reason explicit instead of hiding it inside timing policy.

#### 31.5 Measure schedule effectiveness

A retry or polling schedule is useful only when it improves outcomes more than
it increases latency and load. Measure both sides.

##### Problem

You have a retry policy that looks reasonable, but you need evidence that it is
helping. Count scheduled recurrences, record chosen delays, and measure final
outcomes outside the schedule.

Beginner note: Schedule output — schedule metrics explain the recurrence policy.
Keep business success and failure metrics around the effect that uses the
policy.

##### When to use it

Use this when retry or polling affects user latency, infrastructure load,
downstream quotas, incident diagnosis, or operational cost.

##### When not to use it

Do not measure retries as a substitute for classifying errors. Validation,
authorization, malformed requests, and unsafe non-idempotent writes should be
excluded before the schedule is applied.

##### Schedule shape

Use `Schedule.tapInput` for recurrence inputs and `Schedule.tapOutput` for
schedule outputs. Keep operation-level success and failure metrics around the
effect that uses the policy.

##### Example

```ts runnable deterministic
import { Console, Duration, Effect, Metric, Schedule } from "effect"

type InventoryError = {
  readonly _tag: "Timeout" | "Unavailable" | "BadRequest"
}

let attempts = 0

const fetchInventory: Effect.Effect<ReadonlyArray<string>, InventoryError> = Effect.gen(function*() {
  attempts += 1
  yield* Console.log(`inventory attempt ${attempts}`)

  if (attempts < 3) {
    return yield* Effect.fail({ _tag: "Unavailable" } as const)
  }

  return ["sku-1", "sku-2", "sku-3"]
})

const retryScheduled = Metric.counter("inventory_retry_scheduled_total", {
  description: "Retries scheduled by the inventory retry policy"
})

const retryDelayMillis = Metric.histogram("inventory_retry_delay_millis", {
  description: "Base retry delay before jitter",
  boundaries: [10, 20, 50, 100]
})

const inventoryRetryPolicy = Schedule.exponential("10 millis").pipe(
  Schedule.satisfiesInputType<InventoryError>(),
  Schedule.tapOutput((delay) =>
    Effect.gen(function*() {
      yield* Metric.update(retryDelayMillis, Duration.toMillis(delay))
      yield* Console.log(`observed retry delay ${Duration.toMillis(delay)}ms`)
    })
  ),
  Schedule.jittered,
  Schedule.take(5),
  Schedule.tapInput((error) =>
    Effect.gen(function*() {
      yield* Metric.update(retryScheduled, 1)
      yield* Console.log(`scheduled retry after ${error._tag}`)
    })
  )
)

const program = fetchInventory.pipe(
  Effect.retry({
    schedule: inventoryRetryPolicy,
    while: (error) => error._tag !== "BadRequest"
  }),
  Effect.flatMap((items) => Console.log(`inventory loaded after retry: ${items.length} items`))
)

Effect.runPromise(program)
// Output:
// inventory attempt 1
// scheduled retry after Unavailable
// observed retry delay 10ms
// inventory attempt 2
// scheduled retry after Unavailable
// observed retry delay 20ms
// inventory attempt 3
// inventory loaded after retry: 3 items
```

The counter records scheduled retries, not the initial attempt. The histogram
records the base delay before jitter. Final success is measured around the
operation, outside the schedule.

##### Variants

For polling, count scheduled polls, terminal success, terminal timeout, and
elapsed time until the desired state appears. For fleet-wide retries, compare
retry counters with downstream saturation signals such as 429s, 503s, queue
depth, and connection pool usage.

##### Notes and caveats

Measure benefit and cost together. A policy that increases eventual success
while hiding an outage or adding too much latency is not effective.

### 32. Testing Recipes

#### 32.1 Assert retry count

Retry-count tests should count effect evaluations. They should not infer retry
count from elapsed time or from the schedule output.

Beginner note: Recurrence counts — assert the number of effect attempts when you
care about retry count; schedule outputs can be transformed or combined.

##### Problem

`Schedule.recurs(3)` is often misread as "three total attempts". With
`Effect.retry`, the original attempt runs first. The schedule is consulted only
after a typed failure, so three recurrences means three retries after that
original attempt.

##### When to use it

Use this shape when the contract is the retry budget:

- a permanently failing fixture should be evaluated `1 + retries` times
- a transient fixture should stop as soon as it succeeds
- a count-based policy should be tested without relying on real time

##### When not to use it

Do not use a count test to prove delay behavior. Delay tests need clock control.
Also keep jitter out of this test; random delay changes make the timing
contract harder to see and do not affect the retry count.

##### Schedule shape

Use `Schedule.recurs(n)` for a pure retry-count limit. Its output is the
zero-based recurrence count, but for this test the important value is the number
of times the effect itself was evaluated.

##### Example

```ts runnable deterministic
import { Console, Effect, Exit, Ref, Schedule } from "effect"

type TestError = { readonly _tag: "TestError" }
const testError: TestError = { _tag: "TestError" }

const alwaysFails = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`attempt ${attempt}`)
  return yield* Effect.fail(testError)
})

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)

  const exit = yield* alwaysFails(attempts).pipe(
    Effect.retry(Schedule.recurs(3)),
    Effect.exit
  )

  const totalAttempts = yield* Ref.get(attempts)
  yield* Console.log(`total attempts: ${totalAttempts}`)
  yield* Console.log(`failed: ${Exit.isFailure(exit)}`)
})

Effect.runPromise(program)
// Output:
// attempt 1
// attempt 2
// attempt 3
// attempt 4
// total attempts: 4
// failed: true
```

##### Variants

To prove early success, make the fixture fail while the counter is below a
threshold and succeed afterward. With `Schedule.recurs(3)`, a fixture that
succeeds on the third evaluation should leave the counter at `3`, because
`Effect.retry` stops as soon as the effect succeeds.

If the production policy also has spacing or backoff, keep the count assertion
focused on evaluations. The timing policy can be tested separately with
`TestClock`.

##### Notes and caveats

`Effect.retry` feeds failures into the schedule. `Effect.repeat` feeds
successful values into the schedule. The same `Schedule.recurs(3)` value has
different operational meaning in those two contexts because retry recurrences
follow failures, while repeat recurrences follow successes.

#### 32.2 Assert delays between retries

Retry timing is observable behavior. Use `TestClock` to move virtual time
instead of making a test wait on the machine clock.

##### Problem

Counting attempts proves the retry limit, but it does not prove that retries
waited. For a policy with `Schedule.spaced("100 millis")`, check both sides of
the boundary: no retry at 99 milliseconds, then one retry after the remaining
millisecond.

##### When to use it

Use this recipe when immediate retry would change the contract or increase load:
HTTP retries, reconnect loops, startup dependency checks, and background worker
retries are common examples.

##### When not to use it

Do not use a timing test to decide whether an error should be retried. Classify
validation failures, authorization failures, malformed requests, and unsafe
non-idempotent writes before applying the retry policy.

Do not assert exact timestamps for `Schedule.jittered`; jitter intentionally
changes each delay. Assert bounds or test the deterministic policy before jitter
is added.

##### Schedule shape

Combine a deterministic delay with a retry limit. With
`Schedule.spaced("100 millis").pipe(Schedule.both(Schedule.recurs(2)))`, the
original attempt runs immediately. Each failed attempt schedules the next retry
100 milliseconds later, up to two retries.

##### Example

```ts
import { Console, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

const retryPolicy = Schedule.spaced("100 millis").pipe(
  Schedule.both(Schedule.recurs(2))
)

const operation = Effect.fnUntraced(function*(attempts: Ref.Ref<number>) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`attempt ${attempt}`)

  if (attempt < 3) {
    return yield* Effect.fail("transient" as const)
  }

  return "ok" as const
})

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* operation(attempts).pipe(
    Effect.retry(retryPolicy),
    Effect.forkScoped
  )

  yield* Effect.yieldNow
  const afterStart = yield* Ref.get(attempts)
  yield* Console.log(`after start: ${afterStart}`)

  yield* TestClock.adjust("99 millis")
  const beforeDelay = yield* Ref.get(attempts)
  yield* Console.log(`after 99ms: ${beforeDelay}`)

  yield* TestClock.adjust("1 millis")
  const afterFirstDelay = yield* Ref.get(attempts)
  yield* Console.log(`after 100ms: ${afterFirstDelay}`)

  yield* TestClock.adjust("100 millis")
  const result = yield* Fiber.join(fiber)
  const finalAttempts = yield* Ref.get(attempts)

  yield* Console.log(`result: ${result}`)
  yield* Console.log(`total attempts: ${finalAttempts}`)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

The retrying operation runs in a fiber because it sleeps after each failure.
Advancing by 99 milliseconds shows that no retry has started early. Advancing by
the remaining millisecond releases the first sleep. The final adjustment
releases the second retry, which succeeds.

##### Notes and caveats

`Effect.retry` feeds failures into the schedule. It returns the successful value
from the retried effect, or the last failure if the retry policy is exhausted.
The schedule output is useful for composition and observation, but it is not the
result returned by the retrying operation.

`Schedule.spaced` contributes a constant delay between recurrence decisions.
`Schedule.recurs(n)` bounds the number of recurrences, so with retry it permits
`n` retries after the original attempt.

Use `Schedule.delays` when you want to test the delay sequence as schedule data.
Use `TestClock.adjust` when the test runs a real retry loop.

#### 32.3 Simulate transient failures

Transient-failure tests should use a deterministic fixture. Random failure, a
live dependency, or wall-clock waiting makes the retry behavior hard to inspect.

##### Problem

Model the dependency as an effect whose first few evaluations fail and whose
later evaluations may succeed. The tests should cover both sides of the retry
budget: recovery when the failures fit within the schedule, and final failure
when they outlast it.

##### Schedule shape

Use a small deterministic policy such as
`Schedule.spaced("100 millis").pipe(Schedule.both(Schedule.recurs(3)))`.
`Schedule.spaced` adds the delay before each retry. `Schedule.recurs(3)` allows
three retries after the initial attempt. If the effect fails four times in a
row, `Effect.retry` returns the fourth failure.

##### Example

```ts
import { Console, Data, Effect, Fiber, Ref, Schedule } from "effect"
import { TestClock } from "effect/testing"

class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly attempt: number
}> {}

const retryPolicy = Schedule.spaced("100 millis").pipe(
  Schedule.both(Schedule.recurs(3))
)

const flakyRequest = Effect.fnUntraced(function*(
  failuresBeforeSuccess: number,
  attempts: Ref.Ref<number>
) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`attempt ${attempt}`)

  if (attempt <= failuresBeforeSuccess) {
    return yield* Effect.fail(new ServiceUnavailable({ attempt }))
  }

  return "ok" as const
})

const successfulCase = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* flakyRequest(2, attempts).pipe(
    Effect.retry(retryPolicy),
    Effect.forkScoped
  )

  yield* TestClock.adjust("100 millis")
  yield* TestClock.adjust("100 millis")

  const result = yield* Fiber.join(fiber)
  const count = yield* Ref.get(attempts)
  yield* Console.log(`success case: ${result} after ${count} attempts`)
})

const exhaustedCase = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)
  const fiber = yield* flakyRequest(4, attempts).pipe(
    Effect.retry(retryPolicy),
    Effect.flip,
    Effect.forkScoped
  )

  yield* TestClock.adjust("100 millis")
  yield* TestClock.adjust("100 millis")
  yield* TestClock.adjust("100 millis")

  const error = yield* Fiber.join(fiber)
  const count = yield* Ref.get(attempts)
  yield* Console.log(
    `exhausted case: ${error._tag}(${error.attempt}) after ${count} attempts`
  )
})

const program = Effect.gen(function*() {
  yield* Console.log("recovers within budget")
  yield* successfulCase
  yield* Console.log("outlasts retry budget")
  yield* exhaustedCase
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

##### Why this works

The fixture stores its attempt count in a `Ref`, so each call observes and
updates state inside `Effect`. The first run fails twice and succeeds on the
third evaluation. The second run fails four times; the policy allows only three
retries after the initial attempt, so the fourth failure is returned.

##### Notes and caveats

Use `TestClock.adjust` for retry delays in tests. Do not make schedule tests
sleep on wall-clock time. Keep jitter out of this fixture; add a separate test
for jitter bounds if production uses `Schedule.jittered`.

#### 32.4 Verify no retry on fatal errors

Retry tests should prove classification as well as timing. A schedule may allow
several recurrences, but a fatal domain error should bypass the retry loop.

##### Problem

The operation exposes one typed error channel with both transient and fatal
cases. Run a fatal fixture under a policy that would retry transient failures,
then check that the fatal error is returned after one evaluation.

##### When to use it

Use this test when the retry boundary receives classified domain errors such as
`RateLimited`, `Timeout`, `InvalidCredentials`, or `MalformedRequest`.

##### When not to use it

Do not use a schedule predicate as the first place where errors are understood.
Classify errors near the effect that creates them, then let the schedule decide
recurrence for the retryable subset. Defects and interruptions are not typed
failures, so `Effect.retry` does not feed them into the retry schedule.

##### Schedule shape

Use a schedule that would clearly retry if classification allowed it, then add a
classification predicate to the retry options.

```ts runnable deterministic
import { Console, Data, Effect, Ref, Schedule } from "effect"

class TransientError extends Data.TaggedError("TransientError")<{
  readonly message: string
}> {}

class FatalError extends Data.TaggedError("FatalError")<{
  readonly message: string
}> {}

type ServiceError = TransientError | FatalError

const isTransient = (error: ServiceError): error is TransientError => error._tag === "TransientError"

const request = Effect.fnUntraced(function*(
  attempts: Ref.Ref<number>,
  error: ServiceError
) {
  const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
  yield* Console.log(`attempt ${attempt}: ${error._tag}`)
  return yield* Effect.fail(error)
})

const program = Effect.gen(function*() {
  const attempts = yield* Ref.make(0)

  const error = yield* request(
    attempts,
    new FatalError({ message: "invalid credentials" })
  ).pipe(
    Effect.retry({
      schedule: Schedule.recurs(3),
      while: isTransient
    }),
    Effect.flip
  )

  const count = yield* Ref.get(attempts)
  yield* Console.log(`returned: ${error._tag}`)
  yield* Console.log(`total attempts: ${count}`)
})

Effect.runPromise(program)
// Output:
// attempt 1: FatalError
// returned: FatalError
// total attempts: 1
```

##### Why this catches regressions

`Schedule.recurs(3)` would permit up to three retry recurrences after the first
failure. The `while` predicate receives each typed failure before another
attempt is made. Because `FatalError` is not transient, the retry policy stops
immediately.

##### Variants

Use `until` when the predicate reads more naturally as a stop condition, for
example `until: (error) => error._tag === "FatalError"`. Use `Schedule.spaced`,
`Schedule.exponential`, or a production retry policy in the test when you need
to verify that the same classification wraps the real schedule.

##### Notes and caveats

This recipe is about typed domain errors. If an effect dies with a defect or is
interrupted, `Effect.retry` does not feed that cause into the retry schedule.
For typed failures, the schedule input is the failure value, so predicates such
as `while` and `until` can inspect the classified error before the next
recurrence.

#### 32.5 Test capped backoff behavior

Capped backoff tests should prove the delay sequence without depending on the
machine clock.

##### Problem

Given a retry policy that starts with exponential backoff and then stops growing
at a maximum delay, the test should show three facts:

- early retries use the exponential curve
- later retries never wait longer than the cap
- the retry limit still counts retries after the original attempt

A real-time sleep is slow and flaky. Exact assertions after `Schedule.jittered`
are also wrong because jitter intentionally changes each delay.

##### When to use it

Use this recipe when a retry policy has a hard maximum delay and you want a
fast test for the timing contract. It is a good fit for client libraries,
background workers, polling loops, and reconcilers where the cap is part of the
operational guarantee.

##### When not to use it

Do not test capped backoff by waiting for real milliseconds to pass. That makes
the test depend on scheduler load and wall-clock timing.

Do not assert exact delays for a policy after `Schedule.jittered` has been
applied. `Schedule.jittered` randomly adjusts each recurrence delay between 80%
and 120% of the original delay, so exact timestamps are not the contract.

##### Schedule shape

Build the cap with `Schedule.modifyDelay`. `Schedule.exponential` computes each
backoff duration, and `modifyDelay` replaces the next recurrence delay with the
minimum of that duration and the cap. For a base of 100 milliseconds and a cap
of 250 milliseconds, the first five delays are 100, 200, 250, 250, and 250
milliseconds.

##### Example

```ts
import { Console, Duration, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

const cappedBackoff = Schedule.exponential("100 millis").pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, Duration.millis(250)))),
  Schedule.delays,
  Schedule.tapOutput((delay) => Console.log(`scheduled delay: ${Duration.toMillis(delay)}ms`)),
  Schedule.take(5)
)

const program = Effect.gen(function*() {
  const fiber = yield* Effect.void.pipe(
    Effect.repeat(cappedBackoff),
    Effect.forkScoped
  )

  yield* Effect.yieldNow
  yield* TestClock.adjust("2 seconds")
  yield* Fiber.join(fiber)
}).pipe(Effect.provide(TestClock.layer()), Effect.scoped)

Effect.runPromise(program)
```

The program repeats a no-op effect under the schedule, logs the computed delays,
and uses `TestClock` so the two seconds of virtual time pass immediately.

##### Variants

If the production policy is jittered, keep the cap test deterministic and keep
the hard cap after jitter. Test the jittered policy by seeding randomness or by
asserting bounds. Do not combine "capped" and "exact jittered delay" in the same
assertion.

##### Notes and caveats

`Schedule.exponential(base, factor)` computes delays as `base * factor ** n`,
where `n` is the number of recurrences so far. Its output is the current
duration, and the recurrence delay is the same duration.

`Schedule.modifyDelay` changes the delay used before the next recurrence. It
does not change the schedule output. Use `Schedule.delays` when the test should
observe the actual delay after modifiers have been applied.

`Schedule.recurs(n)` allows at most `n` retries when used with `Effect.retry`.
Those retries happen after the original attempt; they are not counted as part of
the first evaluation.

## Part IX — Anti-Patterns

### 33. Retrying Everything

#### 33.1 Retry on validation errors

Retrying validation errors is an anti-pattern because waiting does not change
an invalid request. A missing field, unsupported enum, malformed payload, failed
business rule, or rejected tenant boundary should be returned to the caller.

##### The anti-pattern

The problematic shape is a shared retry policy around an operation whose typed
errors have not been separated. The policy might use exponential backoff, a
retry count, or a time budget, but it runs before the validation failure is
classified as terminal.

That sends validation failures through the same schedule as timeouts, temporary
unavailability, and rate limits. The invalid request is submitted again, delayed
again, logged again, and usually reported later than it should be.

##### Why it happens

It usually happens when retry is added before the error model is settled. A
schedule such as `Schedule.exponential("100 millis")` is easy to reuse, and a
backoff curve can make the retry look careful. But `Schedule.exponential`
describes timing; it does not know whether the failure is retryable, and it is
unbounded unless composed with a limit such as `Schedule.recurs`,
`Schedule.take`, or `Schedule.during`.

The other common cause is placing retry too far outside the failing operation.
If a whole workflow is retried, a validation failure from one step can cause
unrelated steps to run again.

##### Why it is risky

Validation failures should be fast, stable, and actionable. Retrying them turns
a deterministic rejection into delayed operational noise.

A single bad payload can appear as several failing attempts, while the real
issue is still one permanent input problem. If the retried operation contains
writes or external calls, the retry can also duplicate side effects unless the
operation is idempotent, meaning repeated attempts represent the same logical
operation.

Jitter does not fix this. `Schedule.jittered` spreads delay around a schedule's
selected timing; it does not make an invalid request valid or decide whether a
failure belongs in the retry path.

##### A better approach

Classify before retrying. Keep the decision close to the domain boundary that
understands the failure:

- validation, malformed request, authentication, authorization, tenant, and
  business-rule failures should bypass retry and return immediately
- timeouts, connection resets, temporary unavailability, selected rate-limit
  responses, and other explicitly transient failures may enter the retry policy
- unsafe writes need an idempotency or deduplication story before retry is
  considered

After classification, let the schedule do schedule work. Use exponential or
fixed spacing for the delay shape. Add `Schedule.recurs`, `Schedule.take`, or
`Schedule.during` so termination is visible. Add `Schedule.jittered` when many
callers may retry at the same time. Name the policy after the retryable case,
not after a generic operator.

Use `Effect.retry`'s retry predicate at the boundary when the question is
"should this typed failure be retried?" Reserve `Schedule.while` for cases where
the schedule itself must stop based on schedule metadata such as input, output,
attempt, elapsed time, or selected delay.

##### Notes and caveats

A stricter policy may make failures visible sooner. That is the point. The caller
can distinguish "this request is invalid" from "this retryable operation
exhausted its budget", and operations can tell whether the retry policy is
protecting the system or merely delaying a permanent error.

There are rare validation-like failures that are actually consistency problems,
such as a just-created reference not yet visible in another service. Model those
as transient consistency failures, not generic validation errors, and give them a
small, bounded retry policy that documents the assumption.

#### 33.2 Retry on authorization failures

Retrying authorization failures is an anti-pattern because time does not usually
change whether the caller is allowed to perform the operation.

##### The anti-pattern

The problematic version treats `401`, `403`, and other authorization errors as
transient transport failures. A broad retry policy is attached to an HTTP
client, repository, or service boundary, and every failure shape flows through
the same schedule.

The schedule may be bounded and well tuned, but it is attached to the wrong
condition. `Schedule` describes when recurrence may continue; it does not know
that an expired session, missing scope, revoked key, disabled account, or tenant
mismatch needs a different response from a dropped connection.

##### Why it happens

It usually happens when retry is installed before the error model is classified.
Teams create one convenient "network retry" schedule and apply it around calls
that can fail for authentication, authorization, validation, rate limiting, and
infrastructure reasons. The schedule becomes a broad loop instead of a small
operational promise.

Authorization failures are tempting to retry because some are recoverable. An
access token might have expired, a token refresh call might race with another
caller, or a permission cache might be stale. Those are narrow recovery flows.
Model them as credential refresh or authorization-state reload, not as retries
of the protected operation.

##### Why it is risky

Retried authorization failures create noisy security signals. They can look like
credential stuffing, abusive clients, or a broken integration repeatedly hitting
an endpoint with known-bad credentials. Backoff and jitter can reduce
synchronization, but they do not make an unauthorized request safer or more
correct.

They also delay the next useful action. A user may need to sign in again, an
operator may need to grant a scope, a service may need a rotated secret, or the
caller may need a clear forbidden result. Retrying the denied operation makes
that feedback arrive later and can bury the original authorization reason under
an exhausted retry budget.

##### A better approach

Classify authorization failures before scheduling retries. Treat "not
authenticated" and "not authorized" as terminal for the protected operation.
Return or fail with the authorization error directly so the caller can redirect,
request permission, rotate credentials, or stop the workflow.

If the suspected cause is an expired credential, isolate that behavior into a
token refresh flow. The refresh call may have its own small schedule, commonly
bounded with `Schedule.recurs` or `Schedule.take`, and it should retry only
failures that are transient for the refresh endpoint. After a successful
refresh, run the original operation once with the new credentials. If it is
still unauthorized, stop.

Name the schedule after the recovery action, such as "refresh token briefly",
rather than "retry auth failures". The retry is for acquiring valid credentials,
not for repeatedly attempting a forbidden action.

##### Notes and caveats

Some systems have authorization state that is eventually consistent after a
grant or policy update. Even there, avoid a blanket retry on every `401` or
`403`. Use a narrow, bounded wait around the operation that observes
propagation, and make the reason visible in logs and metrics.

Retry the thing that can become true with time. Network availability, refresh
endpoint availability, and policy propagation may qualify. A request made with
invalid, revoked, missing, or insufficient credentials does not.

#### 33.3 Retry on malformed requests

Retrying malformed requests is an anti-pattern because the request is already
structurally wrong. A bad JSON body, invalid content type, missing envelope,
corrupted signature base string, impossible query shape, or unparseable protocol
message will not become well formed because the caller waited.

##### The anti-pattern

The problematic shape treats request parsing and transport recovery as the same
failure path. A client, worker, or gateway wraps the whole operation in a shared
retry policy, so malformed input is submitted repeatedly under the same schedule
used for dropped connections, timeouts, or temporary service unavailability.

The policy may look operationally responsible. It might use
`Schedule.exponential` for backoff, `Schedule.recurs` or `Schedule.take` for a
retry cap, `Schedule.during` for an elapsed budget, and `Schedule.jittered` to
avoid synchronized retries. Those are useful timing tools, but they do not
change the failure classification. A malformed request is still malformed on
every recurrence.

##### Why it happens

It usually happens when retry is installed at a boundary that cannot distinguish
wire, protocol, and domain failures. The schedule is added around an HTTP call,
message handler, or RPC operation before the error model separates
"temporary infrastructure problem" from "the caller sent something this endpoint
cannot interpret."

Malformed requests are also easy to mislabel as transient because they may come
from integration drift. A caller may be on the wrong schema version, a producer
may serialize a field incorrectly, or a proxy may strip a required header. Those
problems are real, but the next retry of the same request carries the same
defect. The fix is to classify the failure and repair the producer, adapter, or
contract.

##### Why it is risky

Retried malformed requests hide the strongest signal you have: the request shape
is invalid at the boundary. Instead of a fast, stable rejection that points to a
contract problem, the system produces delayed failures, repeated logs, inflated
error counts, and unnecessary load on parsers, gateways, queues, and downstream
services.

The retry can also make incident response worse. A burst of malformed messages
may look like a capacity or availability problem because the retry layer
multiplies the number of attempts. Backoff reduces the rate, and jitter spreads
the attempts out, but known-bad input still occupies the system.

For message-driven systems, retrying malformed payloads can poison a queue. The
same unparsable message may cycle until the retry budget is exhausted, delaying
valid work behind it. For request/response systems, retrying may delay the
client feedback that would let the caller correct its serializer, schema, or
headers.

##### A better approach

Reject or divert malformed requests before retry. Treat parser failures,
unsupported content types, missing protocol envelopes, invalid wire formats, and
schema-incompatible payloads as terminal for that request. Return a clear client
error in request/response flows, or route the message to a dead-letter,
quarantine, or diagnostics path in asynchronous flows.

Only after classification should a schedule be selected. Use schedules for
failures that can change with time: a temporarily unavailable
downstream service, a dropped connection, a rate limit response that permits
later retry, or an eventually consistent read. Then bound the recurrence with
operators such as `Schedule.recurs`, `Schedule.take`, or `Schedule.during`, and
use `Schedule.jittered` when many callers might retry at once.

Keep the retry policy named after the retryable condition it serves, such as
"retry transient gateway failures" or "retry rate-limited sends briefly". Avoid
names like "retry malformed requests"; they encode the wrong operational
promise.

##### Notes and caveats

There are cases where a malformed response from another service is caused by a
transient deployment or proxy problem. Classify that separately as a bad
upstream response or temporary protocol mismatch, not as a malformed request from
your caller. Give it a narrow, bounded retry policy only if another attempt might
observe a corrected upstream.

For inbound malformed requests, fail fast. A stricter boundary makes failures
more actionable: the caller sees that the request must be fixed, operators can
measure contract violations directly, and retry budgets remain available for
failures that time can actually resolve.

#### 33.4 Retry non-idempotent side effects blindly

Retrying non-idempotent side effects blindly is an anti-pattern because
`Schedule` controls timing, not replay safety. Non-idempotent means that running
the operation again can create another externally visible effect.

##### The anti-pattern

The problematic version wraps a mutating operation in a broad retry policy
because the failure looks transient or ambiguous. A timeout, dropped connection,
interrupted fiber, or `5xx` response around calls such as "capture payment",
"send receipt email", "submit order", or "create shipment" may mean the
dependency did nothing, or it may mean the dependency committed the side effect
before your service received the acknowledgement.

The schedule may be bounded and well tuned. It may use backoff, jitter,
`Schedule.recurs`, `Schedule.take`, or `Schedule.during`. Those choices can
reduce load and make the retry budget visible, but they do not change the
external semantics of the operation. If each attempt creates a new side effect,
the policy is still unsafe.

This often hides behind tidy infrastructure code. A generic HTTP client, queue
worker, or repository helper accepts a retry schedule and applies it uniformly to
every failure. Safe reads, deduplicated writes, validation errors,
authorization failures, and unsafe writes all start to look like the same
operational problem.

##### Why it happens

It usually happens when recurrence is designed before the domain contract.
`Schedule` is flexible enough to express many retry shapes, so it is tempting to
start with "retry transient failures" and leave replay safety for later.

Non-idempotent effects also fail in uncomfortable ways. After a payment provider
times out, you may not know whether the card was charged. After an email
provider closes the connection, you may not know whether the message was queued.
Retrying feels productive because doing nothing feels like dropping work, but
blind retry can make the final state worse than the original uncertainty.

##### Why it is risky

Duplicate payments are the clearest failure. A customer can be charged twice
when the first attempt succeeded remotely but the acknowledgement was lost
locally. Backoff only changes when the second charge happens.

Duplicate emails are also user-visible. A receipt, invite, password reset, or
notification may be delivered multiple times. Spacing the attempts can reduce
bursts, but it still asks the provider to create another delivery unless the
provider deduplicates by message identity.

Duplicate orders and fulfillment requests can be expensive to unwind. A repeated
create call can allocate a second order number, reserve inventory twice, start
another shipment, or enqueue another warehouse task.

The operational signal becomes harder to read as well. Metrics may show "retry
succeeded" even though the system created two side effects and observed only the
last acknowledgement. The schedule reports recurrence; it does not report
whether the dependency treated repeated attempts as the same logical operation.

##### A better approach

Require an idempotency key or equivalent deduplication mechanism before retrying
a mutating side effect. The key should identify the logical operation, not the
individual attempt. Every retry of "charge this invoice", "send this
notification", or "create this order" should carry the same stable key so the
downstream system can return the original result or reject the duplicate.

Classify failures before applying the schedule. Retry only the cases where
another attempt is both useful and replay-safe: temporary unavailability, rate
limiting, connection resets, or ambiguous transport failures for an operation
protected by idempotency. Do not retry malformed requests, failed validation,
forbidden access, declined payments, unsubscribed recipients, or business-rule
rejections.

Keep the retry policy narrow and named after the operation it protects. A policy
such as "retry idempotent payment capture briefly" communicates more than a
generic "remote API retry". Combine backoff or spacing with explicit limits such
as `Schedule.recurs`, `Schedule.take`, or `Schedule.during`, and add jitter when
many callers may retry the same dependency.

When the dependency cannot deduplicate, choose a different recovery path. Record
the uncertain outcome, reconcile through provider status APIs, use an outbox
with a uniqueness constraint, require operator review, or return a clear pending
state to the caller.

##### Notes and caveats

Idempotency has to be end-to-end. A stable key in your request is not enough if
an intermediate service drops it, generates a fresh one per attempt, or
deduplicates for a shorter window than your retry and reconciliation workflow
requires.

Some operations are naturally idempotent because they set a resource to a known
state or use a deterministic identifier. Others can be made idempotent with
request keys, unique constraints, compare-and-set updates, outbox records, or
provider-specific client tokens. If neither is true, treat retries as a product
and operations decision, not as a schedule choice.

Use `Schedule` to control recurrence only after the domain has made recurrence
safe. Backoff, spacing, jitter, and retry limits are load-shaping tools. They are
not a substitute for idempotency.

#### 33.5 Retry without error classification

Retrying without error classification is an anti-pattern because it asks a
timing policy to make a domain decision.

##### The anti-pattern

The problematic version starts with a shared retry policy before the error model
is understood. A client, worker, repository, or service helper wraps an
operation in a broad schedule because some failures are retryable. The same
policy then handles timeouts, rate limits, validation errors, authorization
failures, malformed requests, declined payments, duplicate-key errors, and
invariant violations.

The schedule may look responsible. It might use exponential backoff, fixed
spacing, a recurrence cap, an elapsed-time budget, and jitter. Those controls
shape retry traffic, but they do not classify the error. A bounded retry of a
permanent failure is still a delayed permanent failure.

This is easy to miss when the schedule is hidden in infrastructure code. A
helper named "retry remote calls" can retry every typed failure from a remote
call, even though only a small subset represent temporary infrastructure
conditions.

##### Why it happens

It usually happens when recurrence is designed before the failure taxonomy. A
taxonomy is the small set of categories you use to decide what an error means.
`Schedule` is convenient and composable, so it is tempting to choose a reusable
policy before answering the more important question: which failures may safely
be attempted again?

It also happens when the retry boundary is too far from the code that
understands the domain. A low-level HTTP wrapper can see that the call failed,
but it may not know whether the failure means "the network dropped", "the token
is revoked", "the payload violates the schema", "the account is disabled", or
"the provider may already have committed the side effect".

Metric pressure can reinforce the mistake. Retrying can make a flaky operation
appear healthier because a later attempt succeeds. That is useful for genuine
transient failures. It is misleading when retry hides a permanent caller bug, a
configuration problem, or a fatal state transition.

##### Why it is risky

Permanent failures consume retry budgets, queue capacity, connection slots,
logs, and downstream quota even though another attempt cannot make the request
valid. Backoff and jitter reduce synchronization, but they still spend capacity
on work that should have failed fast.

Feedback is delayed. A caller that sent invalid input should learn that
immediately. A service using revoked credentials should surface an authorization
failure. A deployment with missing configuration should fail in a way operators
can recognize. A retry schedule can bury those signals under an exhausted retry
budget.

Some failures occur after the request has left your process. If a payment
capture, order creation, message send, or external write times out, the remote
side may already have committed the action. Retrying without first classifying
the outcome and checking idempotency can duplicate work outside the process.
`Schedule` can delay and limit those attempts; it cannot make them replay-safe.

Fatal failures are not "permanent but harmless". They often mean the workflow
has lost an invariant, observed corrupted state, or reached an ambiguous
external state that requires reconciliation. Treating those failures like
transient unavailability can continue a workflow after it should stop.

##### A better approach

Classify failures before retrying. Keep the classification close to the boundary
that understands the operation, and make the categories explicit enough to
review:

- transient: retryable because time may change the result
- permanent: not retryable for this request because the request or caller must
  change
- fatal: not retryable in this workflow because continuing may be unsafe or
  misleading

Only the transient category should reach the retry schedule. The schedule then
answers a smaller question: given that this failure is retryable, how should
recurrence proceed? Use schedule operators for timing and termination, such as
recurrence limits, elapsed budgets, backoff, spacing, and jitter. Do not use
them as a substitute for deciding whether the failure belongs in the retry path.

Return permanent failures directly. They are useful information, not retry
candidates. Route fatal or ambiguous failures to the recovery path that
preserves correctness: reconciliation, dead-letter handling, operator
intervention, idempotency lookup, status polling, or a pending state. Those paths
may use their own schedules, but only after the failure has been reclassified
into a specific recovery action.

Name the policy after the classified condition it protects, such as "retry
transient object-storage reads briefly" or "retry rate-limited status fetches
within the caller budget". Avoid names like "generic retry" or "retry all
downstream errors"; they hide the decision that matters most.

##### Notes and caveats

Classification does not have to be elaborate, but it has to happen before retry.
A small predicate or tagged error model is usually enough to separate retryable
transport and availability failures from request, authorization, configuration,
business, and fatal workflow failures.

Some errors change category after context is added. A timeout on an idempotent
status read may be transient. A timeout after submitting a non-idempotent write
may be ambiguous or fatal until the system reconciles the external state. The
same low-level symptom can require different retry behavior depending on the
operation.

Use `Schedule` after the operation has proven that another attempt is meaningful
and safe. Classification decides whether retrying is allowed. The schedule
decides when retrying happens and when the retry budget is exhausted.

### 34. Retrying Forever

#### 34.1 Missing retry limits

##### The anti-pattern

A retry policy describes when another attempt may happen but never says when
to stop. The delay shape can look reasonable: exponential backoff, fixed
spacing, or a shared "retry transient errors" schedule. The problem is that
timing is not a budget.

If the effect never succeeds, the schedule can keep producing retry decisions
for the lifetime of the fiber. That turns a temporary recovery mechanism into
an open-ended workload.

##### Why it happens

The code answers "how long should we wait between failures?" before it answers
"how many failures are acceptable?" Delay is easy to tune locally; termination
requires understanding the caller, the dependency, and the side effect.

This also appears when one shared policy is reused across operations with
different risk profiles. A safe read, an idempotent write, and a non-idempotent
side effect should not inherit the same retry lifetime.

##### Why it is risky

Unbounded retries convert one failure into continuing operational load. A down
dependency receives more traffic while it is least able to handle it. A
malformed request, expired credential, or authorization failure is repeated even
though another attempt cannot make it valid.

Unsafe side effects are worse. If a remote service completed the work but failed
before returning success, an unbounded retry can perform the operation more than
once.

The caller also loses a timely exhausted-retry error. During an incident, these
background retries can consume connection pools, queue slots, rate-limit budget,
and log volume that operators need for recovery.

##### A better approach

Put the stopping rule in the policy. Use `Schedule.recurs(n)` when the contract
is a maximum number of retries; with `Effect.retry`, the original attempt runs
first and `Schedule.recurs(3)` permits at most three retries after it.

When the useful part is the delay shape, keep it and cap it with
`Schedule.take(n)`. This works for schedules such as `Schedule.exponential`,
`Schedule.spaced`, or `Schedule.fixed`, which otherwise continue to produce
recurrence decisions.

When the contract is elapsed time, use `Schedule.during(duration)`. It continues
only while the schedule's elapsed recurrence window remains within the supplied
duration. Startup checks and short dependency recovery windows usually need
this kind of time budget.

Name policies after both cadence and limit: `retryHttp503ThreeTimes`,
`retryTokenRefreshForTenSeconds`, or `retryUploadWithCappedBackoff`. A name like
`exponentialRetry` describes the curve but hides the operational promise.

##### Notes and caveats

An attempt limit is not error classification. Validation errors, authorization
failures, malformed requests, and known fatal responses should usually fail
without retrying at all.

Count limits and time limits answer different questions. `Schedule.recurs` and
`Schedule.take` bound recurrence count; `Schedule.during` bounds elapsed
schedule time. Production policies often need both.

#### 34.2 Missing time budgets

##### The anti-pattern

A retry policy has a delay curve and a retry count, but no elapsed budget. It
looks bounded because the number of retries is finite. It is still open-ended in
the dimension the caller often cares about: total time.

The caller pays for every delay plus every failed attempt. If each attempt can
run near its own timeout, or if a fixed delay later becomes exponential, a small
retry count can still exceed the useful window for a request, lease, startup
path, or recovery workflow.

Retry counts are useful. The mistake is treating a count as a time budget when
the operation has a deadline.

##### Why it happens

Attempt counts are easy to review. "Retry five times" looks concrete, while
"stay within two seconds" requires thinking about caller ownership, failure
latency, and how long the result remains useful.

It also comes from mixing up different guards:

- a delay cap limits one pause before the next recurrence
- `Schedule.recurs(n)` limits scheduled retries after the original attempt
- `Schedule.take(n)` limits schedule outputs
- `Schedule.during(duration)` limits the schedule's elapsed recurrence window
- a timeout around the effect limits an individual in-flight attempt

They protect different things. Replacing one with another changes the contract.

##### Why it is risky

Attempt counts do not compose cleanly with variable latency. Five fast failures
may be acceptable for an interactive caller. Five slow failures may hold a
request, worker, lock, connection, or startup path long after useful work is no
longer possible.

Counts also age badly as the schedule evolves. A later change from fixed spacing
to exponential backoff, a higher per-attempt timeout, or a larger delay cap can
multiply total elapsed time while the visible count stays the same.

Missing time budgets create retry tails: long, low-visibility periods where work
is still waiting, resources are still held, and fallback paths are delayed.

##### A better approach

Keep the attempt count when it is useful, but add an elapsed budget whenever the
caller owns a maximum retry window. In Schedule terms, compose the cadence with
`Schedule.during(duration)` using `Schedule.both`. The cadence decides when
another retry may happen. The `during` side decides whether the elapsed schedule
window is still open. Because `Schedule.both` continues only while both
schedules continue, retrying stops when either guard is exhausted.

Prefer names that state the promise: `retryPaymentLookupForTwoSeconds`,
`startupConfigRetryBudget`, or `webhookDeliveryRetryWindow` communicate more
than `retryPolicy`.

Use an attempt count to prevent excessive work inside the budget. Use an elapsed
budget to protect the caller from waiting too long. Use a per-attempt timeout
when one attempt needs its own maximum duration. These are complementary guards,
not alternatives.

##### Notes and caveats

`Schedule.during` is evaluated at schedule decision points. It does not
interrupt an attempt that is already running, and it is not a replacement for a
timeout around the effect itself.

With `Effect.retry`, the first attempt runs immediately. `Schedule.recurs(n)`
allows up to `n` retries after that original attempt, not `n` total executions.
If the operation succeeds, the retry schedule is no longer consulted.

Elapsed budgets make failure earlier and clearer. That is the point: callers can
fall back, return a timely error, enqueue background work, or release resources
instead of waiting through a retry tail.

#### 34.3 Unbounded backoff chains

##### The anti-pattern

An unbounded backoff schedule is used as the whole retry policy. A policy based
on `Schedule.exponential("200 millis")` looks conservative because each attempt
waits longer than the last. In `Schedule`, `exponential` always recurs. By
itself it has no maximum attempt count, no elapsed budget, and no maximum single
delay.

Backoff changes pressure; it does not create a recovery contract. After enough
attempts the next sleep may be minutes or hours away, but the work is still
pending and may retry after the caller, job, or incident process expected a
decision.

##### Why it happens

It happens when "back off" is treated as "bound the retry." Exponential growth
reduces pressure on a dependency, but it does not decide when the original
operation has failed.

A shared backoff can also leak across workflows. A queue reconnect loop, a
user-facing request, a startup probe, and a control-plane mutation may all need
backoff, but they should not inherit the same lifetime.

##### Why it is risky

The long tail is the main risk. Early attempts are visible and close together;
later attempts are far apart. A failing job can look quiet even though it is
still scheduled to act. Ownership becomes ambiguous: the caller may have moved
on, the worker may still hold state, and the next retry may run after the
surrounding context is stale.

A very large next wait can also look like a stuck process. If the operation
eventually retries, it may run after credentials, leases, idempotency windows,
request deadlines, or deployment assumptions have changed. For unsafe side
effects, a late retry can be worse than a clear failure.

Backoff does not eliminate fleet load. Many callers using the same unbounded
policy can accumulate delayed work. Without jitter, similar failures can retry
together. Without a deadline, the backlog can persist through recovery.

##### A better approach

Treat backoff as cadence, not limit. Start with the retryable case, then add
explicit bounds that match the workflow:

- use `Schedule.recurs` when the contract is a maximum number of retries
- use `Schedule.during` when the contract is a wall-clock retry budget
- use `Schedule.modifyDelay` with `Duration.min` when each sleep needs a maximum cap
- use `Schedule.jittered` when many fibers or processes may run the same policy together

An exponential cadence is appropriate for temporary overload. A production
policy also says when to stop and how long any single sleep may become. That
gives the caller an exhausted-retry outcome instead of leaving the operation in
a distant future.

Prefer names that include the bound, such as "retry inventory reads for up to
twenty seconds" or "reconnect with ten capped backoff attempts." A name like
`exponentialRetry` describes the curve but not the promise.

##### Notes and caveats

Caps and deadlines solve different problems. A delay cap prevents one
recurrence from sleeping too long. A deadline or recurrence limit decides when
the retry as a whole is over. Most production policies need both.

Use schedule combinators deliberately. `Schedule.both` uses intersection
semantics: it continues only while both schedules continue and uses the maximum
delay. That is usually what you want when combining cadence with a limit.
`Schedule.either` uses union semantics and can accidentally preserve an
unbounded tail.

A bounded policy may surface failures sooner. That is expected when the old
behavior only delayed a decision. If a workflow truly needs indefinite
background recovery, make it visible with ownership, cancellation,
observability, jitter where appropriate, and a bounded per-attempt delay.

#### 34.4 Operationally invisible infinite retries

##### The anti-pattern

A retry schedule is treated as a private implementation detail. The effect
fails, retries, and nothing outside the fiber can tell whether this is attempt
two or attempt two thousand. The caller sees latency or eventual failure.
Operators see downstream symptoms: repeated API calls, elevated queue age,
extra database reads, or a job that never completes.

This often appears as a tidy shared policy such as unbounded
`Schedule.exponential("200 millis")` or `Schedule.spaced("1 second")`. Those
schedules are real tools. The policy is incomplete when it has no retry budget,
no elapsed time budget, no classification of retryable failures, and no signal
for each retry attempt.

##### Why it happens

The schedule is chosen before the operation has an operational contract. The
code decides to retry a transient failure, then postpones the harder questions:
which errors are transient, how long the caller may wait, whether the side
effect is idempotent, and what signal should be emitted on each recurrence.

`Schedule` makes recurrence compositional, so an unbounded policy is easy to
pass to `Effect.retry`. That composability is useful, but the absence of a bound
is still a policy. If no one combines the schedule with `Schedule.recurs`,
`Schedule.take`, `Schedule.during`, or another stopping condition, the retry can
continue as long as the fiber is alive.

##### Why it is risky

Invisible retries hide both product failures and infrastructure failures. A
malformed request remains malformed. A revoked credential will not become valid
through backoff. A non-idempotent write can duplicate work outside the process.
A downstream outage can be amplified by every caller running the same loop.

The risk is worse during incidents. If retry attempts are not counted, logs lack
attempt numbers and causes, and metrics do not expose retry volume, the team
cannot distinguish a few slow operations from many permanently failing ones.
Without elapsed-time or attempt limits, retry traffic may continue after the
business deadline has passed.

Backoff can also create false confidence. `Schedule.exponential` and
`Schedule.fibonacci` reduce retry pressure over time, but they do not make the
retry finite. `Schedule.jittered` spreads callers out, but it does not provide a
budget. Delay is not observability, and it is not termination.

##### A better approach

Make the retry contract explicit before choosing the cadence. Classify failures
first, retry only cases that are expected to recover, and give the policy a
count budget, a time budget, or both. Combine the delay policy with a stopping
policy such as `Schedule.recurs`, `Schedule.take`, or `Schedule.during`. When
many callers may retry at the same time, add `Schedule.jittered`, but keep the
limits visible.

Make each recurrence observable. `Schedule.tapInput` can record the failure that
caused a retry. `Schedule.tapOutput` can record schedule output, such as delay
or recurrence count. Where elapsed time matters, use a time-limited policy or
compose with `Schedule.elapsed` so logs and metrics can answer how many attempts
happened, why they happened, how long the operation has been retrying, and when
the policy stopped.

Prefer metrics with stable dimensions over ad hoc log volume. Useful signals
include retry attempts by operation and error class, retry exhaustion counts,
elapsed retry duration, selected-delay histograms, and the number of fibers
currently waiting to retry. Logs should carry operation name, classified error,
attempt number, elapsed time, and the final exhaustion event.

Name retry policies after their operational promise:
`retryHttp503ForThirtySeconds`, `retryConnectionResetFiveTimes`, or
`pollUntilReadyWithinStartupBudget` is clearer than `defaultRetrySchedule`.

##### Notes and caveats

Some systems deliberately retry forever, such as long-lived background workers
or supervisors. That is acceptable only when the retry is visible and externally
controllable: structured logs, metrics, alerting, backoff, jitter where
appropriate, and a documented shutdown or cancellation path.

Do not use infinite retry to hide a request-scoped failure from a caller that
needs a timely answer. A bounded retry may surface errors sooner; that is the
point when work has left its useful window.

#### 34.5 Background loops with no escape hatch

##### The anti-pattern

A recurring effect is started in the background and the schedule is treated as
the whole lifecycle policy:

- repeat every few seconds forever
- retry reconnects forever
- poll until success, but with no timeout
- log failures and continue indefinitely
- fork the loop and never retain, supervise, or interrupt the fiber

`Schedule.forever` and unbounded `Schedule.spaced` are valid timing tools. The
anti-pattern is using them without deciding who owns the loop, when it stops,
how it is interrupted, how failures are bounded, and how operators can tell
whether it is making progress.

This often appears as a fire-and-forget maintenance loop: refresh a cache, renew
a lease, publish metrics, scan a queue, reconcile state, or reconnect a client.
It works in local testing because the process is short lived. In production, the
same loop can outlive request cancellation, deployment drains, lost leadership,
disabled tenants, expired credentials, or a downstream outage.

##### Why it happens

Recurrence is designed before ownership. A schedule is a small value, so it is
easy to attach `Effect.repeat` or `Effect.retry` to an operation and move on.
The code reads as intentional because the delay is named, but the lifecycle is
not.

Another cause is confusing "runs forever" with "is managed forever".
Schedules describe recurrence. They do not decide that a loop should outlive a
request, survive a scope closing, ignore shutdown, or keep running after its
business purpose has disappeared.

The problem is worse when retry and repeat are mixed together. A background
poller may repeat forever, and each iteration may retry forever on failure. That
creates nested unbounded recurrence: the outer loop never ends, and the inner
failure path has no budget.

##### Why it is risky

The risk is not just CPU. A loop without interruption can keep resources alive
after their owner is gone: connections, subscriptions, queue leases, cache
handles, tenant state, and fibers. If it performs external work, it can keep
sending requests after the feature was disabled or the caller timed out.

An unbounded loop also hides failure. If every error is logged and the loop
continues, the system may look available while doing no useful work. If failures
are retried forever, the final error never reaches a caller and the only visible
symptom may be delayed shutdown, growing logs, repeated downstream traffic, or a
slow increase in background fibers.

Budgets make the loop's cost reviewable. Without a budget, it can spend
unlimited time reconnecting, refreshing, polling, or reconciling. Without
concurrency and queue limits, it can accumulate more work than the system can
drain. Without observability, operators cannot distinguish healthy idle work
from a stuck loop repeating the same failure.

##### A better approach

Design the loop as a managed process, then choose the schedule. Give every
background loop a lifecycle owner and make interruption part of the design. If
the loop belongs to a request, tenant, lease, subscription, or service scope, it
should stop when that owner stops. If it is process-level infrastructure, it
should participate in shutdown and expose enough state to be supervised.

Add explicit recurrence limits where failure is possible. Use count limits such
as `Schedule.recurs` or `Schedule.take` when an operation only deserves a fixed
number of retries or repeats. Use time budgets such as `Schedule.during` when
the operation may wait for a condition but should not wait forever. Use
`Schedule.while` when schedule metadata such as attempt, input, output, or
selected delay decides whether another recurrence is allowed.

Keep the forever part narrow. It can be reasonable for an outer service loop to
repeat for the lifetime of the service, but inner recovery loops should still
have budgets. A cache refresher may run for the service lifetime while one
refresh attempt has a small retry policy. A reconnecting client may be owned by
a scope while each connection attempt has bounded backoff. A poller may run for
an active subscription while each poll has a timeout and terminal state
handling.

Make observability part of the schedule boundary. `Schedule.tapInput` and
`Schedule.tapOutput` are useful places to record retry inputs, recurrence counts,
selected delays, and other schedule outputs. Metrics and logs should answer at
least these questions: how many loops are running, when did each last make
progress, how many consecutive failures has it seen, what delay is it using, and
which owner or tenant is responsible for it.

##### Notes and caveats

A loop that is intended to run for the whole process lifetime can still use an
unbounded schedule. The requirement is not "never use `Schedule.forever`". The
requirement is that forever has an owner, an interruption path, bounded failure
handling inside the loop, and production signals that show whether it is doing
useful work.

Do not rely on jitter as the escape hatch. `Schedule.jittered` spreads recurrence
delays, which helps when many instances might synchronize, but it does not stop
a loop, cap its work, or report that it is unhealthy. Jitter is load shaping,
not lifecycle, budget, or observability.

### 35. Polling and Jitter Mistakes

#### 35.1 Poll every 100ms without need

##### The anti-pattern

A fixed 100 millisecond cadence is chosen before the code asks how quickly the
answer can change or how expensive each check is. The schedule reads like a
small detail, but `Schedule.spaced("100 millis")` keeps recurring until another
condition stops it.

A batch job that finishes in minutes, an eventually consistent index, a mostly
empty queue, or a rate-limited status endpoint rarely benefits from ten checks
per second. One loop looks small. Ten loops already mean roughly one hundred
checks per second; across services, tenants, browser tabs, or worker fibers, the
extra polls mostly rediscover the same state.

##### Why it happens

Responsiveness becomes the only scheduling goal. A 100 millisecond interval
feels fast and is easy to remember, so it gets copied into polling code even
when no user is waiting, no service-level objective depends on that latency, and
the observed value cannot change that quickly.

Local testing also biases toward tight intervals. Short polling makes demos and
manual verification feel snappy. If that value reaches production unchanged,
the schedule documents impatience rather than operational intent.

##### Why it is risky

The direct cost is load. Every recurrence wakes a fiber, runs the effect, and
usually touches another subsystem. If the poll performs network I/O, storage
I/O, logging, tracing, or metrics, the system pays those costs even when nothing
changed.

The indirect cost is worse during incidents. When a dependency slows down,
aggressive polling adds more concurrent requests to the dependency that is
already struggling. When many callers share the same fixed interval, their
checks can align and produce bursts. When the loop is unbounded, the load keeps
going until interruption, success, or an explicit stopping rule ends it.

Fast polling can also hide a missing domain signal. If the right design is an
event, callback, subscription, queue, or "try once and come back later" flow, a
100 millisecond loop makes the absence of that signal look acceptable while
charging the system continuously.

##### A better approach

Choose the interval from the domain first. Ask how quickly the observed value
can realistically change, who is waiting for it, what each check costs, and what
the maximum acceptable polling budget is. If the answer is "nobody needs this in
100 milliseconds", start with seconds, not milliseconds.

For steady polling, prefer a wider `Schedule.spaced` interval that matches the
freshness requirement. For recovery or readiness checks, prefer a backoff shape
such as `Schedule.exponential` or `Schedule.fibonacci` so repeated misses become
less frequent. For any policy that is not meant to run forever, add an explicit
bound with `Schedule.take`, `Schedule.recurs`, or `Schedule.during`.

When many processes may poll the same dependency, add jitter after the base
cadence is correct so the fleet does not check in lockstep. Jitter is not a
license to keep an interval too small; it only spreads otherwise reasonable
traffic.

##### Notes and caveats

There are valid 100 millisecond schedules. They belong near cheap local
coordination, short-lived startup readiness, tests, and bounded user-facing
waits where that latency is part of the requirement. Even then, make the stop
condition visible.

`Schedule.spaced("100 millis")` controls the delay between recurrences; it does
not make the work cheap, cancel stale demand, or limit the total number of
checks. If the loop is meant to protect a dependency, the schedule should show
that protection through wider spacing, backoff, jitter, and a clear bound.

#### 35.2 Poll large fleets in sync

##### The anti-pattern

Every instance gets the same repeat schedule and starts from the same lifecycle
event: deploy, boot, leader change, cache flush, or incident recovery. A plain
fixed or spaced interval reads as "poll every 30 seconds." Across a fleet it can
mean "ask the same dependency at once."

This is easy to miss with background polling. One worker polling every few
seconds is usually fine. The load shape appears when many identical processes
run the same policy and thousands of workers turn a status endpoint, queue
broker, database, or control plane into the bottleneck even though average
request rate looks acceptable.

##### Why it happens

The schedule is designed for one process instead of the fleet.
`Schedule.spaced("30 seconds")` waits after each successful poll completes
before the next one. `Schedule.fixed("30 seconds")` maintains a constant
interval, and if work takes longer than the interval the next run can happen
immediately rather than piling up missed runs. Both are useful; neither spreads
identical clients by itself.

Deployments make the synchronization worse. If every worker starts around the
same time, the first poll aligns. If the work duration is similar, the following
polls can stay aligned. A dependency outage can also re-synchronize clients when
they all begin polling again after the same recovery signal.

##### Why it is risky

The risk is burst load, not just total load. A backend sized for a steady 10,000
requests per minute may still fail if most of those requests arrive in a narrow
window every minute. Synchronized polling can create noisy metrics, queue depth
oscillation, periodic database contention, rate-limit bursts, and incident
feedback loops where every client checks more aggressively at the worst time.

It also hides the cause. Operators may see a slow poll endpoint or a database
spike every 30 seconds without an obvious offender because no single instance is
violating its local schedule.

##### A better approach

Design the polling policy as a fleet policy. Choose the base cadence from the
freshness requirement and the downstream cost, then add spreading when many
instances may run it. In Effect, `Schedule.jittered` keeps the same general
cadence while randomly adjusting each computed delay between 80% and 120% of the
original delay.

Use jitter for runtime polling loops where exact wall-clock alignment is not a
requirement. Keep it visible in the schedule rather than hiding randomness in
the poll effect, so the operational contract remains reviewable: the cadence
states how often the work should happen, and jitter states that the fleet should
not wake up in lockstep.

If the dependency needs tighter protection, combine jitter with a slower
cadence, a concurrency limit, caching, server-side push, or a poll response that
tells clients when to check again. Jitter smooths synchronization; it does not
make an expensive polling design cheap.

##### Notes and caveats

Do not add jitter where precise cadence is the point of the workflow. Heartbeats,
billing boundaries, time-bucketed aggregation, and protocol-level leases may
need explicit timing semantics. For those cases, reduce fleet pressure with
partitioning, ownership, or a separate coordination mechanism instead of random
delay.

Jitter is also not a retry limit or a backpressure mechanism. If the poll loop
can run forever, decide whether that is intentional and document the cost. If the
loop is only useful during a window, pair the cadence with an explicit limit such
as a count or elapsed-time budget.

#### 35.3 Poll when a push-based model would be better

##### The anti-pattern

Polling is used as the default integration shape. A worker asks a remote API for
status every few seconds. A dashboard refreshes a large query on a fixed
cadence. A service repeatedly scans a table to discover new work. A fleet of
consumers checks for "anything changed?" even though the upstream system could
send a webhook, publish an event, expose a subscription, or enqueue work when
state changes.

The schedule may look careful. It might use `Schedule.spaced` for a predictable
delay, `Schedule.fixed` for a wall-clock cadence, `Schedule.jittered` to avoid
fleet synchronization, or `Schedule.take` / `Schedule.recurs` to avoid running
forever. Those are useful controls for legitimate polling. They do not change
the fact that every poll is still a speculative read. `Schedule` can make the
loop slower, bounded, jittered, or easier to review; it cannot turn repeated
guessing into an event-driven design.

##### Why it happens

Polling is easy to add locally. The consumer can ship without asking the
producer for a new contract, provisioning a queue, validating webhook
signatures, or designing event delivery semantics. `Schedule` then makes the
loop look intentional because the cadence is explicit and composable.

That convenience can hide the architectural question: who has the information
first? If the producer observes the change, the producer is usually the better
place to emit the signal. The consumer's schedule is only guessing at the right
time to look.

##### Why it is risky

The risk is not only extra requests. Polling creates a freshness-versus-load
tradeoff that push-based systems often avoid. A faster cadence reduces stale
reads but increases API traffic, database scans, cache churn, rate-limit
pressure, log volume, and cost. A slower cadence protects dependencies but makes
users and downstream workflows wait for changes the system already knows about.

Polling also fails poorly at scale. During deploys, outages, or incident
recovery, many consumers can resume the same polling loop at once. Jitter can
smooth that pattern, but it cannot remove the repeated work. Backoff can protect
a dependency during failure, but it also makes change detection slower. A count
or time budget can stop the loop, but it may stop before the change arrives.
These are symptoms of using a timer where a message would describe the real
business event.

##### A better approach

Choose the communication model before choosing the schedule. If another system
owns the state transition, prefer a push contract: webhooks for cross-service or
third-party notifications, an event stream for durable state changes, a queue
for work that must be claimed and processed, or a subscription/channel when the
client needs live updates. Those designs move the recurrence problem out of the
consumer and into delivery, acknowledgement, replay, deduplication, and
backpressure mechanisms that are built for change notification.

Use `Schedule` when polling is genuinely the right boundary: a remote service
only exposes a status endpoint, the operation is short-lived and user-scoped, a
legacy dependency cannot emit events, or the poll is a safety net for missed
signals. In those cases, make the compromise explicit. Pick a cadence from the
freshness requirement and downstream cost, add jitter when many clients may run
the same loop, and add a visible termination condition with `Schedule.take`,
`Schedule.recurs`, or `Schedule.during` when the loop should not live forever.

When polling is only a fallback, document that in the schedule name and metrics.
The primary path should be the webhook, event, queue, or subscription; the
scheduled loop should repair gaps rather than define normal operation.

##### Notes and caveats

Push-based systems are not free. Webhooks need authentication, idempotency,
retry handling, and dead-letter visibility. Event streams and queues need
retention, consumer ownership, replay strategy, and operational tooling. Those
costs are real, but they match the problem of delivering changes. A polling
schedule mostly controls how often the consumer asks a question.

Keep polling when the producer cannot push, when eventual freshness is enough,
or when periodic reconciliation is deliberately part of the reliability model.
Do not use a nicer `Schedule` to avoid fixing an integration contract that
should be event-driven.

#### 35.4 Adding jitter where precise cadence matters

Jitter is for spreading load, not for preserving precision. Avoid it when the
schedule's cadence is part of a protocol, measurement, lease, or user-facing
promise.

##### Anti-pattern

A deterministic cadence, such as `Schedule.fixed`, `Schedule.spaced`, or
predictable backoff, is piped through `Schedule.jittered` because jitter sounds
safer in production.

That changes the policy. `Schedule.jittered` randomly adjusts each computed
delay to a value between `80%` and `120%` of the original delay. A five-second
cadence becomes a bounded range around five seconds, not an exact interval.

The mistake often hides in shared helpers: a "production schedule" adds jitter
to retries, pollers, heartbeats, refreshes, and maintenance tasks. It may reduce
synchronized bursts for some workloads, but it also injects timing variance into
workloads whose correctness depends on predictable recurrence.

##### Why it happens

Jitter is associated with resilience because it helps clustered systems avoid
herd effects, where many callers hit the same dependency at the same time. That
benefit is real, but it is a fleet-level load decision, not a default property
of every schedule.

`Schedule` values document recurrence. For fixed heartbeats, user-visible
polling intervals, sampling loops, lease renewals, and virtual-time tests, the
absence of jitter is part of the contract.

##### Why it is risky

Jitter can violate external contracts. Protocol heartbeats, lock refreshes,
timeout probes, and lease renewals often rely on a specific margin. A delay that
is 20% later than the base delay may be fine for retry traffic, but wrong for a
renewal loop sized around a fixed deadline.

It can also weaken observability. Sampling, load tests, diagnostic probes, and
periodic reports often rely on deterministic spacing so measurements remain
comparable. Jitter can make a graph look smoother while making the data less
faithful to the question being measured.

The variance can become visible to users too. If the interface says "refreshing
every 5 seconds", a jittered schedule no longer implements that exact promise.
Tests become less precise for the same reason: deterministic schedules can use
exact virtual-time advancement, while jittered schedules need range assertions
and controlled randomness.

##### A better approach

Choose the schedule shape that states the timing requirement and leave it
unjittered when precision matters. Use `Schedule.fixed` when work should align
to a fixed interval. Use `Schedule.spaced` when each run should wait a stable
gap after the previous run. Use deterministic `Schedule.exponential` when the
retry curve should be predictable. Add `Schedule.recurs`, `Schedule.take`, or
`Schedule.during` for explicit bounds.

Reserve `Schedule.jittered` for cases where synchronized callers are the bigger
problem than exact per-caller timing: many service instances retrying the same
dependency, many clients polling the same resource, or many workers waking after
a shared outage. In those cases, the `80%` to `120%` range is the feature.

Name schedules after the behavior they promise. A name like
`leaseRenewalCadence` should make jitter look suspicious. A name like
`jitteredReconnectBackoff` makes the tradeoff explicit.

##### Caveats

Jitter changes only the delay chosen for the next recurrence. It does not add a
retry limit, make an unsafe operation safe, classify errors, or enforce a rate
cap. If a precise schedule overloads a dependency, first check cadence,
concurrency, and admission control. Jitter may still help a coordinated fleet,
but it should not blur a timing contract the program depends on.

#### 35.5 Using jitter to mask a deeper overload problem

Jitter can smooth synchronized recurrence, but it cannot decide whether the
system should accept more work. Random timing is not capacity control.

##### Anti-pattern

Synchronized load appears, and jitter becomes the main fix. A hot endpoint is
retried by many callers, a poller hammers a downstream service, or a batch job
fans out more work than the dependency can accept. `Schedule.jittered` shifts
each delay within its `80%` to `120%` band, so a spike becomes a wider plateau.

That graph can look better while the overload remains. If callers still retry
too many times, pollers still have no terminal condition, or workers still admit
unbounded concurrency, the system is still asking the dependency to do more than
it can handle.

##### Why it happens

Jitter is cheap to add and often produces an immediate visual improvement. A
jittered exponential backoff reads as more production-ready than the same
backoff without jitter, so it is tempting to stop there.

The missing question is whether the system should be doing the work at all.
Jitter changes when the next recurrence happens. It does not classify
non-retryable failures, cap retry budgets, bound concurrency, queue work behind
backpressure, reject excess demand, or enforce a shared rate limit.

##### Why it is risky

Randomized overload is still overload. During a partial outage, jitter can keep
steady pressure on a dependency that needs room to recover. The system may avoid
sharp retry waves while still consuming connection pools, worker slots, request
budgets, and operator attention.

It also hides the real contract from the code. A reader sees a jittered schedule
and may assume the retry or polling policy is operationally safe. If the schedule
has no recurrence limit, no elapsed budget, no input classification, and no
coordination with admission control, the safety is only cosmetic.

Jitter can make telemetry harder to interpret as well. The failure is no longer
a clean synchronized spike; it is smeared across time. That can delay the more
important fix: reducing admitted demand, preserving capacity for healthy work,
or making callers fail fast when the system is already saturated.

##### A better approach

Treat jitter as the last timing refinement on top of an already bounded policy.
First decide which work is allowed to recur, how many times it may recur, how
long the recurrence window may stay open, and what should happen when the system
is saturated.

Use schedule operators for the recurrence contract. `Schedule.recurs(n)` or
`Schedule.take(n)` makes a count budget visible. `Schedule.during(duration)`
makes the elapsed recurrence window visible. `Schedule.both` can combine cadence
with a count or time budget so recurrence continues only while both schedules
continue. Add `Schedule.jittered` only when many callers may otherwise align on
the same delay boundaries.

Use the right non-schedule mechanism for overload control. Bound concurrency for
work that consumes scarce worker or connection capacity. Use queues or streams
with backpressure when producers must slow down behind consumers. Use rate
limiting or admission control when excess demand should wait, be rejected, or
receive a clear retry-after signal. Use load shedding when preserving service
health matters more than accepting every request.

The schedule should then describe retry or polling behavior, not carry the full
burden of system protection. A good policy might be jittered, but it is safe
because it is narrow, bounded, and coordinated with capacity controls.

##### Caveats

Do not remove jitter from a fleet-wide retry policy just because it is not a
capacity fix. Jitter is still useful for avoiding synchronized recurrence and is
often the correct addition to exponential or spaced delays.

The caveat is ownership. If the system is overloaded, the owner of the policy
must decide what demand is admitted, queued, slowed, or rejected. Jitter can make
that decision less noisy; it cannot make the decision for you.

## Part X — Choosing the Right Recipe

### 36. Recipe Selection Guide

#### 36.1 “I need to retry a flaky call”

Use this entry when an operation may succeed if tried again, but only under a
bounded, explicit retry policy.

##### What this section is about

Start with the call shape, not the combinator:

- A very short local race, such as a warm cache, leader election handoff, or just-created resource, usually wants a small constant delay.
- A remote dependency that may be overloaded usually wants backoff.
- A call made by many fibers, processes, or nodes usually wants jitter.
- A user-facing call usually wants a short attempt or elapsed-time budget.
- A write with side effects must be idempotent, deduplicated, or not retried blindly.

Select the recipe from those facts. Do not begin with the most expressive
schedule and tune it down after the fact.

##### Why it matters

Retry policy is part of the load placed on the dependency. A policy that is harmless for one request can become an outage amplifier when many callers fail at the same time. The important production questions are:

- How soon is another attempt useful?
- How many attempts can the caller justify?
- How long may the workflow remain invisible to the user or caller?
- Would repeating the call duplicate a side effect?
- Will many callers retry on the same schedule?

##### Core idea

Choose the smallest schedule that describes the operational promise:

- Use `Schedule.spaced` when each retry should wait a fixed duration after the previous attempt completes.
- Use `Schedule.fixed` only when retries must align to interval boundaries. If work runs longer than the interval, the next run happens immediately and missed intervals do not pile up.
- Use `Schedule.exponential` when repeated failures should wait progressively longer. It starts at the base delay and multiplies by the factor on each recurrence, defaulting to `2`.
- Use `Schedule.jittered` when many callers may retry together. It adjusts each delay between `80%` and `120%` of the computed delay.
- Use `Schedule.recurs` or `Schedule.take` to bound retry decisions.
- Use `Schedule.during` to bound total elapsed schedule time.
- Use `Schedule.both` when two constraints must both hold, such as backoff and a maximum retry count. The combined schedule continues only while both sides continue and uses the larger delay.

For most flaky remote calls, the default selection is exponential backoff, jitter, and a small retry limit. Use plain fixed spacing only when the failure is known to clear quickly and the dependency can tolerate the repeated load.

##### Practical guidance

Use fixed delay when the call is cheap, the expected recovery window is short, and retrying does not increase pressure on an already stressed dependency. Examples include a local service startup race or a read-after-create consistency gap where a few attempts are enough.

Use backoff when failure may mean the dependency is slow, saturated, restarting, rate limiting, or temporarily unavailable. Backoff gives the dependency more room after each failure. Prefer a conservative base delay for external systems, then cap the behavior with a retry count or elapsed budget.

Add jitter when retries can synchronize. This includes HTTP clients in a fleet, background workers reading the same queue, scheduled jobs, or anything triggered by a shared deploy, outage, or clock boundary. Jitter is especially important with backoff because identical callers otherwise keep retrying in waves.

Always add a limit unless the retry belongs to a deliberately supervised
background loop. For request-response work, the limit is usually a small retry
count, an elapsed-time budget, or both. Count limits make worst-case attempts
obvious; elapsed limits make caller-visible waiting time obvious.

Check side effects before retrying writes. Retrying a `GET` or a status fetch is usually different from retrying a charge, email send, file mutation, or external workflow transition. For writes, require idempotency keys, deduplication, or a separate recovery design before selecting a retry schedule.

If the policy cannot be explained in one sentence, split the decision:
classify retryable errors, choose the delay shape, add jitter if callers can
synchronize, then add limits so the final behavior is bounded and reviewable.

#### 36.2 “I need to poll until something finishes”

Use this recipe family when each repeat is a fresh observation of external
state, such as a job status endpoint, import pipeline, payment settlement, or
deployment rollout.

The schedule should answer three questions before code is written:

- How often may this process be observed?
- Which observed states stop polling?
- What budget prevents waiting forever?

##### What this section is about

Polling is not retrying a failed call. A retry schedule reacts to failures. A
polling schedule usually repeats successful reads until the read result says the
remote process is finished, failed, canceled, expired, or no longer worth
watching.

Choose a polling recipe when the repeated operation is a status check, not the
original work request. Submit the work once. Then repeat the observation effect
with a cadence and stop condition that match the downstream system.

##### Why it matters

Unbounded polling creates load and hides stuck workflows. Overly aggressive
polling can turn a harmless status page into a rate-limit problem. Overly slow
polling makes users wait after the remote work has completed.

A good polling policy is explicit about cadence, terminal states, and the
maximum time or attempts the caller is prepared to spend.

##### Core idea

Start with a steady cadence unless the remote system asks for something else.

Use `Schedule.spaced(duration)` when every poll should wait for `duration` after
the previous status check completes. This is usually the safest default for
status endpoints because slow checks naturally reduce the polling rate.

Use `Schedule.fixed(duration)` when the observation should align to a regular interval. According to `Schedule.fixed`, if the action takes longer than the interval, the next run happens immediately, but missed runs do not pile up. That is useful for clock-like monitoring, but it can be too aggressive for ordinary job-status polling.

Use `Schedule.exponential(base)` when early results are likely to be unready and
later polls should back off. This fits long-running external workflows better
than a fast constant loop.

Add a hard budget with `Schedule.during(duration)`, `Schedule.recurs(times)`, or
`Schedule.take(n)`. The repeated effect should stop when it sees a terminal
state; the schedule should stop when the budget is exhausted. `Schedule.during`
is natural for user-facing timeouts. `Schedule.recurs` or `Schedule.take` is
useful when the downstream service documents an attempt limit.

Add `Schedule.jittered` when many fibers, processes, or hosts may start polling at the same time. In `Schedule`, jitter adjusts delays to a random value between 80% and 120% of the original delay, which helps avoid synchronized bursts.

##### Practical guidance

Classify the states first. A polling loop needs at least three categories:

- Continue: states such as `queued`, `running`, `pending`, or `processing`.
- Success: states such as `completed`, `succeeded`, or `available`.
- Failure: states such as `failed`, `canceled`, `expired`, `rejected`, or `not_found` when disappearance is terminal for this workflow.

Do not let the schedule be the only stop condition. The repeated effect should
interpret terminal states and stop with the appropriate success or failure. The
schedule controls when another observation is allowed; the domain result
controls whether another observation is meaningful.

Prefer `Schedule.spaced` for most polling. It gives the remote service breathing room because the delay starts after the status call finishes. Prefer `Schedule.fixed` only when the polling contract is truly interval-based.

Budget user-facing polling in wall-clock time, not just count. A policy such as
"poll every second for up to 30 seconds" is easier to defend than "try 30
times" when each status call can have variable latency. For background
workflows, combine elapsed and count budgets when both service cost and total
wait matter.

Escalate the cadence instead of polling forever. A common shape is quick initial polling for a short period, followed by slower polling, or a transition to a background notification path. Use `Schedule.andThen` when the policy has distinct phases.

Select a different recipe when the repeated action is not a status check:

- If the original request failed and should be attempted again, use the flaky-call retry recipe.
- If the process should run forever as service maintenance, use the periodic background loop recipe.
- If the main concern is protecting a dependency from aggregate pressure, use the overload recipe.
- If the question is only how to cap an existing schedule, use the reasonable-limit recipe.

#### 36.3 “I need a periodic background loop”

Choose this path for successful background work that should run again and again:
health checks, cache refreshes, local metric flushes, maintenance sweeps,
reconciliation passes, or heartbeats.

##### What this section is about

Before writing the worker, answer these questions:

- Should the loop wait after each completed run, or try to stay aligned to a
  regular cadence?
- Is the loop allowed to run for the whole process lifetime, or should it stop
  after a count, a window, or a domain condition?
- What happens when the loop is interrupted during sleep or during the work
  itself?
- How will operators see that it is running, falling behind, or stopping?

##### Why it matters

Background loops are easy to make unbounded by accident. `Schedule.spaced` and
`Schedule.fixed` both recur continuously unless a stopping rule or owning
lifecycle interrupts the repeated effect.

That is often exactly what a service worker needs, but the choice should be
visible. The schedule should tell a reader whether the loop is quiet between
runs, whether it catches up after slow work, which limits apply, and where
observability is attached.

##### Core idea

Start with the cadence.

Use `Schedule.spaced(duration)` when the requirement is "wait this long after a
successful run completes." This is the default for most background loops because
slow work naturally pushes the next start later. A cache refresh that takes
three seconds and repeats with `Schedule.spaced("30 seconds")` starts the next
refresh about thirty seconds after the previous refresh completes.

Use `Schedule.fixed(duration)` when the requirement is "stay on this interval."
`fixed` keeps a regular interval and, if the action takes longer than the
interval, the next run happens immediately without building a backlog of missed
runs. That fits probes or ticks where cadence alignment matters more than quiet
time after completion.

Then decide whether the loop is truly lifetime-bound. If it is not, add a
limit:

- Use `Schedule.recurs(n)` when the policy is "allow at most n scheduled
  recurrences after the first run."
- Use `Schedule.take(n)` when you are limiting the outputs taken from another
  schedule.
- Use `Schedule.during(duration)` when the loop should continue only during an
  elapsed schedule window.

Combine an interval and a limit only when both rules are real requirements. A
bounded maintenance loop might run every thirty seconds until twenty
recurrences or fifteen minutes have been spent. A process-lifetime heartbeat may
deliberately have no schedule limit, but then cancellation must come from the
owning fiber, scope, or supervisor.

##### Practical guidance

Pick `spaced` unless you can explain why fixed cadence matters. `spaced` is
usually easier to reason about because each run completes before the quiet
period begins. Pick `fixed` for clock-like periodic work, and remember that it
does not launch concurrent catch-up executions by itself.

Keep failure handling separate from periodic repetition. `Effect.repeat` uses a
schedule after successful iterations. If a flush, poll, or refresh should retry
on failure, put a short retry policy around that one iteration, then repeat the
recovered operation on the background cadence.

Add jitter when many instances run the same loop against shared infrastructure.
For periodic loops, jitter normally belongs on the repeat schedule so ordinary
successful traffic is spread out. Keep the base interval understandable first;
then apply `Schedule.jittered` to reduce synchronized wakeups.

Make cancellation an explicit ownership decision. A `Schedule` decides whether
and when the next recurrence should happen; it is not the worker's lifecycle.
Run long-lived loops in a scope, fiber set, layer, or supervisor that can
interrupt them during shutdown. If the loop has a natural end, express that in
the schedule or in the repeated effect's result instead of relying on process
exit.

Attach observability to the schedule when the recurrence policy is what you
need to see. `Schedule.tapOutput` can record recurrence counts or delay outputs.
`Schedule.tapInput` observes the values supplied to the schedule: successful
values for repeats and failures for retries. For predicate-based decisions,
`Schedule.while` receives metadata such as attempt, elapsed time, output, and
computed duration.

Prefer a small named schedule over inline composition. Names such as
`refreshEveryMinute`, `boundedStartupWarmup`, or `jitteredMetricsFlush` make the
operational promise visible at the call site.

The common selections are:

- Periodic worker with quiet time after each run: `Schedule.spaced`.
- Clock-like tick that should keep a regular interval: `Schedule.fixed`.
- Temporary maintenance loop: `spaced` or `fixed` plus `recurs`, `take`, or
  `during`.
- Fleet-wide periodic export or refresh: base cadence plus `jittered`.
- Lifetime worker: unbounded cadence plus explicit fiber or scope ownership.

#### 36.4 “I need to avoid overload”

Avoiding overload is a selection problem before it is a scheduling problem:
choose recurrence that keeps aggregate traffic within what the dependency can
absorb.

##### What this section is about

Use this entry when the main risk is extra pressure on a shared resource:
database reconnects, HTTP retries against a struggling service, queue
redelivery, webhook delivery, cache refreshes, background polling, or
maintenance workers.

The useful question is: "what is the maximum load this policy can add while
things are already unhealthy?" Answer that before choosing the combinators.

##### Why it matters

Retry and repeat policies can multiply traffic. A single fast retry loop may be
harmless in isolation, but many clients running the same loop can synchronize
into a large burst. A background worker that polls too quickly can compete with
foreground traffic. A retry policy without a budget can keep a dependency hot
long after the original work stopped being useful.

`Schedule` makes the recurrence policy visible, but visibility only helps when
the chosen shape matches the operational risk.

##### Core idea

Start conservative and add pressure only when you can justify it.

| Need                               | Prefer                                     | Why                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep a steady gap between attempts | `Schedule.spaced`                          | It waits the configured duration after each recurrence. This is usually safer than a tight loop for polling, workers, and maintenance tasks.                               |
| Run on interval boundaries         | `Schedule.fixed`                           | It aligns to a regular interval and does not pile up missed runs. If work runs behind, the next delay can become zero, so it is not the default overload-avoidance choice. |
| Slow down after repeated failure   | `Schedule.exponential`                     | It starts at the base duration and grows by the factor, defaulting to `2`. It does not stop by itself.                                                                     |
| Build a custom increasing delay    | `Schedule.unfold` plus `Schedule.addDelay` | Use this when the delay curve is domain-specific and should be named or explained.                                                                                         |
| Desynchronize many clients         | `Schedule.jittered`                        | It adjusts each delay between 80% and 120% of the computed delay.                                                                                                          |
| Limit the number of recurrences    | `Schedule.recurs` or `Schedule.take`       | Use count limits when every additional recurrence adds meaningful load or cost.                                                                                            |
| Limit total elapsed time           | `Schedule.during`                          | Use time budgets when the work stops being useful after a deadline.                                                                                                        |
| Require multiple guardrails        | `Schedule.both`                            | It continues only while both schedules continue and uses the larger delay. This is the usual way to combine backoff with count and time limits.                            |

##### Practical guidance

Choose the schedule by the overload mechanism.

If the problem is a tight loop, add spacing first. `Schedule.spaced` is the
plainest answer when every recurrence should leave breathing room after the
previous run. Prefer it for worker loops, polling, refreshes, and maintenance
jobs where steadiness matters more than immediate recovery.

If the problem is retry pressure against an unhealthy dependency, use backoff.
`Schedule.exponential` is the standard starting point because later failures
become less aggressive. Pick a base delay that would still be acceptable if
every caller used it at the same time.

If the problem is synchronized clients, add jitter. `Schedule.jittered` changes
the delay range, not the stop condition. Apply it to spread retries across the
fleet, then decide whether a strict maximum delay is required.

If the problem is unbounded tail behavior, cap and budget the policy. Use a
maximum delay, typically with `Schedule.modifyDelay`, when operators need to
know the longest single wait. Use `Schedule.recurs` or `Schedule.take` when the
number of extra attempts matters. Use `Schedule.during` when total elapsed time
matters more than exact count.

If the problem is mixed failure modes, classify before retrying. Timeouts,
temporary unavailability, and rate-limit responses may deserve conservative
retry. Validation errors, authorization failures, permanent configuration
errors, and unsafe non-idempotent side effects usually should not enter the
retry schedule at all.

##### Selection checklist

Before choosing the recipe, answer these questions:

- What shared resource is protected: a service, database, queue, provider quota,
  CPU pool, or user-facing path?
- Is the operation safe to retry, or does it need idempotency first?
- Should the first retry be delayed, or is one quick retry acceptable?
- Should later attempts become slower with `Schedule.exponential`?
- Will many clients run the same policy, requiring `Schedule.jittered`?
- What is the largest acceptable single delay after jitter and any cap?
- What is the maximum number of extra attempts?
- What is the maximum elapsed budget?
- Which error or result classes must stop immediately?

##### Common selections

For a fragile downstream service, choose exponential backoff, jitter, a maximum
delay, a retry count, an elapsed budget, and a retryable-error classifier. This
is the safest general-purpose overload shape.

For low-risk background polling, choose `Schedule.spaced` with a count or
elapsed budget if the work should eventually stop. Add jitter only when many
instances poll the same dependency.

For provider quotas or rate limits, choose slower spacing or backoff and treat
rate-limit responses as their own class. Do not handle them like ordinary
network glitches if the provider is explicitly asking the client to slow down.

For user-facing workflows, keep the budget short. Avoid making a person wait
through a background-worker retry policy. Prefer a small number of attempts and
a clear failure path over long invisible retrying.

For fleet-wide recovery after an incident, favor larger base delays, jitter, and
strict limits. The aggregate behavior matters more than one process recovering
as quickly as possible.

##### Notes and caveats

`Schedule.exponential`, `Schedule.spaced`, `Schedule.fixed`, and
`Schedule.jittered` do not impose a useful operational limit by themselves.
Pair them with `Schedule.recurs`, `Schedule.take`, `Schedule.during`, or an
input-aware stop condition.

`Schedule.jittered` in Effect uses an 80%-120% range. If the maximum delay must
be strict, cap after jitter with `Schedule.modifyDelay` instead of assuming the
base backoff cap remains exact.

`Schedule.both` has intersection semantics: it continues only while both sides
continue and chooses the larger delay. That is usually what overload protection
wants. A composition that continues while either side continues can extend
traffic longer than intended.

Client-side scheduling reduces retry pressure, but it is not a replacement for
server-side rate limits, queues, backpressure, circuit breakers, or load
shedding.

#### 36.5 “I need to stop after a reasonable limit”

Use this entry when a retry, repeat, poll, or background loop needs a clear
stopping boundary.

##### What this section is about

This entry is about selecting the first guardrail, not tuning the delay curve.
Ask what makes the next recurrence unreasonable:

- Too many attempts: use `Schedule.recurs`.
- Too many outputs from an existing schedule: use `Schedule.take`.
- Too much elapsed time: use `Schedule.during`.
- A schedule output says the work has reached a boundary: use an output predicate with `Schedule.while`.

That decision should be made before adding backoff, spacing, jitter, or logging.

##### Why it matters

An unbounded schedule is easy to write and hard to defend. A retry that can
continue forever can hide a failing dependency. A poller without a time budget
can make a user-facing workflow hang. A background loop without a count, time,
or output boundary can turn a temporary condition into persistent load.

Reasonable limits also make reviews easier. The reader should be able to tell
whether the policy stops because it exhausted attempts, exceeded a wall-clock
budget, consumed enough outputs, or observed a domain-specific output.

##### Core idea

Use the limit that matches the thing you are protecting.

Use `Schedule.recurs` when the policy is "try again up to this many times." In
`Schedule.ts`, `recurs(times)` can only be stepped the specified number of times
before it terminates, and it outputs the recurrence count. This is the clearest
choice for retry ceilings such as "at most three retries."

Use `Schedule.take` when you already have a schedule shape and want to cap how
many outputs it may produce. This is usually the right fit for limiting
`Schedule.spaced`, `Schedule.fixed`, `Schedule.exponential`,
`Schedule.fibonacci`, or another composed schedule without changing its cadence
semantics.

Use `Schedule.during` when the defensible boundary is elapsed time.
`during(duration)` recurs only while elapsed duration remains within the
supplied duration. It is the right primitive for "retry for up to 30 seconds",
"poll during startup", or "keep sampling during a short diagnostic window."

Use an output predicate when the schedule output carries the boundary. The
exported predicate combinator is `Schedule.while`, whose predicate receives
metadata including `output`, `attempt`, `elapsed`, and `duration`. Reach for
this when the output has meaning, such as a counter, accumulated value,
state-machine state, or measured delay, and stopping depends on that value
rather than on a fixed count or clock budget.

##### Practical guidance

Prefer one primary stop condition and add a second only when it protects a
different failure mode. A retry policy might use increasing delays and still cap
attempts with `Schedule.recurs`; a poller might use cadence plus
`Schedule.during` so it cannot wait forever.

Do not treat `Schedule.recurs` and `Schedule.take` as interchangeable names for
the same idea. `recurs` is itself the count-based schedule. `take` limits
another schedule after you have chosen its cadence or output behavior.

When the limit is operational, make it visible in the recipe name or surrounding
code: attempts, outputs, elapsed time, or output predicate. If nobody can say
which one stopped the schedule, the policy is too hard to operate.

### 37. Decision Matrix by Problem Shape

#### 37.1 Transient failure vs permanent failure

Use this entry when the first decision is whether a failure should be retried at
all. Delay choice comes after classification.

`Schedule` describes recurrence; it does not decide which domain errors are
retryable. In `Effect.retry`, the typed failure is the schedule input, so keep
classification close to the retry policy. A transient failure may succeed later
without changing the request. A permanent failure will not be repaired by
waiting.

##### Decision matrix

| Failure shape                                                                                           | Retry choice                                                 | Schedule shape                                                                                                                        | Why                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Temporary network interruption, timeout, connection reset, stale leader, or overloaded dependency       | Retry                                                        | `Schedule.exponential` plus `Schedule.recurs` or `Schedule.during`; add `Schedule.jittered` when many clients may retry together      | The request may succeed after the dependency recovers. Increasing delay avoids turning a temporary problem into a retry storm.                              |
| Rate limit or explicit "try again later" response                                                       | Retry, but slow down                                         | Prefer a delay derived from the response when available; otherwise use bounded `Schedule.exponential`, often with `Schedule.jittered` | The downstream service is telling the caller to reduce pressure. A tight fixed retry ignores that signal.                                                   |
| Conflict, lock contention, compare-and-set race, or eventually consistent read                          | Retry briefly                                                | `Schedule.spaced` or a small `Schedule.exponential`, bounded by `Schedule.recurs` or `Schedule.during`                                | The retry is local to a race window. Keep it small so real logical conflicts surface quickly.                                                               |
| Validation error, malformed input, missing required data, unsupported operation, or invariant violation | Do not retry                                                 | No retry schedule, or stop with `Schedule.while` when a shared schedule handles mixed errors                                          | Waiting cannot repair the request. Retrying only delays the useful error.                                                                                   |
| Authentication or authorization failure                                                                 | Usually do not retry                                         | No retry schedule unless the workflow includes an explicit credential refresh step before retrying                                    | A schedule alone cannot make invalid credentials valid. Classify refreshed credentials separately from permanent denial.                                    |
| Not found                                                                                               | Depends on the domain                                        | Retry only when the object is expected to appear; otherwise fail immediately                                                          | "Not found" can mean eventual consistency, delayed provisioning, or a wrong identifier. The schedule follows the domain meaning, not the status code alone. |
| Unknown or mixed failure                                                                                | Retry conservatively only if the operation is safe to repeat | A small `Schedule.recurs` or short `Schedule.during` budget, often with `Schedule.exponential`                                        | Ambiguous errors should not receive an unbounded policy. Use the smallest retry budget you can defend operationally.                                        |

##### How classification changes the schedule

For transient failures, the schedule answers: how long are we willing to wait
for the external condition to change? A typical shape is `Schedule.exponential`
for increasing delay, `Schedule.recurs` or `Schedule.take` for a hard recurrence
limit, and sometimes `Schedule.during` for an elapsed budget. Add
`Schedule.jittered` when many fibers, processes, or hosts can fail together.

For permanent failures, the schedule should stop immediately. If one retry
policy receives both transient and permanent errors, guard it with
`Schedule.while` and inspect `metadata.input`. Continue only while the failure
is classified as retryable.

For uncertain failures, do not treat uncertainty as transience. Use a small
bounded retry only when repeating the operation is safe, then surface the final
error. If the domain later learns how to distinguish permanent from transient
cases, narrow the retry predicate instead of expanding the delay policy.

##### Selection rules

Start with classification before timing:

1. If the request is wrong, do not retry.
2. If the dependency or timing window may recover, retry with backoff.
3. If the failure can happen across many clients, add jitter.
4. If the operation can duplicate side effects, require idempotency before retrying.
5. If the classifier is incomplete, keep the retry budget short.

Then choose the smallest schedule that expresses the decision. `Schedule.spaced`
and `Schedule.fixed` express steady cadence. `Schedule.exponential` expresses a
delay that grows after each failed attempt. `Schedule.recurs`, `Schedule.take`,
and `Schedule.during` express hard bounds. `Schedule.both` uses the larger delay
from its two inputs and stops when either input schedule stops.

#### 37.2 Immediate responsiveness vs infrastructure safety

Fast retries and tight polling can reduce visible latency, but they also add
load when a dependency may already be slow, unavailable, or recovering. Choose
the recurrence shape from the scarce resource: caller patience or downstream
capacity.

This entry is a selection aid, not a new primitive.

##### Decision matrix

| Problem shape                                                                                  | Prefer                                    | Schedule shape                                                                                                                                                     | Why                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| A user is actively waiting and the operation is cheap, local, or already rate-limited upstream | Fast retries or short polling             | `Schedule.recurs` or `Schedule.take` with a very small `Schedule.spaced` delay, usually under a short `Schedule.during` budget                                     | The main cost is user-visible latency. A few quick attempts can hide brief races without creating a long invisible wait.              |
| The dependency may be overloaded, restarting, or shared by many callers                        | Safer spacing or backoff                  | `Schedule.exponential` with a count or elapsed limit, often with `Schedule.jittered`                                                                               | Increasing delay gives the dependency recovery time. Jitter reduces synchronized retry waves across a fleet.                          |
| The workflow polls for readiness after creating work, such as a job or cache entry             | Start responsive, then slow down          | A short initial policy followed by `Schedule.exponential`, `Schedule.fibonacci`, or a larger `Schedule.spaced` cadence                                             | Early success is common, but persistent absence should not become high-frequency background load.                                     |
| The work is infrastructure maintenance, heartbeats, or health checks                           | Stable cadence with explicit bounds       | `Schedule.fixed` for interval boundaries or `Schedule.spaced` for a delay after each run                                                                           | `fixed` stays near clock-like boundaries without replaying missed runs. `spaced` waits after each completed run.                      |
| The operation has side effects or can duplicate external work                                  | Infrastructure safety first               | Backoff plus a low `Schedule.recurs` count, and only after idempotency is established                                                                              | Fast retries can duplicate writes, messages, or charges. The schedule cannot make an unsafe operation safe.                           |
| The path is high fan-out, batch-oriented, or run by many service instances                     | Conservative spacing, jitter, and budgets | `Schedule.exponential` or `Schedule.spaced`, bounded with `Schedule.recurs`, `Schedule.take`, or `Schedule.during`; add `Schedule.jittered` when callers may align | Aggregate load matters more than one caller's latency. A harmless-looking 100 millisecond retry can become expensive when multiplied. |

##### Selection rule

Choose fast recurrence only when all of these are true: the operation is cheap,
the recurrence count is low, the caller is waiting, duplicate effects are
acceptable or impossible, and the dependency is not already under pressure.

Choose safer spacing or backoff when any of these are true: many callers may
retry together, the dependency is shared, the failure mode may be overload, the
operation has meaningful side effects, or the workflow can continue
asynchronously.

##### Practical guidance

Treat responsiveness as a budget, not a default. A fast policy should normally
have both a small recurrence limit and a short elapsed-time limit. After that
budget is spent, fail visibly, switch to slower polling, or move the work to the
background.

Treat infrastructure safety as the default for shared systems. Use
`Schedule.exponential` when repeated failure should slow the caller down,
`Schedule.spaced` when each recurrence should wait after the previous run,
`Schedule.fixed` when runs should target regular interval boundaries, and
`Schedule.jittered` when many schedules may start together.

#### 37.3 Fixed cadence vs adaptive cadence

Use this matrix when the main question is whether work should run on a
predictable cadence or slow down in response to repeated failure, contention, or
uncertainty. `Schedule.fixed` and `Schedule.spaced` express steady cadence.
`Schedule.exponential`, `Schedule.fibonacci`, `Schedule.modifyDelay`, and
`Schedule.jittered` express adaptive behavior.

##### Decision matrix

| Problem shape                                                                                                      | Prefer                                                              | Why                                                                                                                                          | Guardrails                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health checks, metric flushes, cache refreshes, or maintenance work that should stay aligned to a regular interval | `Schedule.fixed(interval)`                                          | It targets fixed interval boundaries. If work overruns the interval, the next recurrence can be immediate, but missed runs are not replayed. | Add `Schedule.jittered` when many instances start together. Add `Schedule.take`, `Schedule.recurs`, or `Schedule.during` when the cadence is temporary. |
| Worker loops where each completed item should be followed by a pause                                               | `Schedule.spaced(duration)`                                         | It waits after each action completes. Long-running work naturally pushes the next run later.                                                 | Use this for politeness and load smoothing. Add count or elapsed limits for bounded workflows.                                                          |
| Retrying transient failures against a dependency that may be overloaded                                            | `Schedule.exponential(base, factor)` or `Schedule.fibonacci(base)`  | The delay grows as failures continue, reducing pressure on the dependency.                                                                   | Combine with `Schedule.recurs`, `Schedule.take`, or `Schedule.during`. Add `Schedule.jittered` for fleet-wide retries.                                  |
| Retrying rate limits, quota responses, or service-specific overload signals                                        | Adaptive backoff with `Schedule.modifyDelay` or a stateful schedule | The next delay should reflect the service signal, not only a local interval.                                                                 | Respect server-provided retry hints when available. Cap the maximum delay if user experience or job latency matters.                                    |
| Polling a known external state transition                                                                          | Start with `Schedule.spaced(duration)`                              | Polling is easier to reason about when every completed observation is followed by the same pause.                                            | Switch to adaptive polling only if early responsiveness matters or later polling should become less frequent. Stop on terminal status.                  |
| Reconnecting clients, brokers, sockets, or control-plane calls after failure                                       | Backoff plus jitter                                                 | Fast repeated reconnects can amplify an incident. Adaptive delay gives the remote system room to recover.                                    | Add a maximum delay, a maximum attempt count, and jitter for many clients.                                                                              |

##### Fixed cadence choices

`Schedule.fixed` and `Schedule.spaced` are both fixed-delay tools, but they
answer different operational questions.

- Choose `Schedule.fixed` when the desired shape is "run on this clock-like
  interval." It fits recurring work that should remain aligned to interval
  boundaries.
- Choose `Schedule.spaced` when the desired shape is "after each completion,
  wait this long." It fits work where action duration should push the next
  recurrence later.

The overrun behavior is the key difference. With `fixed`, slow work can be
followed by an immediate recurrence, while skipped intervals are not replayed.
With `spaced`, the delay is applied after the action completes, so overruns slow
the cadence automatically.

##### Adaptive cadence choices

Adaptive cadence is the better default when each repeated failure is evidence
that the next attempt should be more conservative. `Schedule.exponential` grows
by multiplying a base delay by the configured factor for each recurrence.
`Schedule.fibonacci` grows more gradually. `Schedule.modifyDelay` can clamp or
otherwise change the computed delay. `Schedule.jittered` randomizes each delay
between 80% and 120% of the current delay to reduce synchronization.

Use adaptive policies for retries more often than for ordinary periodic work. A
fixed cadence says, "this work is expected and routine." Backoff says, "the
system is failing or unavailable, so each new attempt should be less
aggressive."

##### Selection rules

- If the work is routine and expected to succeed, start with `Schedule.fixed` or `Schedule.spaced`.
- If the repeated action is a retry after failure, start with backoff unless the dependency is local, cheap, and known to recover quickly.
- If action duration should not shift the intended wall-clock cadence, use `Schedule.fixed`.
- If action duration should naturally slow the loop, use `Schedule.spaced`.
- If many clients can execute the same schedule at the same time, add jitter before relying on either fixed or adaptive timing.
- If the workflow has user-visible latency, add explicit attempt or elapsed-time limits instead of allowing long adaptive tails to grow invisibly.

##### Common mistakes

- Using `Schedule.fixed` for slow work and being surprised by immediate follow-up runs after overruns.
- Using `Schedule.spaced` when operators expect a wall-clock cadence such as "every minute."
- Using a fixed retry delay against an overloaded remote service, which can keep pressure constant when pressure should decrease.
- Adding exponential backoff to routine polling without a reason, which can make normal progress look sluggish.
- Forgetting jitter in a fleet, where identical fixed or adaptive policies can synchronize across instances.

#### 37.4 User-facing workflow vs background process

Use this entry to choose retry and polling budgets for visible workflows and
unattended processes. The split is not "frontend versus backend"; it is whether
a person or request path is waiting, or whether a supervised process can keep
working after the caller has moved on.

##### Decision matrix

| Decision                | User-facing workflow                                                                                                                                                  | Background process                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary budget          | Human or request latency. Prefer a short `Schedule.during` budget, a small `Schedule.recurs` count, or both.                                                          | Freshness, recovery, quota, or operational pressure. Use a larger elapsed budget only when delayed success is still valuable.                                                                                                     |
| Retry aggressiveness    | Start small and stop quickly. A brief `Schedule.exponential` policy can smooth transient failures, but long invisible waiting is worse than a clear failure.          | Usually less aggressive per attempt. Start with a larger base delay, cap growth with `Schedule.modifyDelay` when needed, and avoid keeping failed work alive indefinitely.                                                        |
| Polling cadence         | Use a responsive cadence only while the user is plausibly waiting. `Schedule.spaced` is clear when each poll should wait after the previous check completes.          | Prefer steady, predictable cadence. `Schedule.spaced` means "run, then wait"; `Schedule.fixed` means "stay near this interval boundary" and may run immediately after slow work without replaying missed runs.                    |
| Composition style       | Use `Schedule.both` for strict limits: continue only while both the cadence and the budget continue. This stops when either the count or elapsed budget is exhausted. | Use `Schedule.both` for local limits too, but review aggregate load separately. Use `Schedule.either` only when extending the policy is intentional, because it continues while either side continues and uses the smaller delay. |
| Jitter                  | Optional for a single visible workflow; useful when many clients can retry or poll together. Jitter may make one UI less predictable.                                 | Usually preferred for fleets. `Schedule.jittered` spreads each delay between 80% and 120% of the incoming delay, reducing synchronized pressure.                                                                                  |
| Failure surface         | Return the typed failure, timeout, or still-pending result promptly so the caller can choose the next product action.                                                 | Emit logs, metrics, or alerts when the process exhausts its retry budget. Supervision may restart the process, but the schedule should not hide repeated failure.                                                                 |
| Idempotency requirement | High for writes and workflow steps. Retrying a broad user action can duplicate side effects if only one inner step was transient.                                     | Still required. Background execution does not make unsafe side effects safe; it only changes how much time the system can spend recovering.                                                                                       |

##### Selection rules

Choose the policy from the thing that is scarce.

If caller patience is scarce, use a short elapsed budget and a small retry
count. `Schedule.exponential` can start with tens or hundreds of milliseconds,
but it should usually be paired with `Schedule.recurs` or `Schedule.during`
through `Schedule.both`. The result stops as soon as either the recurrence count
or time window is spent.

If dependency capacity is scarce, reduce retry pressure. Use a slower base
delay, increasing backoff, jitter for many callers, and explicit limits. A
background worker can wait longer than a request, but it still needs a reason to
keep trying and a visible exhaustion point.

If freshness is scarce, choose cadence before retry behavior. For a status view
or progress check, poll quickly only inside a short window. For cache refresh,
reconciliation, or maintenance, prefer a clear `Schedule.spaced` cadence and
keep failure retry inside one iteration so "recover this run" and "run again
later" remain separate decisions.

If synchronization is the risk, add jitter to the recurrence delay. This matters
more for background workers, service replicas, browser clients released at the
same time, and control-plane polling than for a single local workflow.

##### Reading the schedule

Review the final policy by asking three questions:

| Question                               | What to look for                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How often can it create load?          | `Schedule.spaced`, `Schedule.fixed`, `Schedule.exponential`, or a custom delay.                                                                                                     |
| When does it stop?                     | `Schedule.recurs`, `Schedule.take`, `Schedule.during`, or an input-aware condition.                                                                                                 |
| Does composition tighten or extend it? | `Schedule.both` tightens by requiring both sides to continue and using the larger delay. `Schedule.either` extends by allowing either side to continue and using the smaller delay. |

For user-facing work, the answers should be small and easy to explain in product
terms. For background work, the answers should be easy to explain in operational
terms: expected load, maximum recovery window, fleet behavior, and what happens
when the budget is exhausted.

#### 37.5 Single-instance behavior vs fleet-wide behavior

Use this entry when a locally reasonable schedule may multiply across many
processes, pods, browsers, or workers. Schedules do not coordinate across
instances by themselves: each fiber or process steps its own schedule and sleeps
for its own computed delay.

Compare the local recurrence to the aggregate behavior it creates.
`Schedule.spaced("10 seconds")` is modest for one process. Across 200 aligned
instances, it can mean up to 200 follow-up attempts every interval.
`Schedule.exponential`, `Schedule.recurs`, `Schedule.take`, `Schedule.during`,
and `Schedule.jittered` control different parts of that multiplication.

##### Decision matrix

| Problem shape                                | Main question                                                    | Prefer                                                                                                      | Why                                                                                                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One process performs a local background loop | How often should this one loop run?                              | `Schedule.spaced` for a gap after work, or `Schedule.fixed` for a clock-like interval                       | The policy is mostly local cadence. `fixed` keeps a regular interval without replaying missed runs. `spaced` waits after each recurrence decision.                                                       |
| One process retries a transient failure      | How quickly should this caller recover, and when should it stop? | `Schedule.exponential` with `Schedule.recurs`, `Schedule.take`, or `Schedule.during`                        | Backoff reduces repeated pressure from the same caller. Count and elapsed-time limits keep the retry from becoming an invisible long-running workflow.                                                   |
| Many instances may retry the same dependency | What is the aggregate retry rate?                                | Backoff plus a retry limit, usually with `Schedule.jittered`                                                | Instance count multiplies attempts. A policy that allows 5 retries allows up to `instances * 5` retries for a shared outage. Jitter spreads those decisions instead of letting them happen in lockstep.  |
| Many instances poll the same control plane   | What is the steady-state request rate?                           | Wider `Schedule.spaced` or `Schedule.fixed` intervals, often jittered                                       | Periodic work multiplies continuously, not only during failures. A 30-second poll from 120 instances is roughly 4 requests per second before retries.                                                    |
| Many instances start at the same time        | What happens after deploys, restarts, or autoscaling?            | Add jitter to the runtime cadence, and avoid very short initial spacing unless the dependency can absorb it | Identical schedules started together tend to stay aligned. Jitter adjusts each delay between 80% and 120% of the original delay, breaking alignment without changing the base policy beyond recognition. |
| Downstream capacity is strict                | Is local scheduling enough?                                      | Schedule caps plus external rate limiting, leasing, partitioning, or queue backpressure                     | `Schedule` controls when one workflow tries again. It does not enforce a fleet-wide quota, global concurrency limit, or single active owner. Use coordination when the invariant is global.              |

##### Practical guidance

Start by estimating the local policy, then multiply it by the number of
instances that can run it at once. Include the first attempt outside the
schedule when reasoning about retries: the schedule governs follow-up
decisions, while the original operation has already happened.

Use spacing when the main problem is steady-state load. `Schedule.spaced` is
easy to reason about for work that should leave a gap after completion.
`Schedule.fixed` is useful when the interval should remain tied to regular time
windows; late work may run the next recurrence immediately, but missed runs do
not accumulate.

Use caps when the main problem is worst-case retry volume. `Schedule.recurs(5)`
or `Schedule.take(5)` may be small locally, but the fleet-wide maximum is still
multiplied by active instances and failing operations per instance. Add
`Schedule.during` when the elapsed budget matters more than the exact count.

Use jitter when the main problem is synchronization. `Schedule.jittered`
randomly modifies each delay between 80% and 120% of the computed delay. It does
not reduce the total number of attempts; it spreads them over time. That makes
it valuable for fleets and less appropriate when exact cadence is promised.

If the desired behavior is "only one instance should do this", do not solve it
with a local schedule. Use a lease, leader election, a queue with one consumer
per partition, or another coordination primitive. Then apply `Schedule` inside
the elected or assigned worker to describe that worker's local retry, polling,
or repeat policy.

### 38. Glossary

#### 38.1 Retry

Retry reruns an effect after a typed failure. In `Effect.retry`, the first
attempt runs immediately. After each failure, that failure value becomes the
input to the `Schedule`; the schedule either halts, propagating the last
failure, or continues after the delay it computes.

"Typed failure" means a value in the effect's error channel. Defects and
interruptions are not treated as retryable failures by `Effect.retry`.

Retry differs from repeat by the signal that advances the schedule. Retry
advances after failure and stops on success. Repeat advances after success and
stops on failure. That difference decides what the schedule can inspect, what
the surrounding effect returns, and whether the policy is recovery logic or
normal recurrence.

Use retry when a later attempt may succeed because the failure is transient:
for example, a timeout, connection reset, temporary service unavailability, or
rate-limit response with a valid retry path. Bound retry with an attempt limit,
an elapsed-time budget, or both. Add backoff and jitter when many callers could
otherwise create synchronized extra load.

For writes, sends, publishes, payments, provisioning, deletes, and other
externally visible side effects, only retry when duplicate execution is safe or
guarded by the operation's protocol. A schedule can time and limit retries; it
cannot make an unsafe side effect idempotent.

#### 38.2 Repeat

Repeat reruns an effect after it succeeds. In `Effect.repeat`, the first
execution runs immediately. Each successful value then becomes the input to the
`Schedule`; the schedule decides whether to run again, how long to wait before
that run, and which schedule output is returned when repetition stops.

Repeat stops on failure unless the repeated effect handles or retries that
failure itself. Retry is the opposite shape: failures feed the schedule, and a
success ends the retry loop.

Because the first execution is outside the schedule, count limits describe
additional successful recurrences. `Schedule.recurs(3)` allows three repeats
after the initial run, not three total executions.

Use repeat for polling, heartbeats, refresh loops, sampling, maintenance loops,
and other workflows where the next run depends on the previous successful
observation. Use retry when the next run is a response to a typed failure.

Common repeat policies start with `Schedule.spaced` for a delay after each
successful run or `Schedule.fixed` for wall-clock cadence. Add `Schedule.recurs`
or `Schedule.take` for a count budget, `Schedule.during` for an elapsed-time
budget, `Schedule.while` for a value-based stop condition, and
`Schedule.passthrough` when the final result should be the latest successful
value rather than the schedule's own counter or duration output.

Make the stopping condition visible. An unbounded heartbeat may be deliberate,
but polling and refresh loops usually need a count limit, time budget, domain
predicate, or surrounding cancellation boundary.

#### 38.3 Polling

Polling repeats a successful observation until a domain condition is met or a
recurrence budget expires. The observation is the successful value produced by
the effect being repeated. The `Schedule` decides whether to observe again, how
long to wait, and when the loop has run long enough.

Keep domain status separate from operational failure. A response such as
`"pending"`, `"running"`, or `"not ready"` is usually a successful value that
may justify another poll. A timeout, malformed response, authorization failure,
or unavailable endpoint is an effect failure unless the program handles or
retries it separately.

A typical polling policy uses `Schedule.spaced` for a gap after each completed
check, or `Schedule.fixed` when a wall-clock cadence matters. Add
`Schedule.passthrough` when the final result should be the latest observed
status. Add `Schedule.while` to continue only while the observed status is
non-terminal. Add `Schedule.during`, `Schedule.recurs`, or `Schedule.take` for
elapsed-time or count budgets, and `Schedule.jittered` when many clients might
otherwise poll together.

The stop condition and budget are checked at schedule decision points after
successful observations. They do not turn a failing request into a successful
poll result, and they do not interrupt a request already in flight. Use a
per-request timeout when each individual observation needs a hard deadline.

For user-facing polling, prefer short budgets and explicit outcomes over long
invisible waiting. For background reconciliation, keep the cadence modest and
measure aggregate load across all workers, not just one loop.

#### 38.4 Backoff

Backoff is the delay shape used when recurrence should become less aggressive,
most often after repeated transient failures. It is not a separate Effect
primitive. It is the sequence of delays a `Schedule` offers between attempts.

Backoff is only one part of a recurrence policy. The delay shape says when the
next attempt may start. Other combinators decide how many recurrences are
allowed, which inputs may continue, and when an elapsed-time budget has expired.

Common delay shapes:

- Fixed backoff uses the same delay each time. `Schedule.spaced` waits after
  each completed attempt; `Schedule.fixed` targets interval boundaries and does
  not pile up missed runs.
- Linear backoff increases by a constant amount on each recurrence. There is no
  dedicated linear-backoff constructor in `Schedule.ts`; model this with state,
  such as `Schedule.unfold`, plus `Schedule.addDelay` or
  `Schedule.modifyDelay`.
- Exponential backoff multiplies the delay each time.
  `Schedule.exponential(base, factor)` starts with the base duration and uses a
  default factor of `2`.
- Capped backoff is an increasing delay with an upper bound. The cap limits the
  delay, not the number of recurrences.

Use fixed backoff when a steady retry pace is acceptable. Use linear backoff
when pressure should increase gently. Use exponential backoff when repeated
failure may indicate overload or temporary unavailability. Add a cap when the
tail delay would otherwise exceed the workflow's latency or recovery budget.

Backoff should usually be paired with an explicit stop condition such as
`Schedule.recurs`, `Schedule.take`, or `Schedule.during`. Add
`Schedule.jittered` when many fibers, processes, or clients could otherwise
retry on the same delay boundaries. In `Schedule.ts`, jitter adjusts each delay
randomly between 80% and 120% of the original delay.

#### 38.5 Idempotency

Idempotency is the property that running the same operation more than once has
the same intended effect as running it once. For retryable writes and other side
effects, it means a repeated attempt does not create duplicate orders, duplicate
payments, duplicate messages, or any other extra externally visible change.

The safety requirement lives outside the schedule. A `Schedule` can time and
bound a retry, but duplicate safety belongs to the operation being retried or
to the protocol around it.

Retries deliberately repeat work after failure. With reads, duplicate execution
is often harmless. With writes, a failure may only mean the caller did not
observe the result; the remote system may already have committed the change.
Retrying that write without a duplicate guard can turn a transient timeout into
duplicated state.

Before retrying a side effect, decide how duplicate attempts are recognized and
collapsed. Common guards include idempotency keys, deterministic request
identifiers, conditional writes, upserts keyed by stable business identity,
consumer-side de-duplication, and transactional checks that make "already done"
a successful outcome. The important property is that every retry attempt
represents the same logical operation, not a new operation with the same
payload.

Use `Schedule.recurs`, `Schedule.take`, `Schedule.during`, backoff, and jitter
to control retry behavior, but do not treat those controls as substitutes for
idempotency. A well-timed retry policy is still unsafe if each attempt may
perform the side effect again.

If the operation cannot be made idempotent, prefer surfacing the failure,
recording an ambiguous outcome for reconciliation, or moving the work behind a
durable queue that can enforce de-duplication.
