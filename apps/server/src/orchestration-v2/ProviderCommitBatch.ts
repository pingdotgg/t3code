import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

const MAX_EVENTS = 64;
const MAX_BYTES = 1024 * 1024;
const encodeQueue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const windowMs = Config.String("T3CODE_EXPERIMENTAL_COMMIT_WINDOW_MS").pipe(
  Config.withDefault("0"),
  Effect.map((raw) => {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? Math.min(value, 25) : 0;
  }),
  Effect.orDie,
);

type Event = ProviderAdapter.ProviderAdapterV2Event;
interface Batch<T = Event> {
  readonly events: ReadonlyArray<T>;
  readonly bytes: number;
  readonly openedAt: number;
  readonly reason: "deadline" | "limit" | "control" | "end" | "failure";
}

const isSnapshot = (event: Event) =>
  event.type === "node.updated" ||
  event.type === "message.updated" ||
  event.type === "turn_item.updated" ||
  event.type === "plan.updated";

export function group<E, R>(source: Stream.Stream<Event, E, R>, window: number) {
  if (window === 0)
    return source.pipe(
      Stream.map((event): Batch => ({ events: [event], bytes: 0, openedAt: 0, reason: "control" })),
    );
  return collect(source, window, (event) =>
    (isSnapshot(event)
      ? encodeQueue(event).pipe(Effect.map(Buffer.byteLength))
      : Effect.succeed(0)
    ).pipe(Effect.map((bytes) => ({ snapshot: isSnapshot(event), bytes }))),
  );
}

function collect<T, E, R>(
  source: Stream.Stream<T, E, R>,
  window: number,
  describe: (item: T) => Effect.Effect<{ snapshot: boolean; bytes: number }, Schema.SchemaError>,
) {
  type Signal =
    | {
        readonly _tag: "Event";
        readonly event: T;
        readonly bytes: number;
        readonly snapshot: boolean;
      }
    | { readonly _tag: "Failure"; readonly cause: Cause.Cause<E | Schema.SchemaError> }
    | { readonly _tag: "End" };
  const signals = source.pipe(
    Stream.mapEffect((event) =>
      describe(event).pipe(
        Effect.map((description): Signal => ({ _tag: "Event", event, ...description })),
      ),
    ),
    // A failed source must not discard the prefix already collected by the sink.
    Stream.catchCause((cause) => Stream.succeed<Signal>({ _tag: "Failure", cause })),
    Stream.concat(Stream.succeed<Signal>({ _tag: "End" })),
  );
  const collect = Sink.fold(
    () => ({ signals: [] as Array<Signal>, bytes: 0, openedAt: 0, stop: false }),
    (state) => !state.stop,
    (state, signal: Signal) =>
      Effect.gen(function* () {
        if (state.signals.length === 0) state.openedAt = yield* Clock.currentTimeMillis;
        state.signals.push(signal);
        if (signal._tag === "Event") state.bytes += signal.bytes;
        state.stop =
          signal._tag !== "Event" ||
          !signal.snapshot ||
          state.signals.length >= MAX_EVENTS ||
          state.bytes >= MAX_BYTES;
        return state;
      }),
  );
  return signals.pipe(
    Stream.aggregateWithin(collect, Schedule.spaced(window)),
    Stream.flatMap((state) => {
      const groups: Array<Batch<T> | Extract<Signal, { _tag: "Failure" }>> = [];
      let events: Array<T> = [];
      let bytes = 0;
      const flush = (reason: Batch["reason"]) => {
        if (events.length === 0) return;
        groups.push({ events, bytes, openedAt: state.openedAt, reason });
        events = [];
        bytes = 0;
      };
      for (const signal of state.signals) {
        if (signal._tag === "Failure") {
          flush("failure");
          groups.push(signal);
        } else if (signal._tag === "End") flush("end");
        else if (!signal.snapshot) {
          flush("control");
          groups.push({
            events: [signal.event],
            bytes: signal.bytes,
            openedAt: state.openedAt,
            reason: "control",
          });
        } else {
          if (bytes + signal.bytes > MAX_BYTES) flush("limit");
          events.push(signal.event);
          bytes += signal.bytes;
          if (bytes >= MAX_BYTES || events.length >= MAX_EVENTS) flush("limit");
        }
      }
      flush("deadline");
      return Stream.fromArray(groups).pipe(
        Stream.mapEffect((batch) =>
          "_tag" in batch ? Effect.failCause(batch.cause) : Effect.succeed(batch),
        ),
      );
    }),
  );
}

