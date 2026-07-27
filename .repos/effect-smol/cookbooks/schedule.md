# Schedule Cookbook

Use this cookbook when you need to define a `Schedule` value. The examples are
ordered from small single-purpose policies to larger real-world policies that
combine timing, input classification, output shaping, and observation.

This cookbook intentionally defines schedules only. It does not apply them with
`Effect.retry`, `Effect.repeat`, streams, or channels.

## Before Choosing A Schedule

- `Schedule.recurs(n)` counts recurrences after the first run.
- `Schedule.spaced` waits after each completed run; `Schedule.fixed` uses an
  aligned cadence; `Schedule.windowed` recurs on window boundaries.
- `Schedule.duration` performs exactly one recurrence after the duration.
- `Schedule.during` is an elapsed-time budget, not a delay by itself.
- Schedule output is policy output. Use `Schedule.passthrough` to preserve the
  latest input, or `Schedule.map` to derive a new output from schedule metadata.
- `Schedule.max` continues only while all schedules continue and outputs the slowest delay.
- `Schedule.min` continues while any schedule can continue and outputs the fastest delay.
- `Schedule.jittered` spreads callers out. It does not add a recurrence limit.
- `Schedule.addDelay` adds extra delay based on schedule metadata.
- `Schedule.modifyDelay` replaces or adjusts the selected delay.
- Leave unbounded schedules to explicitly owned background work.

## Choose By Problem Shape

| Problem shape                             | Start with                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Bounded retry                             | `Schedule.exponential` or `Schedule.fibonacci`, then `Schedule.recurs` and optionally `Schedule.during`           |
| Poll latest status                        | `Schedule.spaced` or `Schedule.fixed`, then `Schedule.setInputType`, `Schedule.passthrough`, and `Schedule.while` |
| Adapt delay from metadata                 | `Schedule.addDelay`                                                                                               |
| Replace or cap selected delay             | `Schedule.modifyDelay`                                                                                            |
| Run phases in sequence                    | `Schedule.andThen`                                                                                                |
| Preserve phase in output                  | `Schedule.andThenResult`                                                                                          |
| Continue while all policies continue      | `Schedule.max`                                                                                                    |
| Continue while any policy continues       | `Schedule.min`                                                                                                    |
| Shape output from metadata                | `Schedule.map`                                                                                                    |
| Observe decisions without changing output | `Schedule.tap`                                                                                                    |

## Table Of Contents

