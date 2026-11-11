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
const encodeQueue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const enabled = Config.Boolean("T3CODE_PROVIDER_COMMIT_BATCHING").pipe(
  Config.withDefault(true),
  Effect.orDie,
);

const isSnapshot = (event: { readonly type: string }) =>
  event.type === "node.updated" ||
  event.type === "message.updated" ||
  event.type === "turn_item.updated" ||
  event.type === "plan.updated";

export class CommitBatchError extends Schema.TaggedError<CommitBatchError>()("CommitBatchError", {
  cause: Schema.Defect(),
}) {}
export const isCommitBatchError = Schema.is(CommitBatchError);

interface Job {
  readonly owner: { active: boolean };
  readonly queuedAt: number;
  readonly snapshot: boolean;
  readonly bytes: number;
  readonly execute: Effect.Effect<void, CommitBatchError>;
  readonly settle: (
    exit: Exit.Exit<void, CommitBatchError>,
    preserveFailure: boolean,
  ) => Effect.Effect<void>;
  readonly cancel: Effect.Effect<void>;
}
interface Batch {
  readonly events: ReadonlyArray<Job>;
  readonly bytes: number;
  readonly reason: "ready" | "limit" | "control";
}

function collect(queue: Queue.Queue<Job>) {
  return Stream.fromEffectRepeat(Queue.takeBetween(queue, 1, MAX_EVENTS)).pipe(
    Stream.flatMap((ready) => {
      const batches: Array<Batch> = [];
      let events: Array<Job> = [];
      let bytes = 0;
      const flush = (reason: Batch["reason"]) => {
        if (events.length > 0) batches.push({ events, bytes, reason });
        events = [];
        bytes = 0;
      };
      for (const job of ready) {
        if (!job.snapshot) {
          flush("control");
          batches.push({ events: [job], bytes: 0, reason: "control" });
        } else {
          if (events.length > 0 && bytes + job.bytes > MAX_BYTES) flush("limit");
          events.push(job);
          bytes += job.bytes;
          if (events.length >= MAX_EVENTS || bytes >= MAX_BYTES) flush("limit");
        }
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
    snapshot: boolean,
    bytes: number,
  ) {
    const caller = yield* Effect.context<R>();
    const reply = yield* Deferred.make<A, E | CommitBatchError>();
    let ownFailure: Cause.Cause<E> | undefined;
    let result: A;
    const job: Job = {
      owner: token,
      queuedAt: yield* Clock.currentTimeMillis,
      snapshot,
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
  if (enabled) {
    yield* collect(queue).pipe(
      Stream.runForEach((batch) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const jobs = batch.events.filter((job) => job.owner.active);
            for (const job of batch.events) if (!job.owner.active) yield* job.cancel;
            if (jobs.length === 0) return;
            yield* Effect.annotateCurrentSpan({
              "orchestration_v2.work_item_count": jobs.length,
              "orchestration_v2.consumer_count": new Set(jobs.map((job) => job.owner)).size,
              "orchestration_v2.raw_json_bytes": batch.bytes,
              "orchestration_v2.batch_flush_reason": batch.reason,
              "orchestration_v2.backlog_batching": true,
              "orchestration_v2.batch_wait_ms":
                (yield* Clock.currentTimeMillis) - Math.min(...jobs.map((job) => job.queuedAt)),
            });
            const outcomes = new Map<Job, Exit.Exit<void, CommitBatchError>>();
            const work = Effect.forEach(
              jobs,
              (job) =>
                Effect.gen(function* () {
                  if (!job.owner.active) return yield* job.cancel;
                  const outcome = yield* (
                    jobs.length > 1 && job.bytes > 0 ? isolate(job.execute) : job.execute
                  ).pipe(Effect.exit);
                  outcomes.set(job, outcome);
                  if (Exit.isFailure(outcome)) {
                    job.owner.active = false;
                    if (jobs.length === 1) return yield* Effect.failCause(outcome.cause);
                  }
                }),
              { discard: true },
            );
            const exit = yield* restore(
              (jobs.every((job) => job.bytes === 0) ? work : commit(work)).pipe(
                Effect.provideService(CurrentWorker, yield* Effect.fiberId),
              ),
            ).pipe(Effect.exit);
            for (const job of jobs) {
              const outcome = outcomes.get(job) ?? Exit.void;
              yield* job.settle(
                Exit.isSuccess(exit) ? outcome : exit,
                Exit.isSuccess(exit) ||
                  (Exit.isFailure(exit) &&
                    Exit.isFailure(outcome) &&
                    Cause.squash(exit.cause) === Cause.squash(outcome.cause)),
              );
            }
          }),
        ).pipe(Effect.withSpan("orchestrationV2.ProviderCommitBatch.flush")),
      ),
      Effect.ensuring(shutdown),
      Effect.forkScoped,
    );
  }
  const barrier = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    if (closed) return yield* Effect.interrupt;
    if (!enabled || pending.size === 0 || (yield* CurrentWorker) === (yield* Effect.fiberId))
      return yield* effect;
    const token = { active: true };
    return yield* enqueue(Effect.exit(effect), token, false, 0).pipe(
      Effect.flatten,
      Effect.orDie,
      Effect.flatten,
      Effect.ensuring(
        Effect.sync(() => {
          token.active = false;
        }),
      ),
    );
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
    yield* signals.pipe(
      Stream.mapEffect((signal) =>
        Effect.gen(function* () {
          yield* resume;
          const processed = yield* Deferred.make<void>();
          const event = signal._tag === "Event" ? signal.event : undefined;
          // EOF only acknowledges prior work; it can share a commit with other consumers.
          const snapshot =
            signal._tag === "End" ||
            (event !== undefined && isSnapshot(event) && (yield* canBatch));
          const bytes =
            snapshot && event !== undefined ? Buffer.byteLength(yield* encodeQueue(event)) : 0;
          const work: Effect.Effect<boolean, E | E2, R2> =
            signal._tag === "Failure"
              ? Effect.failCause(signal.cause)
              : event === undefined
                ? Effect.succeed(true)
                : process(event).pipe(Effect.as(false));
          const reply = snapshot
            ? yield* enqueue(work, token, true, bytes)
            : (yield* enqueue(Effect.void, token, false, 0)).pipe(Effect.andThen(work));
          if (!snapshot) resume = Deferred.await(processed);
          return { reply, processed, check: !snapshot };
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
