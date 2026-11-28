import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

const MAX_EVENTS = 64;
const MAX_BYTES = 1024 * 1024;
// While another write waits, a shared transaction stops taking jobs after this long.
const MAX_HOLD_NANOS = 100_000_000n;
// A stream waiting this long ranks like a main thread, so subagents cannot starve.
const STARVATION_MILLIS = 30_000;
// Bounds snapshots held across stream queues; a full backlog makes streams wait to read more.
const MAX_QUEUED = 4 * MAX_EVENTS;
const encodeQueue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const enabled = Config.Boolean("HYAKKI_PROVIDER_COMMIT_BATCHING").pipe(
  Config.withDefault(true),
  Effect.orDie,
);

type Snapshot =
  | {
      readonly type: "node.updated";
      readonly node: { readonly id: string; readonly threadId: string };
    }
  | {
      readonly type: "message.updated";
      readonly message: { readonly id: string; readonly threadId: string };
    }
  | {
      readonly type: "turn_item.updated";
      readonly turnItem: { readonly id: string; readonly threadId: string };
    }
  | {
      readonly type: "plan.updated";
      readonly plan: { readonly id: string; readonly threadId: string };
    };
const isSnapshot = (event: { readonly type: string }): event is Snapshot =>
  event.type === "node.updated" ||
  event.type === "message.updated" ||
  event.type === "turn_item.updated" ||
  event.type === "plan.updated";
const snapshotEntity = (event: Snapshot) => {
  const entity =
    event.type === "node.updated"
      ? event.node
      : event.type === "message.updated"
        ? event.message
        : event.type === "turn_item.updated"
          ? event.turnItem
          : event.plan;
  return { key: `${event.type}:${entity.id}`, threadId: entity.threadId };
};

/** Who a provider stream writes for; ranks its snapshots against other streams'. */
export interface StreamPriority {
  readonly threadId: string;
  /** A subagent or delegated task, which yields to main threads. */
  readonly delegated: boolean;
}

export class CommitBatchError extends Schema.TaggedError<CommitBatchError>()("CommitBatchError", {
  cause: Schema.Defect(),
}) {}
export const isCommitBatchError = Schema.is(CommitBatchError);

interface StreamState {
  readonly owner: { active: boolean };
  readonly priority: StreamPriority | undefined;
  /** Queued snapshots not yet taken into a batch, in stream order. */
  readonly jobs: Array<Job>;
  unsettled: number;
  servedAt: number;
  /** A control, failure or EOF of this stream waits for its queued snapshots. */
  finishing: boolean;
}
interface Job {
  readonly stream: StreamState;
  /** Still in its stream's queue, holding one of the backlog's `MAX_QUEUED` slots. */
  queued: boolean;
  readonly key: string;
  readonly threadId: string;
  readonly queuedAt: number;
  readonly bytes: number;
  readonly execute: Effect.Effect<void, CommitBatchError>;
  readonly settle: (
    exit: Exit.Exit<void, CommitBatchError>,
    preserveFailure: boolean,
  ) => Effect.Effect<void>;
  /** Settles a job a later snapshot of the same entity replaced, with that snapshot's outcome. */
  readonly skip: (exit: Exit.Exit<void, CommitBatchError>) => Effect.Effect<void>;
  readonly cancel: Effect.Effect<void>;
  readonly settled: Effect.Effect<void>;
}
interface Unit {
  readonly job: Job;
  readonly superseded: ReadonlyArray<Job>;
}
interface Batch {
  readonly units: ReadonlyArray<Unit>;
  readonly reason: "ready" | "limit";
  readonly dequeued: number;
}

/**
 * Snapshots carry an entity's full state, so an earlier one is dropped when a later one of the
 * same entity follows it in this stream with no first appearance of another entity in between.
 * Kept jobs stay in stream order, and entities first appear in the same order as before.
 */
function coalesce(jobs: ReadonlyArray<Job>): Array<Unit> {
  const firstSeen = new Map<string, number>();
  jobs.forEach((job, index) => {
    if (!firstSeen.has(job.key)) firstSeen.set(job.key, index);
  });
  const survivor: Array<number> = Array.from({ length: jobs.length }, (_, index) => index);
  const nextOfKey = new Map<string, number>();
  for (let index = jobs.length - 1; index >= 0; index--) {
    const job = jobs[index]!;
    const next = nextOfKey.get(job.key);
    nextOfKey.set(job.key, index);
    if (next === undefined) continue;
    let replaced = true;
    for (let between = index + 1; replaced && between < next; between++) {
      if (firstSeen.get(jobs[between]!.key)! > index) replaced = false;
    }
    if (replaced) survivor[index] = survivor[next]!;
  }
  const superseded = new Map<number, Array<Job>>();
  jobs.forEach((job, index) => {
    const kept = survivor[index]!;
    if (kept !== index) superseded.set(kept, [...(superseded.get(kept) ?? []), job]);
  });
  return jobs.flatMap((job, index) =>
    survivor[index] === index ? [{ job, superseded: superseded.get(index) ?? [] }] : [],
  );
}

