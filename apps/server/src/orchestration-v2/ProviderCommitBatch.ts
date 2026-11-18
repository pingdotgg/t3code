import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const MAX_EVENTS = 64;
const MAX_BYTES = 1024 * 1024;
// While another write waits, a shared transaction stops taking jobs after this long.
const MAX_HOLD_MILLIS = 100;
const encodeQueue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const enabled = Config.Boolean("T3CODE_PROVIDER_COMMIT_BATCHING").pipe(
  Config.withDefault(true),
  Effect.orDie,
);

type Snapshot =
  | { readonly type: "node.updated"; readonly node: { readonly threadId: string } }
  | { readonly type: "message.updated"; readonly message: { readonly threadId: string } }
  | { readonly type: "turn_item.updated"; readonly turnItem: { readonly threadId: string } }
  | { readonly type: "plan.updated"; readonly plan: { readonly threadId: string } };
const isSnapshot = (event: { readonly type: string }): event is Snapshot =>
  event.type === "node.updated" ||
  event.type === "message.updated" ||
  event.type === "turn_item.updated" ||
  event.type === "plan.updated";
const snapshotThreadId = (event: Snapshot) => {
  switch (event.type) {
    case "node.updated":
      return event.node.threadId;
    case "message.updated":
      return event.message.threadId;
    case "turn_item.updated":
      return event.turnItem.threadId;
    case "plan.updated":
      return event.plan.threadId;
  }
};

export class CommitBatchError extends Schema.TaggedError<CommitBatchError>()("CommitBatchError", {
  cause: Schema.Defect(),
}) {}
export const isCommitBatchError = Schema.is(CommitBatchError);

interface Job {
  readonly owner: { active: boolean };
  readonly threadId: string;
  readonly queuedAt: number;
  readonly bytes: number;
  readonly execute: Effect.Effect<void, CommitBatchError>;
  readonly settle: (
    exit: Exit.Exit<void, CommitBatchError>,
    preserveFailure: boolean,
  ) => Effect.Effect<void>;
  readonly cancel: Effect.Effect<void>;
  readonly settled: Effect.Effect<void>;
}
interface Batch {
  readonly events: ReadonlyArray<Job>;
  readonly reason: "ready" | "limit";
}

