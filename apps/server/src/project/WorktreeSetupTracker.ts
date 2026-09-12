import type {
  ThreadId,
  WorktreeSetupSnapshot,
  WorktreeSetupStage,
  WorktreeSetupStageId,
  WorktreeSetupStageStatus,
} from "@t3tools/contracts";
import { WORKTREE_SETUP_STAGE_ORDER } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/**
 * Tracks the live stages of a bootstrap worktree setup per thread so clients
 * can render a progress card while the first turn is still being prepared.
 *
 * State is memory only. It exists from the first `begin` until the turn starts
 * or the setup fails, plus a short grace window so a client that subscribes
 * late still sees the final state. Nothing here is persisted or event-sourced:
 * the durable record of a setup is the thread's worktree path and the setup
 * script activities, both of which already exist.
 */
export class WorktreeSetupTracker extends Context.Service<
  WorktreeSetupTracker,
  {
    /** Creates a fresh running snapshot for the thread, replacing any prior one. */
    readonly begin: (input: {
      readonly threadId: ThreadId;
      readonly branch: string | null;
      readonly baseRef: string | null;
      readonly stages: ReadonlyArray<WorktreeSetupStageId>;
      /** Interrupting this fiber cancels the bootstrap. */
      readonly fiber: Fiber.Fiber<unknown, unknown> | null;
    }) => Effect.Effect<void>;
    readonly update: (
      threadId: ThreadId,
      mutate: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
    ) => Effect.Effect<void>;
    readonly stage: (
      threadId: ThreadId,
      stageId: WorktreeSetupStageId,
      patch: Partial<Omit<WorktreeSetupStage, "id">>,
    ) => Effect.Effect<void>;
    readonly stageStatus: (
      threadId: ThreadId,
      stageId: WorktreeSetupStageId,
      status: WorktreeSetupStageStatus,
      detail?: string | null,
    ) => Effect.Effect<void>;
    readonly appendTail: (
      threadId: ThreadId,
      stageId: WorktreeSetupStageId,
      line: string,
    ) => Effect.Effect<void>;
    readonly finish: (
      threadId: ThreadId,
      phase: "done" | "failed" | "cancelled",
      error?: string | null,
    ) => Effect.Effect<void>;
    /** Interrupts the running bootstrap. Returns false when nothing is running. */
    readonly cancel: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly get: (threadId: ThreadId) => Effect.Effect<WorktreeSetupSnapshot | null>;
    /** Emits the current snapshot (or null) first, then every change until unsubscribed. */
    readonly stream: (threadId: ThreadId) => Stream.Stream<WorktreeSetupSnapshot | null>;
  }
>()("t3/project/WorktreeSetupTracker") {}

const TAIL_LINE_LIMIT = 4;
/** Finished snapshots stay visible this long so a late subscriber sees the outcome. */
const FINISHED_RETENTION = "30 seconds";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface TrackedSetup {
  readonly snapshot: WorktreeSetupSnapshot;
  readonly fiber: Fiber.Fiber<unknown, unknown> | null;
}

function emptyStage(id: WorktreeSetupStageId): WorktreeSetupStage {
  return {
    id,
    status: "pending",
    startedAt: null,
    endedAt: null,
    percent: null,
    detail: null,
    tail: [],
  };
}