const CurrentWorker = Context.Reference<number | undefined>(
  "t3/ProviderCommitBatch/CurrentWorker",
  {
    defaultValue: () => undefined,
  },
);

export const make = Effect.fn("ProviderCommitBatch.make")(function* (
  commit: (work: Effect.Effect<void, CommitBatchError>) => Effect.Effect<void, CommitBatchError>,
  enabled: boolean,
  isolate: (
    work: Effect.Effect<void, CommitBatchError>,
  ) => Effect.Effect<void, CommitBatchError> = (work) => work,
  /** Whether a client has the thread open; its streams rank first. */
  isViewed: (threadId: string) => boolean = () => false,
) {
  const wake = yield* Queue.sliding<void>(1);
  const backlog = yield* Semaphore.make(MAX_QUEUED);
  const streams = new Set<StreamState>();
  const pending = new Set<Job>();
  let closed = false;
  let servings = 0;
  // The snapshots each unfinished `barrier` write waits on.
  const waitingWrites = new Set<ReadonlySet<Job>>();
  const shutdown = Effect.gen(function* () {
    closed = true;
    yield* Queue.shutdown(wake);
    for (const job of pending) yield* job.cancel;
    yield* backlog.releaseAll;
  });
  yield* Effect.addFinalizer(() => shutdown);
  // These helpers run once per raw event; the shared transaction owns the tracing span.
  const enqueue = Effect.fnUntraced(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    stream: StreamState,
    entity: { readonly key: string; readonly threadId: string },
    bytes: number,
    skipped: A,
  ) {
    const caller = yield* Effect.context<R>();
    const reply = yield* Deferred.make<A, E | CommitBatchError>();
    let ownFailure: Cause.Cause<E> | undefined;
    let result: A;
    const release = () => {
      if (pending.delete(job)) stream.unsettled--;
    };
    const job: Job = {
      stream,
      queued: false,
      key: entity.key,
      threadId: entity.threadId,
      queuedAt: yield* Clock.currentTimeMillis,
      bytes,
      execute: effect.pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            ownFailure = cause;
          }),
        ),
        Effect.mapError((cause) => new CommitBatchError({ cause })),
        Effect.provideContext(caller),
        Effect.tap((value) =>
          Effect.sync(() => {
            result = value;
          }),
        ),
        Effect.asVoid,
      ),
      settle: Effect.fnUntraced(function* (
        exit: Exit.Exit<void, CommitBatchError>,
        preserveFailure: boolean,
      ) {
        release();
        if (Exit.isFailure(exit)) {
          stream.owner.active = false;
          yield* Deferred.failCause(
            reply,
            preserveFailure && ownFailure !== undefined ? ownFailure : exit.cause,
          );
        } else yield* Deferred.succeed(reply, result);
      }),
      skip: (exit) =>
        Exit.isFailure(exit)
          ? job.settle(exit, false)
          : Effect.suspend(() => {
              release();
              return Deferred.succeed(reply, skipped);
            }),
      cancel: Effect.suspend(() => {
        release();
        const dequeued = job.queued;
        job.queued = false;
        return Deferred.interrupt(reply).pipe(
          Effect.andThen(dequeued ? backlog.release(1) : Effect.void),
        );
      }),
      settled: Deferred.await(reply).pipe(Effect.exit, Effect.asVoid),
    };
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (closed) return yield* Deferred.interrupt(reply);
        yield* restore(backlog.take(1));
        if (closed) {
          yield* backlog.release(1);
          return yield* Deferred.interrupt(reply);
        }
        job.queued = true;
        pending.add(job);
        stream.unsettled++;
        stream.jobs.push(job);
        yield* Queue.offer(wake, undefined);
      }),
    );
    return Deferred.await(reply);
  });
  const rank = (stream: StreamState, now: number) => {
    const tier =
      stream.priority === undefined
        ? 1
        : isViewed(stream.priority.threadId)
          ? 0
          : stream.priority.delegated
            ? 2
            : 1;
    const starved = now - stream.jobs[0]!.queuedAt >= STARVATION_MILLIS;
    return [starved ? Math.min(tier, 1) : tier, stream.finishing ? 0 : 1, stream.servedAt];
  };
  // Viewed streams first, then main threads, then subagents; within a tier, streams finishing a
  // control first, then the stream served longest ago.
  const nextBatch = (now: number): Batch | undefined => {
    const ready = Array.from(streams, (stream) =>
      stream.jobs.length === 0 ? [] : [{ stream, rank: rank(stream, now) }],
    )
      .flat()
      .sort((left, right) => {
        for (let index = 0; index < left.rank.length; index++) {
          const order = left.rank[index]! - right.rank[index]!;
          if (order !== 0) return order;
        }
        return 0;
      });
    if (ready.length === 0) return undefined;
    const units: Array<Unit> = [];
    let bytes = 0;
    let dequeued = 0;
    let reason: Batch["reason"] = "ready";
    for (const { stream } of ready) {
      let take = 0;
      while (take < stream.jobs.length && take < MAX_EVENTS - units.length) {
        const next = stream.jobs[take]!.bytes;
        if (units.length + take > 0 && bytes + next > MAX_BYTES) break;
        bytes += next;
        take++;
      }
      if (take < stream.jobs.length) reason = "limit";
      if (take === 0) break;
      const taken = stream.jobs.splice(0, take);
      for (const job of taken) job.queued = false;
      dequeued += take;
      units.push(...coalesce(taken));
      stream.servedAt = ++servings;
      if (units.length >= MAX_EVENTS || bytes >= MAX_BYTES) break;
    }
    return { units, reason, dequeued };
  };
  // Commits a prefix of `units` in one transaction and returns how many it took.
  const commitPrefix = (units: ReadonlyArray<Unit>, reason: Batch["reason"]) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const outcomes = new Map<Job, Exit.Exit<void, CommitBatchError>>();
        let taken = 0;
        const work = Effect.gen(function* () {
          // A retried transaction runs this again from the first unit.
          outcomes.clear();
          taken = 0;
          const startedAt = yield* Clock.monotonicTimeNanos;
          for (const { job, superseded } of units) {
            // Cutting only helps a write that needs none of the units still to run.
            if (
              taken > 0 &&
              waitingWrites.size > 0 &&
              (yield* Clock.monotonicTimeNanos) - startedAt >= MAX_HOLD_NANOS &&
              Array.from(waitingWrites).some((jobs) =>
                units
                  .slice(taken)
                  .every(
                    (unit) => !jobs.has(unit.job) && !unit.superseded.some((j) => jobs.has(j)),
                  ),
              )
            )
              return;
            taken++;
            if (!job.stream.owner.active) {
              yield* job.cancel;
              for (const replaced of superseded) yield* replaced.cancel;
              continue;
            }
            const outcome = yield* (units.length > 1 ? isolate(job.execute) : job.execute).pipe(
              Effect.exit,
            );
            outcomes.set(job, outcome);
            if (Exit.isFailure(outcome)) {
              job.stream.owner.active = false;
              if (units.length === 1) return yield* Effect.failCause(outcome.cause);
            }
          }
        });
        const exit = yield* restore(
          commit(work).pipe(Effect.provideService(CurrentWorker, yield* Effect.fiberId)),
        ).pipe(Effect.exit);
        const committed = taken === 0 ? units : units.slice(0, taken);
        const jobs = committed.flatMap((unit) => [unit.job, ...unit.superseded]);
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.work_item_count": committed.length,
          "orchestration_v2.coalesced_work_item_count": jobs.length - committed.length,
          "orchestration_v2.deferred_work_item_count": units.length - committed.length,
          "orchestration_v2.consumer_count": new Set(jobs.map((job) => job.stream)).size,
          "orchestration_v2.raw_json_bytes": jobs.reduce((bytes, job) => bytes + job.bytes, 0),
          "orchestration_v2.batch_flush_reason": reason,
          "orchestration_v2.backlog_batching": true,
          "orchestration_v2.batch_wait_ms":
            (yield* Clock.currentTimeMillis) - Math.min(...jobs.map((job) => job.queuedAt)),
        });
        for (const { job, superseded } of committed) {
          const outcome = outcomes.get(job) ?? Exit.void;
          const final = Exit.isSuccess(exit) ? outcome : exit;
          yield* job.settle(
            final,
            Exit.isSuccess(exit) ||
              (Exit.isFailure(exit) &&
                Exit.isFailure(outcome) &&
                Cause.squash(exit.cause) === Cause.squash(outcome.cause)),
          );
          for (const replaced of superseded) yield* replaced.skip(final);
        }
        return committed.length;
      }),
    ).pipe(Effect.withSpan("orchestrationV2.ProviderCommitBatch.flush"));
  if (enabled) {
    yield* Effect.forever(
      Effect.gen(function* () {
        const batch = nextBatch(yield* Clock.currentTimeMillis);
        if (batch === undefined) return yield* Queue.take(wake);
        yield* backlog.release(batch.dequeued);
        let units = batch.units;
        while (units.length > 0) units = units.slice(yield* commitPrefix(units, batch.reason));
      }),
    ).pipe(Effect.ensuring(shutdown), Effect.forkScoped);
  }
  /**
   * Runs `effect` after queued snapshots for `threadIds` commit; omitted, after every queued
   * snapshot. Other threads' snapshots never delay it.
   */
  const barrier = Effect.fnUntraced(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    threadIds?: ReadonlyArray<string>,
  ) {
    if (closed) return yield* Effect.interrupt;
    if (!enabled || (yield* CurrentWorker) === (yield* Effect.fiberId)) return yield* effect;
    const jobs: ReadonlySet<Job> = new Set(
      Array.from(pending).filter(
        (job) => threadIds === undefined || threadIds.includes(job.threadId),
      ),
    );
    return yield* Effect.uninterruptibleMask((restore) => {
      waitingWrites.add(jobs);
      return restore(
        Effect.gen(function* () {
          for (const job of jobs) yield* job.settled;
          if (closed) return yield* Effect.interrupt;
          return yield* effect;
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            waitingWrites.delete(jobs);
          }),
        ),
      );
    });
  });
  const consume = Effect.fnUntraced(function* <A extends { readonly type: string }, E, R, E2, R2>(
    source: Stream.Stream<A, E, R>,
    process: (event: A) => Effect.Effect<void, E2, R2>,
    after: Effect.Effect<boolean, E2, R2>,
    canBatch: Effect.Effect<boolean, never, R2> = Effect.succeed(true),
    priority?: StreamPriority,
  ) {
    if (!enabled)
      return yield* source.pipe(
        Stream.mapEffect((event) => process(event).pipe(Effect.andThen(after))),
        Stream.takeUntil(Boolean),
        Stream.runDrain,
      );
    const stream: StreamState = {
      owner: { active: true },
      priority,
      jobs: [],
      unsettled: 0,
      servedAt: 0,
      finishing: false,
    };
    streams.add(stream);
    const signals = source.pipe(
      Stream.map((event) => ({ _tag: "Event" as const, event })),
      Stream.catchCause((cause) => Stream.succeed({ _tag: "Failure" as const, cause })),
      Stream.concat(Stream.succeed({ _tag: "End" as const })),
    );
    let resume: Effect.Effect<void> = Effect.void;
    // Replies run in order, so EOF, failures and controls follow this stream's earlier snapshots
    // without waiting for other streams' work.
    yield* signals.pipe(
      Stream.mapEffect((signal) =>
        Effect.gen(function* () {
          yield* resume;
          const processed = yield* Deferred.make<void>();
          let reply: Effect.Effect<boolean, E | E2 | CommitBatchError, R2>;
          let check = false;
          const snapshot =
            signal._tag === "Event" && isSnapshot(signal.event) && (yield* canBatch)
              ? signal.event
              : undefined;
          if (snapshot !== undefined) {
            const bytes = Buffer.byteLength(yield* encodeQueue(snapshot));
            reply = yield* enqueue(
              process(snapshot).pipe(Effect.as(false)),
              stream,
              snapshotEntity(snapshot),
              bytes,
              false,
            );
          } else {
            if (stream.unsettled > 0) stream.finishing = true;
            if (signal._tag === "End") reply = Effect.succeed(true);
            else if (signal._tag === "Failure") reply = Effect.failCause(signal.cause);
            else {
              const event = signal.event;
              reply = Effect.sync(() => {
                stream.finishing = false;
              }).pipe(Effect.andThen(process(event)), Effect.as(false));
              check = true;
              resume = Deferred.await(processed);
            }
          }
          return { reply, processed, check };
        }),
      ),
      Stream.buffer({ capacity: MAX_EVENTS }),
      Stream.mapEffect(({ reply, processed, check }) =>
        reply.pipe(
          Effect.flatMap((end) =>
            end ? Effect.succeed(true) : check ? after : Effect.succeed(false),
          ),
          Effect.tap((stop) =>
            Effect.sync(() => {
              if (stop) stream.owner.active = false;
            }),
          ),
          Effect.ensuring(Deferred.succeed(processed, undefined)),
        ),
      ),
      Stream.takeUntil(Boolean),
      Stream.runDrain,
      Effect.ensuring(
        Effect.gen(function* () {
          stream.owner.active = false;
          streams.delete(stream);
          for (const job of stream.jobs.splice(0)) yield* job.cancel;
        }),
      ),
    );
  });
  return { barrier, consume };
});
