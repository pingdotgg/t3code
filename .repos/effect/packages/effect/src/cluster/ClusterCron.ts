/**
 * Runs recurring cron jobs through cluster sharding.
 *
 * This module turns a `Cron.Cron` schedule into a `Layer` that coordinates one
 * recurring job across a cluster. It registers a singleton for the initial
 * scheduling step and a persisted entity message for each run. This is useful
 * for distributed maintenance work where the job should be owned by the cluster
 * rather than by every runner independently.
 *
 * With `calculateNextRunFromPrevious`, every run is processed by a single
 * entity per cron job, so runs never overlap and are caught up in order. The
 * scheduled time of the current run is available through
 * `CurrentScheduledTime`.
 *
 * @stability unstable
 * @since 4.0.0
 */
import * as Context from "../Context.ts"
import * as Cron from "../Cron.ts"
import * as DateTime from "../DateTime.ts"
import * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import * as Exit from "../Exit.ts"
import * as Layer from "../Layer.ts"
import * as PrimaryKey from "../PrimaryKey.ts"
import * as Rpc from "../rpc/Rpc.ts"
import * as Schedule from "../Schedule.ts"
import * as Schema from "../Schema.ts"
import type { Scope } from "../Scope.ts"
import * as ClusterSchema from "./ClusterSchema.ts"
import { Persisted, Uninterruptible } from "./ClusterSchema.ts"
import * as DeliverAt from "./DeliverAt.ts"
import * as Entity from "./Entity.ts"
import type { Sharding } from "./Sharding.ts"
import * as Singleton from "./Singleton.ts"

/**
 * Service tag for the scheduled time of the cron run currently executing.
 *
 * **When to use**
 *
 * Use to read the time the current run was scheduled for, inside the
 * `execute` effect of `make`.
 *
 * @stability unstable
 * @category services
 * @since 4.0.0
 */
export class CurrentScheduledTime extends Context.Service<
  CurrentScheduledTime,
  DateTime.Utc
>()("effect/cluster/ClusterCron/CurrentScheduledTime") {}

/**
 * Service tag and entity annotation for the effective schedule of a cron job.
 *
 * **When to use**
 *
 * Use to read a job's effective schedule inside the `execute` effect of `make`,
 * or read it from `entity.protocol.annotations` with `Context.getOption` when
 * inspecting registered cron entities.
 *
 * @stability unstable
 * @category services
 * @since 4.1.5
 */
export class CronSchedule extends Context.Service<CronSchedule, {
  readonly cron: Cron.Cron
  readonly calculateNextRunFromPrevious: boolean
  readonly skipIfOlderThan: Duration.Duration
}>()("effect/cluster/ClusterCron/CronSchedule") {}