function collect(queue: Queue.Queue<Job>) {
  return Stream.fromEffectRepeat(Queue.takeBetween(queue, 1, MAX_EVENTS)).pipe(
    Stream.flatMap((ready) => {
      const batches: Array<Batch> = [];
      let events: Array<Job> = [];
      let bytes = 0;
      const flush = (reason: Batch["reason"]) => {
        if (events.length > 0) batches.push({ events, reason });
        events = [];
        bytes = 0;
      };
      for (const job of ready) {
        if (events.length > 0 && bytes + job.bytes > MAX_BYTES) flush("limit");
        events.push(job);
        bytes += job.bytes;
        if (events.length >= MAX_EVENTS || bytes >= MAX_BYTES) flush("limit");
      }
      flush("ready");
      return Stream.fromArray(batches);
    }),
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
) {
  const queue = yield* Queue.bounded<Job>(MAX_EVENTS);
  const pending = new Set<Job>();
  let closed = false;
  // Writes released by `barrier` that have not finished; they wait on the writer a batch holds.
  let waitingWriters = 0;
  const shutdown = Effect.gen(function* () {
    closed = true;
    yield* Queue.shutdown(queue);
    for (const job of pending) yield* job.cancel;
  });
  yield* Effect.addFinalizer(() => shutdown);
  // These helpers run once per raw event; the shared transaction owns the tracing span.
  const enqueue = Effect.fnUntraced(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    token: { active: boolean },
    threadId: string,
    bytes: number,
  ) {
    const caller = yield* Effect.context<R>();
    const reply = yield* Deferred.make<A, E | CommitBatchError>();
    let ownFailure: Cause.Cause<E> | undefined;
    let result: A;
    const job: Job = {
      owner: token,
      threadId,
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
        pending.delete(job);
        if (Exit.isFailure(exit)) {
          token.active = false;
          yield* Deferred.failCause(
            reply,
            preserveFailure && ownFailure !== undefined ? ownFailure : exit.cause,
          );
        } else yield* Deferred.succeed(reply, result);
      }),
      cancel: Effect.gen(function* () {
        pending.delete(job);
        yield* Deferred.interrupt(reply);
      }),
      settled: Deferred.await(reply).pipe(Effect.exit, Effect.asVoid),
    };
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        pending.add(job);
        const accepted = yield* restore(Queue.offer(queue, job)).pipe(
          Effect.onError(() => job.cancel),
        );
        if (!accepted) yield* job.cancel;
      }),
    );
    return Deferred.await(reply);
  });
  // Commits a prefix of `jobs` in one transaction and returns how many it took.
  const commitPrefix = (jobs: ReadonlyArray<Job>, reason: Batch["reason"]) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const outcomes = new Map<Job, Exit.Exit<void, CommitBatchError>>();
        let taken = 0;
        const work = Effect.gen(function* () {
          // A retried transaction runs this again from the first job.
          outcomes.clear();
          taken = 0;
          const startedAt = yield* Clock.currentTimeMillis;
          for (const job of jobs) {
            if (
              taken > 0 &&
              waitingWriters > 0 &&
              (yield* Clock.currentTimeMillis) - startedAt >= MAX_HOLD_MILLIS
            )
              return;
            taken++;
            if (!job.owner.active) {
              yield* job.cancel;
              continue;
            }
            const outcome = yield* (jobs.length > 1 ? isolate(job.execute) : job.execute).pipe(
              Effect.exit,
            );
            outcomes.set(job, outcome);
            if (Exit.isFailure(outcome)) {
              job.owner.active = false;
              if (jobs.length === 1) return yield* Effect.failCause(outcome.cause);
            }
          }
        });
        const exit = yield* restore(
          commit(work).pipe(Effect.provideService(CurrentWorker, yield* Effect.fiberId)),
        ).pipe(Effect.exit);
        const committed = taken === 0 ? jobs : jobs.slice(0, taken);
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.work_item_count": committed.length,
          "orchestration_v2.deferred_work_item_count": jobs.length - committed.length,
          "orchestration_v2.consumer_count": new Set(committed.map((job) => job.owner)).size,
          "orchestration_v2.raw_json_bytes": committed.reduce((bytes, job) => bytes + job.bytes, 0),
          "orchestration_v2.batch_flush_reason": reason,
          "orchestration_v2.backlog_batching": true,
          "orchestration_v2.batch_wait_ms":
            (yield* Clock.currentTimeMillis) - Math.min(...committed.map((job) => job.queuedAt)),
        });
        for (const job of committed) {
          const outcome = outcomes.get(job) ?? Exit.void;
          yield* job.settle(
            Exit.isSuccess(exit) ? outcome : exit,
            Exit.isSuccess(exit) ||
              (Exit.isFailure(exit) &&
                Exit.isFailure(outcome) &&
                Cause.squash(exit.cause) === Cause.squash(outcome.cause)),
          );
        }
        return committed.length;
      }),
    ).pipe(Effect.withSpan("orchestrationV2.ProviderCommitBatch.flush"));
  if (enabled) {
    yield* collect(queue).pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (batch: Batch) {
          let jobs = batch.events;
          while (jobs.length > 0) {
            for (const job of jobs) if (!job.owner.active) yield* job.cancel;
            jobs = jobs.filter((job) => job.owner.active);
            if (jobs.length === 0) return;
            jobs = jobs.slice(yield* commitPrefix(jobs, batch.reason));
          }
        }),
      ),
      Effect.ensuring(shutdown),
      Effect.forkScoped,
    );
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
    for (const job of Array.from(pending)) {
      if (threadIds === undefined || threadIds.includes(job.threadId)) yield* job.settled;
    }
    if (closed) return yield* Effect.interrupt;
    return yield* Effect.uninterruptibleMask((restore) => {
      waitingWriters++;
      return restore(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            waitingWriters--;
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
  ) {
    if (!enabled)
      return yield* source.pipe(
        Stream.mapEffect((event) => process(event).pipe(Effect.andThen(after))),
        Stream.takeUntil(Boolean),
        Stream.runDrain,
      );
    const token = { active: true };
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
          if (signal._tag === "End") reply = Effect.succeed(true);
          else if (signal._tag === "Failure") reply = Effect.failCause(signal.cause);
          else if (isSnapshot(signal.event) && (yield* canBatch)) {
            const bytes = Buffer.byteLength(yield* encodeQueue(signal.event));
            reply = yield* enqueue(
              process(signal.event).pipe(Effect.as(false)),
              token,
              snapshotThreadId(signal.event),
              bytes,
            );
          } else {
            reply = process(signal.event).pipe(Effect.as(false));
            check = true;
            resume = Deferred.await(processed);
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
              if (stop) token.active = false;
            }),
          ),
          Effect.ensuring(Deferred.succeed(processed, undefined)),
        ),
      ),
      Stream.takeUntil(Boolean),
      Stream.runDrain,
      Effect.ensuring(
        Effect.sync(() => {
          token.active = false;
        }),
      ),
    );
  });
  return { barrier, consume };
});