export class CommitBatchError extends Schema.TaggedError<CommitBatchError>()("CommitBatchError", {
  cause: Schema.Defect(),
}) {}

interface Job {
  readonly owner: object;
  readonly queuedAt: number;
  readonly snapshot: boolean;
  readonly bytes: number;
  readonly active: () => boolean;
  readonly execute: Effect.Effect<void, CommitBatchError>;
  readonly settle: (exit: Exit.Exit<void, CommitBatchError>) => Effect.Effect<void>;
  readonly cancel: Effect.Effect<void>;
}
const CurrentWorker = Context.Reference<number | undefined>(
  "t3/ProviderCommitBatch/CurrentWorker",
  {
    defaultValue: () => undefined,
  },
);

export const make = Effect.fn("ProviderCommitBatch.make")(function* (
  commit: (work: Effect.Effect<void, CommitBatchError>) => Effect.Effect<void, CommitBatchError>,
  window: number,
) {
  const queue = yield* Queue.bounded<Job>(MAX_EVENTS);
  const pending = new Set<Job>();
  const shutdown = Effect.gen(function* () {
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
    const reply = yield* Deferred.make<A, CommitBatchError>();
    let result: A;
    const job: Job = {
      owner: token,
      queuedAt: yield* Clock.currentTimeMillis,
      snapshot,
      bytes,
      active: () => token.active,
      execute: effect.pipe(
        Effect.mapError((cause) => new CommitBatchError({ cause })),
        Effect.provideContext(caller),
        Effect.tap((value) =>
          Effect.sync(() => {
            result = value;
          }),
        ),
        Effect.asVoid,
      ),
      settle: Effect.fnUntraced(function* (exit: Exit.Exit<void, CommitBatchError>) {
        pending.delete(job);
        if (Exit.isFailure(exit)) {
          token.active = false;
          yield* Deferred.failCause(reply, exit.cause);
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
  if (window > 0) {
    yield* collect(Stream.fromQueue(queue), window, (job) =>
      Effect.succeed({ snapshot: job.snapshot, bytes: job.bytes }),
    ).pipe(
      Stream.runForEach((batch) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const jobs = batch.events.filter((job) => job.active());
            for (const job of batch.events) if (!job.active()) yield* job.cancel;
            if (jobs.length === 0) return;
            yield* Effect.annotateCurrentSpan({
              "orchestration_v2.work_item_count": jobs.length,
              "orchestration_v2.consumer_count": new Set(jobs.map((job) => job.owner)).size,
              "orchestration_v2.raw_json_bytes": batch.bytes,
              "orchestration_v2.batch_flush_reason": batch.reason,
              "orchestration_v2.commit_window_ms": window,
              "orchestration_v2.batch_wait_ms":
                (yield* Clock.currentTimeMillis) - Math.min(...jobs.map((job) => job.queuedAt)),
            });
            const work = Effect.forEach(jobs, (job) => (job.active() ? job.execute : job.cancel), {
              discard: true,
            });
            const exit = yield* restore(
              (batch.reason === "control" && jobs.length === 1 && !jobs[0]!.snapshot
                ? work
                : commit(work)
              ).pipe(Effect.provideService(CurrentWorker, yield* Effect.fiberId)),
            ).pipe(Effect.exit);
            for (const job of jobs) yield* job.settle(exit);
          }),
        ).pipe(Effect.withSpan("orchestrationV2.ProviderCommitBatch.flush")),
      ),
      Effect.ensuring(shutdown),
      Effect.forkScoped,
    );
  }
  const barrier = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    if (window === 0 || (yield* CurrentWorker) === (yield* Effect.fiberId)) return yield* effect;
    const token = { active: true };
    return yield* Effect.gen(function* () {
      const exit = yield* enqueue(Effect.exit(effect), token, false, 0).pipe(
        Effect.flatten,
        Effect.orDie,
      );
      return yield* exit;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          token.active = false;
        }),
      ),
    );
  });
  const consume = Effect.fnUntraced(function* <E, R, E2, R2>(
    source: Stream.Stream<Event, E, R>,
    process: (event: Event) => Effect.Effect<void, E2, R2>,
    after: Effect.Effect<boolean, E2, R2>,
    canBatch: Effect.Effect<boolean, never, R2> = Effect.succeed(true),
  ) {
    if (window === 0)
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
          const reply = yield* enqueue(work, token, snapshot, bytes);
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