/**
 * Creates a layer that runs a cron job through the cluster sharding system.
 *
 * **Details**
 *
 * The job is scheduled as persisted entity messages, with an initial singleton
 * scheduling step and optional controls for shard group, next-run calculation,
 * and skipping stale scheduled runs.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const make = <E, R>(options: {
  readonly name: string
  readonly cron: Cron.Cron
  readonly execute: Effect.Effect<void, E, R>

  /**
   * Choose a shard group to run this cron job on.
   */
  readonly shardGroup?: string | undefined

  /**
   * Controls whether the next cron job is based on the time of the previous
   * run.
   *
   * **Details**
   *
   * Defaults to `false`, meaning the next run will be calculated from the
   * current time.
   *
   * When enabled, all runs are processed one at a time by a single entity, so
   * missed runs are caught up in order without overlapping. A run that fails
   * is retried in place and blocks later runs until it succeeds or is older
   * than `skipIfOlderThan`.
   */
  readonly calculateNextRunFromPrevious?: boolean | undefined

  /**
   * If set, the cron job will skip execution if the scheduled time is older
   * than this duration.
   *
   * **When to use**
   *
   * Use to prevent running jobs that were scheduled too far in the past.
   *
   * **Details**
   *
   * Defaults to "1 day".
   */
  readonly skipIfOlderThan?: Duration.Input | undefined
}): Layer.Layer<never, never, Sharding | Exclude<Exclude<R, CurrentScheduledTime | CronSchedule>, Scope>> => {
  const fromPrevious = options.calculateNextRunFromPrevious === true
  const cronSchedule = {
    cron: options.cron,
    calculateNextRunFromPrevious: fromPrevious,
    skipIfOlderThan: Duration.fromInputUnsafe(options.skipIfOlderThan ?? "1 day")
  }
  const scheduleContext = Context.make(CronSchedule, cronSchedule)
  const nextRun = (after: DateTime.Utc) => DateTime.fromDateUnsafe(Cron.next(cronSchedule.cron, after))

  const CronEntity = Entity.make(`ClusterCron/${options.name}`, [
    Rpc.make("run", {
      payload: CronPayload
    })
      .annotate(Persisted, true)
      .annotate(Uninterruptible, true),
    Rpc.make("start").annotate(Persisted, true)
  ])
    .annotate(ClusterSchema.ShardGroup, () => options.shardGroup ?? "default")
    .annotate(ClusterSchema.ClientTracingEnabled, false)
    .annotate(CronSchedule, cronSchedule)

  // with `calculateNextRunFromPrevious`, every run shares the executor address
  const send = (dateTime: DateTime.Utc) =>
    Effect.flatMap(CronEntity.client, (makeClient) =>
      fromPrevious
        ? makeClient(executorId).run(new CronPayload({ dateTime, executor: true }), { discard: true })
        : makeClient(DateTime.formatIso(dateTime)).run(new CronPayload({ dateTime }), { discard: true }))

  const schedule = (dateTime: DateTime.Utc) => send(dateTime).pipe(withRetry("Failed to schedule next run, retrying"))

  const InitialRun = Singleton.make(
    `ClusterCron/${options.name}`,
    fromPrevious
      // the executor schedules the next run if its chain has been lost.
      // `start` has no primary key, so each retry is a new message
      ? Effect.flatMap(CronEntity.client, (makeClient) => makeClient(executorId).start()).pipe(
        withRetry("Failed to start cron job, retrying")
      )
      : Effect.flatMap(
        DateTime.now,
        (now) => send(nextRun(now)).pipe(withRetry("Failed to schedule initial run, retrying"))
      ),
    { shardGroup: options.shardGroup }
  )

  const execute = Effect.fnUntraced(function*(dateTime: DateTime.Utc) {
    const now = yield* DateTime.now
    if (DateTime.isLessThan(dateTime, DateTime.subtractDuration(now, cronSchedule.skipIfOlderThan))) {
      return
    }
    return yield* Effect.provideContext(
      options.execute,
      Context.add(scheduleContext, CurrentScheduledTime, dateTime)
    )
  }, Effect.orDie)

  const EntityLayer = CronEntity.toLayer(Effect.gen(function*() {
    const address = yield* Entity.CurrentAddress
    // runs are processed one at a time, so a run processed before `start`
    // means the chain is alive
    let processedRun = false
    return {
      run: (request) => {
        const dateTime = request.payload.dateTime
        if (fromPrevious && address.entityId !== executorId) {
          // a run scheduled by an earlier release joins the executor's chain
          return schedule(dateTime)
        }
        processedRun = true
        return Effect.onExitPrimitive(
          execute(dateTime),
          (exit) =>
            Effect.andThen(
              Exit.isFailure(exit) ? Effect.logWarning(exit.cause) : Effect.void,
              fromPrevious ? schedule(nextRun(dateTime)) : Effect.flatMap(DateTime.now, (now) => schedule(nextRun(now)))
            ),
          true
        ).pipe(
          Effect.annotateLogs({
            module: "effect/cluster/ClusterCron",
            name: options.name,
            dateTime
          })
        )
      },
      start: () =>
        processedRun
          ? Effect.void
          // deduplicated against the pending run if the chain is alive
          : Effect.flatMap(DateTime.now, (now) => schedule(nextRun(now)))
    }
  }))

  return Layer.merge(InitialRun, EntityLayer)
}

const executorId = "executor"

const retryPolicy = Schedule.min([
  Schedule.exponential(200, 1.5),
  Schedule.spaced("1 minute")
])

const withRetry = (message: string) => <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
  self.pipe(
    Effect.tapCause((cause) => Effect.logWarning(message, cause)),
    Effect.sandbox,
    Effect.retry(retryPolicy),
    Effect.orDie
  )

class CronPayload extends Schema.Class<CronPayload>("effect/cluster/ClusterCron/CronPayload")({
  dateTime: Schema.DateTimeUtc,
  // set for runs sent to the executor, which share one entity address
  executor: Schema.optional(Schema.Boolean)
}) {
  [PrimaryKey.symbol]() {
    return this.executor ? DateTime.formatIso(this.dateTime) : ""
  }
  [DeliverAt.symbol]() {
    return this.dateTime
  }
}