export const make = Effect.gen(function* () {
  const setups = yield* Ref.make(new Map<ThreadId, TrackedSetup>());
  const changes = yield* PubSub.unbounded<{
    readonly threadId: ThreadId;
    readonly snapshot: WorktreeSetupSnapshot | null;
  }>();
  const retentionFibers = new Map<ThreadId, Fiber.Fiber<void, never>>();

  const publish = (threadId: ThreadId, snapshot: WorktreeSetupSnapshot | null) =>
    PubSub.publish(changes, { threadId, snapshot }).pipe(Effect.asVoid);

  const modify = (
    threadId: ThreadId,
    mutate: (tracked: TrackedSetup) => TrackedSetup,
  ): Effect.Effect<WorktreeSetupSnapshot | null> =>
    Ref.modify(setups, (current) => {
      const existing = current.get(threadId);
      if (!existing) return [null, current] as const;
      const nextTracked = mutate(existing);
      const nextSnapshot = {
        ...nextTracked.snapshot,
        sequence: existing.snapshot.sequence + 1,
      };
      const next = new Map(current);
      next.set(threadId, { ...nextTracked, snapshot: nextSnapshot });
      return [nextSnapshot, next] as const;
    }).pipe(Effect.tap((snapshot) => (snapshot ? publish(threadId, snapshot) : Effect.void)));

  const clearRetention = (threadId: ThreadId) => {
    const fiber = retentionFibers.get(threadId);
    retentionFibers.delete(threadId);
    return fiber ? Fiber.interrupt(fiber).pipe(Effect.ignore) : Effect.void;
  };

  const remove = (threadId: ThreadId) =>
    Ref.update(setups, (current) => {
      if (!current.has(threadId)) return current;
      const next = new Map(current);
      next.delete(threadId);
      return next;
    }).pipe(Effect.andThen(publish(threadId, null)));

  const begin: WorktreeSetupTracker["Service"]["begin"] = (input) =>
    Effect.gen(function* () {
      yield* clearRetention(input.threadId);
      const startedAt = yield* nowIso;
      const ordered = WORKTREE_SETUP_STAGE_ORDER.filter((id) => input.stages.includes(id));
      const snapshot: WorktreeSetupSnapshot = {
        threadId: input.threadId,
        phase: "running",
        startedAt,
        endedAt: null,
        branch: input.branch,
        baseRef: input.baseRef,
        worktreePath: null,
        setupScript: null,
        stages: ordered.map(emptyStage),
        error: null,
        sequence: 0,
      };
      yield* Ref.update(setups, (current) => {
        const next = new Map(current);
        next.set(input.threadId, { snapshot, fiber: input.fiber });
        return next;
      });
      yield* publish(input.threadId, snapshot);
    });

  const update: WorktreeSetupTracker["Service"]["update"] = (threadId, mutate) =>
    modify(threadId, (tracked) => ({ ...tracked, snapshot: mutate(tracked.snapshot) })).pipe(
      Effect.asVoid,
    );

  const stage: WorktreeSetupTracker["Service"]["stage"] = (threadId, stageId, patch) =>
    update(threadId, (snapshot) => ({
      ...snapshot,
      stages: snapshot.stages.map((entry) =>
        entry.id === stageId ? { ...entry, ...patch } : entry,
      ),
    }));

  const stageStatus: WorktreeSetupTracker["Service"]["stageStatus"] = (
    threadId,
    stageId,
    status,
    detail,
  ) =>
    nowIso.pipe(
      Effect.flatMap((at) =>
        update(threadId, (snapshot) => ({
          ...snapshot,
          stages: snapshot.stages.map((entry) => {
            if (entry.id !== stageId) return entry;
            const startedAt = entry.startedAt ?? (status === "pending" ? null : at);
            const endedAt =
              status === "running" || status === "pending" ? null : (entry.endedAt ?? at);
            return {
              ...entry,
              status,
              startedAt,
              endedAt,
              ...(detail === undefined ? {} : { detail }),
            };
          }),
        })),
      ),
    );

  const appendTail: WorktreeSetupTracker["Service"]["appendTail"] = (threadId, stageId, line) =>
    update(threadId, (snapshot) => ({
      ...snapshot,
      stages: snapshot.stages.map((entry) =>
        entry.id === stageId
          ? { ...entry, tail: [...entry.tail, line.slice(0, 400)].slice(-TAIL_LINE_LIMIT) }
          : entry,
      ),
    }));

  const finish: WorktreeSetupTracker["Service"]["finish"] = (threadId, phase, error) =>
    Effect.gen(function* () {
      const endedAt = yield* nowIso;
      const snapshot = yield* modify(threadId, (tracked) => ({
        fiber: null,
        snapshot: {
          ...tracked.snapshot,
          phase,
          endedAt,
          error: error ?? null,
          stages: tracked.snapshot.stages.map((entry) =>
            entry.status === "running"
              ? {
                  ...entry,
                  status: phase === "done" ? "done" : phase === "cancelled" ? "skipped" : "failed",
                  endedAt,
                }
              : entry,
          ),
        },
      }));
      if (!snapshot) return;
      yield* clearRetention(threadId);
      const fiber = yield* remove(threadId).pipe(
        Effect.delay(FINISHED_RETENTION),
        Effect.forkDetach,
      );
      retentionFibers.set(threadId, fiber);
    });

  const cancel: WorktreeSetupTracker["Service"]["cancel"] = (threadId) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(setups);
      const tracked = current.get(threadId);
      if (!tracked || tracked.snapshot.phase !== "running" || !tracked.fiber) {
        return false;
      }
      yield* Fiber.interrupt(tracked.fiber).pipe(Effect.forkDetach);
      return true;
    });

  const get: WorktreeSetupTracker["Service"]["get"] = (threadId) =>
    Ref.get(setups).pipe(Effect.map((current) => current.get(threadId)?.snapshot ?? null));

  const stream: WorktreeSetupTracker["Service"]["stream"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const initial = yield* get(threadId);
        return Stream.concat(
          Stream.make(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.threadId === threadId),
            Stream.map((change) => change.snapshot),
          ),
        );
      }),
    );

  return WorktreeSetupTracker.of({
    begin,
    update,
    stage,
    stageStatus,
    appendTail,
    finish,
    cancel,
    get,
    stream,
  });
});

export const layer = Layer.effect(WorktreeSetupTracker, make);