1. [Single-Policy Schedules](#single-policy-schedules)
2. [Shape Schedule Outputs](#shape-schedule-outputs)
3. [Combine Policies](#combine-policies)
4. [Work With Inputs](#work-with-inputs)
5. [Adapt Delays](#adapt-delays)
6. [Observe Schedule Decisions](#observe-schedule-decisions)
7. [Realistic Policies](#realistic-policies)

## Single-Policy Schedules

### Retry A Profile Fetch Three Times

Goal: Create a retry policy for loading a user profile that allows at most 3
recurrences and outputs the recurrence count.

```ts
import { Schedule } from "effect"

const profileRetry = Schedule.recurs(3)
```

### Poll A Queue Once Per Second

Goal: Create a cadence for polling queue depth about 1 second after each
completed check.

```ts
import { Schedule } from "effect"

const queueDepthPolling = Schedule.spaced("1 second")
```

### Run A Heartbeat On An Aligned Cadence

Goal: Create a heartbeat cadence that runs on aligned 30-second boundaries
instead of waiting 30 seconds after each run finishes.

```ts
import { Schedule } from "effect"

const heartbeatCadence = Schedule.fixed("30 seconds")
```

### Warm A Cache Once After Deployment

Goal: Create a follow-up cache warmup that recurs exactly once after about 1
minute.

```ts
import { Schedule } from "effect"

const cacheWarmupFollowUp = Schedule.duration("1 minute")
```

### Keep A Health Probe Inside A Time Budget

Goal: Create a budget that allows health probes to continue only while about 1
minute has elapsed or less.

```ts
import { Schedule } from "effect"

const healthProbeBudget = Schedule.during("1 minute")
```

### Retry A Config Fetch With Exponential Backoff

Goal: Create a retry policy for fetching remote configuration, starting with a
100 millisecond exponential backoff.

```ts
import { Schedule } from "effect"

const configFetchBackoff = Schedule.exponential("100 millis")
```

### Probe A Cold Replica With Fibonacci Backoff

Goal: Create a gentler startup probe for a cold search replica, using Fibonacci
backoff and taking the first 4 outputs.

```ts
import { Schedule } from "effect"

const searchReplicaWarmup = Schedule.fibonacci("100 millis").pipe(
  Schedule.upTo({ times: 4 })
)
```

### Run A Worker Loop Forever

Goal: Create an unbounded worker-loop counter with no added delay.

```ts
import { Schedule } from "effect"

const workerLoopCounter = Schedule.forever
```

### Trigger A Nightly Report

Goal: Create a schedule for a nightly billing report at 02:00.

```ts
import { Schedule } from "effect"

const nightlyBillingReport = Schedule.cron("0 2 * * *")
```

### Sample Five-Minute Windows

Goal: Create a schedule that recurs on 5-minute window boundaries.

```ts
import { Schedule } from "effect"

const fiveMinuteWindows = Schedule.windowed("5 minutes")
```

## Shape Schedule Outputs

### Echo Feature Flag Inputs

Goal: Create a schedule for feature flag snapshots that immediately outputs
each input unchanged and takes the first 3 samples.

```ts
import { Schedule } from "effect"

type FeatureFlagSnapshot = { readonly enabled: boolean }

const featureFlagSamples = Schedule.identity<FeatureFlagSnapshot>().pipe(
  Schedule.upTo({ times: 3 })
)
```

### Label Retry Attempts

Goal: Create a retry-attempt schedule that turns recurrence count metadata into
labels such as `attempt-1`, `attempt-2`, and `attempt-3`.

```ts
import { Schedule } from "effect"

const retryAttemptLabels = Schedule.recurs(3).pipe(
  Schedule.map(({ output: count }) => `attempt-${count + 1}`)
)
```

Explanation: `Schedule.map` receives the full step metadata. Destructure
`output` when you only need the schedule output, or use fields such as `input`,
`attempt`, `duration`, and `elapsed` when the new output needs more context.

## Combine Policies

### Add Jitter To Webhook Backoff

Goal: Create a webhook retry backoff that starts at 200 milliseconds, adds
jitter, and takes 3 outputs.

```ts
import { Schedule } from "effect"

const jitteredWebhookBackoff = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 3 })
)
```

### Stop Deployment Hook Retries By Count And Time

Goal: Create a deployment hook retry budget that uses jittered exponential
backoff, allows at most 5 recurrences, and also stops after about 20 seconds.

```ts
import { Schedule } from "effect"

const deploymentHookRetryBudget = Schedule.max([
  Schedule.exponential("200 millis").pipe(Schedule.jittered),
  Schedule.recurs(5),
  Schedule.during("20 seconds")
])
```

Explanation: `Schedule.max` stops when any schedule stops and outputs the
slowest selected delay for each recurrence.

### Continue While Any Probe Is Active

Goal: Create a service readiness policy that continues while either 2 immediate
warmup probes or a slower 500 millisecond probe schedule still wants to recur,
using the fastest selected delay.

```ts
import { Schedule } from "effect"

const readinessWarmupOrSlowProbe = Schedule.min([
  Schedule.recurs(2),
  Schedule.spaced("500 millis").pipe(Schedule.upTo({ times: 5 }))
])
```

Explanation: `Schedule.min` keeps recurring while at least one schedule can
continue and outputs the fastest selected delay among schedules that are still
recurring.

### Warm Up Fast, Then Settle Into Maintenance

Goal: Create a cache invalidation sequence that runs 2 quick recurrences 100
milliseconds apart, then 3 slower recurrences 30 seconds apart, then stops.

```ts
import { Schedule } from "effect"

const cacheInvalidationSequence = Schedule.spaced("100 millis").pipe(
  Schedule.upTo({ times: 2 }),
  Schedule.andThen(Schedule.spaced("30 seconds").pipe(Schedule.upTo({ times: 3 })))
)
```

### Preserve Warmup And Steady Phases

Goal: Create a retry classifier with a fast exponential phase and a steady
Fibonacci phase, preserving the phase in the output.

```ts
import { Result, Schedule } from "effect"

const phasedRetryClassifier = Schedule.exponential("100 millis").pipe(
  Schedule.upTo({ times: 2 }),
  Schedule.andThenResult(Schedule.fibonacci("500 millis").pipe(Schedule.upTo({ times: 3 }))),
  Schedule.map(({ output: result }) =>
    Result.match(result, {
      onFailure: (delay) => ({ phase: "fast", delay }),
      onSuccess: (delay) => ({ phase: "steady", delay })
    })
  )
)
```

Explanation: `Schedule.andThenResult` keeps phase information in the output.
The first schedule is represented by the failure side, and the second schedule
is represented by the success side.

## Work With Inputs

### Poll Upload Progress Until Complete

Goal: Create an upload-progress schedule that waits about 1 second between
checks, outputs the latest progress object, and continues only while the upload
is incomplete.

```ts
import { Schedule } from "effect"

type UploadProgress = { readonly percent: number }

const uploadProgressUntilComplete = Schedule.spaced("1 second").pipe(
  Schedule.setInputType<UploadProgress>(),
  Schedule.passthrough,
  Schedule.while(({ input }) => input.percent < 100)
)
```

Explanation: `Schedule.setInputType` tells TypeScript which input each step
receives. `Schedule.passthrough` makes the output the latest input, so a polling
schedule can return the final status instead of a counter.

## Adapt Delays

### Slow A Queue Consumer Under Backpressure

Goal: Create a queue backpressure schedule that outputs each queue snapshot,
continues while the queue is not paused, adds 5 seconds of delay when depth is
above 1000, adds 500 milliseconds otherwise, and takes 10 outputs.

```ts
import { Effect, Schedule } from "effect"

type QueueSnapshot = { readonly depth: number; readonly paused: boolean }

const queueBackpressureSchedule = Schedule.identity<QueueSnapshot>().pipe(
  Schedule.while(({ input }) => !input.paused),
  Schedule.addDelay(({ output: snapshot }) => Effect.succeed(snapshot.depth > 1000 ? "5 seconds" : "500 millis")),
  Schedule.upTo({ times: 10 })
)
```

Explanation: `Schedule.addDelay` receives the full step metadata and adds the
returned delay to the selected delay. It is a good fit for input-driven pacing
when the output is already the latest input.

### Cap WebSocket Reconnect Delays

Goal: Create a reconnect policy that uses jittered exponential backoff, caps
selected delays at 5 seconds, allows at most 8 recurrences, and outputs the
selected delay.

```ts
import { Duration, Effect, Schedule } from "effect"

const websocketReconnectDelays = Schedule.max([
  Schedule.exponential("100 millis").pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(5))))
  ),
  Schedule.recurs(8)
])
```

Explanation: `Schedule.modifyDelay` receives the full step metadata, including
the selected delay as `duration`, and returns the replacement delay. Use it for
caps, floors, clamps, or provider-provided delay hints.

## Observe Schedule Decisions

### Log Heartbeat Inputs

Goal: Create a heartbeat schedule that runs on an aligned 10-second cadence,
logs each service id input, outputs the input unchanged, and takes 2 outputs.

```ts
import { Console, Schedule } from "effect"

type HeartbeatStatus = { readonly id: string }

const heartbeatInputLogs = Schedule.fixed("10 seconds").pipe(
  Schedule.setInputType<HeartbeatStatus>(),
  Schedule.tap(({ input }) => Console.log(`heartbeat:${input.id}`)),
  Schedule.passthrough,
  Schedule.upTo({ times: 2 })
)
```

### Record Backoff Delays

Goal: Create a retry schedule that uses Fibonacci backoff, takes 5 outputs, and
logs each selected delay without changing the schedule output.

```ts
import { Console, Schedule } from "effect"

const loggedBackoffDelays = Schedule.fibonacci("200 millis").pipe(
  Schedule.upTo({ times: 5 }),
  Schedule.tap(({ output: delay }) => Console.log(delay))
)
```

### Log Attempt Metadata

Goal: Create a telemetry backoff that logs each attempt number and selected
delay in milliseconds without changing the schedule output.

```ts
import { Console, Duration, Schedule } from "effect"

const telemetryBackoffPolicy = Schedule.exponential("250 millis").pipe(
  Schedule.upTo({ times: 5 }),
  Schedule.tap(({ attempt, output }) => Console.log(`attempt-${attempt}: ${Duration.toMillis(output)}ms`))
)
```

Explanation: use `Schedule.tap` to observe inputs, outputs, and metadata such as
attempt number or selected duration without changing the schedule output.

## Realistic Policies

### Retry An HTTP Gateway With A Delay Envelope

Goal: Create an HTTP gateway retry schedule. Retry only network failures, status
429, and status 500, 502, or 503. Use jittered exponential backoff starting at
100 milliseconds, cap selected delays at 2 seconds, allow at most 6 recurrences,
and output the selected delay.

```ts
import { Duration, Effect, Schedule } from "effect"

type GraphqlGatewayError =
  | { readonly _tag: "Network" }
  | { readonly _tag: "HttpStatus"; readonly status: number }
  | { readonly _tag: "BadRequest" }

const isRetryableGraphqlGatewayError = (
  error: GraphqlGatewayError
): boolean =>
  error._tag === "Network" ||
  (error._tag === "HttpStatus" &&
    (error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503))

const graphqlGatewayRetry = Schedule.max([
  Schedule.exponential("100 millis").pipe(
    Schedule.jittered,
    Schedule.setInputType<GraphqlGatewayError>(),
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(2))))
  ),
  Schedule.recurs(6)
]).pipe(
  Schedule.while(({ input }) => isRetryableGraphqlGatewayError(input))
)
```

### Poll A Rollout With A Deadline

Goal: Create a rollout watcher that starts from an aligned 1-second cadence,
jitters the selected delay, outputs the latest status, continues only while the
rollout is running, and stops after about 2 minutes.

```ts
import { Duration, Schedule } from "effect"

type RolloutStatus = {
  readonly state: "running" | "succeeded" | "failed"
}

const rolloutStatusWatcher = Schedule.fixed("1 second").pipe(
  Schedule.setInputType<RolloutStatus>(),
  Schedule.passthrough,
  Schedule.jittered,
  Schedule.while(({ input, elapsed }) =>
    input.state === "running" &&
    Duration.isLessThanOrEqualTo(Duration.millis(elapsed), Duration.minutes(2))
  )
)
```

### Respect A Provider Retry-After Header

Goal: Create a provider retry schedule. Retry status 429, 500, and 503. Use
exponential backoff starting at 1 second. When `retryAfter` is present, use it as
a lower bound. Cap selected delays at 1 minute, allow at most 6 recurrences, and
output the selected delay.

```ts
import { Duration, Effect, Schedule } from "effect"

type PushProviderResponse = {
  readonly status: 429 | 500 | 503 | 400
  readonly retryAfter: Duration.Duration | undefined
}

const pushNotificationProviderRetry = Schedule.max([
  Schedule.exponential("1 second").pipe(
    Schedule.setInputType<PushProviderResponse>(),
    Schedule.passthrough,
    Schedule.modifyDelay(({ output: response, duration }) =>
      Effect.succeed(
        Duration.min(
          response.retryAfter === undefined
            ? duration
            : Duration.max(duration, response.retryAfter),
          Duration.minutes(1)
        )
      )
    )
  ),
  Schedule.recurs(6)
]).pipe(
  Schedule.while(({ input }) => input.status === 429 || input.status === 500 || input.status === 503)
)
```

### Poll An OAuth Device Code Flow

Goal: Create an OAuth device-code polling schedule. Poll every 5 seconds, add
another 5 seconds for `slow_down`, output the latest input, continue only for
`authorization_pending` and `slow_down`, and stop after about 15 minutes.

```ts
import { Duration, Effect, Schedule } from "effect"

type OAuthDeviceCodeStatus = {
  readonly error:
    | "authorization_pending"
    | "slow_down"
    | "access_denied"
    | "expired_token"
}

const oauthDeviceCodePolling = Schedule.spaced("5 seconds").pipe(
  Schedule.setInputType<OAuthDeviceCodeStatus>(),
  Schedule.passthrough,
  Schedule.addDelay(({ output: status }) => Effect.succeed(status.error === "slow_down" ? "5 seconds" : "0 millis")),
  Schedule.while(({ input, elapsed }) =>
    (input.error === "authorization_pending" || input.error === "slow_down") &&
    Duration.isLessThanOrEqualTo(Duration.millis(elapsed), Duration.minutes(15))
  )
)
```

### Escalate Incident Notifications In Phases

Goal: Create an incident escalation cadence that emits 3 recurrences spaced 1
minute apart, then 3 recurrences spaced 5 minutes apart, then switches to an
aligned 15-minute cadence.

```ts
import { Schedule } from "effect"

const incidentEscalationCadence = Schedule.spaced("1 minute").pipe(
  Schedule.upTo({ times: 3 }),
  Schedule.andThen(Schedule.spaced("5 minutes").pipe(Schedule.upTo({ times: 3 }))),
  Schedule.andThen(Schedule.fixed("15 minutes"))
)
```

### Run Maintenance After A Warmup

Goal: Create a maintenance schedule that performs one warmup recurrence after
about 30 seconds, then switches to a cron schedule that recurs every day at
03:00.

```ts
import { Schedule } from "effect"

const maintenanceCronAfterWarmup = Schedule.duration("30 seconds").pipe(
  Schedule.andThen(Schedule.cron("0 3 * * *"))
)
```
