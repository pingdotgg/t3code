import type {
  OrchestrationCommand,
  ProjectCloneSnapshot,
  ProjectCloneStage,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectId,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import {
  OrchestrationDispatchCommandError,
  PROJECT_CLONE_DETAIL_MAX_LENGTH,
  PROJECT_CLONE_ERROR_MAX_LENGTH,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";

/**
 * Runs repository clones that back newly added projects and tracks their
 * progress so clients can show it anywhere, not just in the surface that
 * started the clone.
 *
 * The clone is detached from the request that started it: the palette closes
 * immediately, the project already exists (pointing at the empty destination),
 * and the composer can hold a draft for it. Snapshots are memory only. A done
 * clone is dropped after a short grace window; a failed one stays until it is
 * retried or the server restarts, since the empty project is the durable
 * record the user can act on.
 */
export class ProjectCloneTracker extends Context.Service<
  ProjectCloneTracker,
  {
    /**
     * Resolves the remote, creates the project, and starts the clone in the
     * background. Fails before creating anything when the destination or
     * repository is unusable so the caller can report it inline.
     */
    readonly start: (
      input: ProjectCloneStartInput,
      hooks: ProjectCloneHooks,
    ) => Effect.Effect<
      ProjectCloneStartResult,
      SourceControlRepositoryError | OrchestrationDispatchCommandError
    >;
    /** Interrupts a running clone and deletes the partial checkout. */
    readonly cancel: (projectId: ProjectId) => Effect.Effect<boolean>;
    /** Restarts a failed or cancelled clone into the same destination. */
    readonly retry: (projectId: ProjectId) => Effect.Effect<boolean, SourceControlRepositoryError>;
    /**
     * Stops tracking a project's clone, interrupting it if it still runs and
     * removing an unfinished checkout. Called when the project is deleted.
     */
    readonly discard: (projectId: ProjectId) => Effect.Effect<void>;
    readonly get: (projectId: ProjectId) => Effect.Effect<ProjectCloneSnapshot | null>;
    /** Emits every tracked clone first, then the full list after each change. */
    readonly stream: Stream.Stream<ReadonlyArray<ProjectCloneSnapshot>>;
  }
>()("t3/project/ProjectCloneTracker") {}

/**
 * Orchestration side effects the caller owns. The tracker never depends on the
 * engine directly: the WebSocket handler dispatches with the client's origin,
 * and the tracker only needs the outcome.
 */
export interface ProjectCloneHooks {
  readonly createProject: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchCommandError>;
  /** Runs after a successful clone so cached repository identity and git status refresh. */
  readonly onCloned: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<void>;
}

/** Finished snapshots stay visible this long so a late subscriber sees the outcome. */
const DONE_RETENTION = "30 seconds";

function clampText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface TrackedClone {
  readonly snapshot: ProjectCloneSnapshot;
  readonly fiber: Fiber.Fiber<unknown, unknown> | null;
  readonly hooks: ProjectCloneHooks;
  readonly input: {
    /** What git is given; may carry credentials and never leaves the server. */
    readonly cloneUrl: string;
    readonly destinationPath: string;
    readonly repository: SourceControlRepositoryInfo | null;
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const clones = yield* Ref.make(new Map<ProjectId, TrackedClone>());
  const changes = yield* PubSub.unbounded<ReadonlyArray<ProjectCloneSnapshot>>();
  const retentionFibers = new Map<ProjectId, Fiber.Fiber<unknown, never>>();
  let sequence = 0;
  // Clone fibers outlive the RPC that started them but not the server.
  const cloneScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(cloneScope, Exit.void));
  // start/cancel/retry/discard mutate the same entry and the same directory;
  // one at a time keeps a double-clicked Retry from racing two clones into it.
  const actionLock = yield* Semaphore.make(1);
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => actionLock.withPermits(1)(effect);

  const list = Ref.get(clones).pipe(
    Effect.map((current) => Array.from(current.values(), (tracked) => tracked.snapshot)),
  );
  const publish = list.pipe(Effect.flatMap((snapshots) => PubSub.publish(changes, snapshots)));

  const modify = (
    projectId: ProjectId,
    mutate: (tracked: TrackedClone) => TrackedClone,
  ): Effect.Effect<ProjectCloneSnapshot | null> =>
    Ref.modify(clones, (current) => {
      const existing = current.get(projectId);
      if (!existing) return [null, current] as const;
      const nextTracked = mutate(existing);
      const nextSnapshot = { ...nextTracked.snapshot, sequence: ++sequence };
      const next = new Map(current);
      next.set(projectId, { ...nextTracked, snapshot: nextSnapshot });
      return [nextSnapshot, next] as const;
    }).pipe(Effect.tap((snapshot) => (snapshot ? publish : Effect.void)));

  const clearRetention = (projectId: ProjectId) => {
    const fiber = retentionFibers.get(projectId);
    retentionFibers.delete(projectId);
    return fiber ? Fiber.interrupt(fiber).pipe(Effect.ignore) : Effect.void;
  };

  const remove = (projectId: ProjectId) =>
    Ref.update(clones, (current) => {
      if (!current.has(projectId)) return current;
      const next = new Map(current);
      next.delete(projectId);
      return next;
    }).pipe(Effect.andThen(publish));

  const scheduleRemoval = (projectId: ProjectId) =>
    Effect.gen(function* () {
      yield* clearRetention(projectId);
      const fiber = yield* remove(projectId).pipe(
        Effect.delay(DONE_RETENTION),
        Effect.ensuring(
          Effect.sync(() => {
            if (retentionFibers.get(projectId) === fiber) retentionFibers.delete(projectId);
          }),
        ),
        Effect.forkDetach,
      );
      retentionFibers.set(projectId, fiber);
    });

  const progress = (
    projectId: ProjectId,
    update: {
      readonly stage: ProjectCloneStage;
      readonly percent: number | null;
      readonly detail: string | null;
    },
  ) =>
    modify(projectId, (tracked) => ({
      ...tracked,
      snapshot: {
        ...tracked.snapshot,
        stage: update.stage,
        percent: update.percent,
        detail:
          update.detail === null ? null : clampText(update.detail, PROJECT_CLONE_DETAIL_MAX_LENGTH),
      },
    })).pipe(Effect.asVoid);

  const finish = (
    projectId: ProjectId,
    phase: "done" | "failed" | "cancelled",
    error: string | null,
  ) =>
    Effect.gen(function* () {
      const endedAt = yield* nowIso;
      yield* modify(projectId, (tracked) => ({
        ...tracked,
        fiber: null,
        snapshot: {
          ...tracked.snapshot,
          phase,
          endedAt,
          percent: phase === "done" ? 100 : tracked.snapshot.percent,
          error: error === null ? null : clampText(error, PROJECT_CLONE_ERROR_MAX_LENGTH),
        },
      }));
      if (phase === "done") yield* scheduleRemoval(projectId);
    });

  /**
   * The clone body. Runs in its own fiber; the tracker records the outcome
   * through `onExit`, which still runs when the fiber is interrupted (a
   * `matchCause` handler would be skipped). Once git has finished the clone
   * is marked done before the post-clone hook runs, so a late Cancel cannot
   * tear down a complete checkout.
   */
  const runClone = (projectId: ProjectId, tracked: TrackedClone) =>
    repositories
      .cloneRepository(
        { remoteUrl: tracked.input.cloneUrl, destinationPath: tracked.input.destinationPath },
        { onProgress: (update) => progress(projectId, update), timeoutMs: null },
      )
      .pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? finish(projectId, "done", null)
            : Cause.hasInterruptsOnly(exit.cause)
              ? finish(projectId, "cancelled", null)
              : finish(projectId, "failed", describeCloneFailure(exit.cause)),
        ),
        Effect.flatMap(() =>
          tracked.hooks
            .onCloned({ projectId, workspaceRoot: tracked.input.destinationPath })
            .pipe(Effect.ignoreCause({ log: true })),
        ),
        Effect.ignoreCause(),
      );

  const launch = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (!tracked) return;
      const fiber = yield* runClone(projectId, tracked).pipe(Effect.forkIn(cloneScope));
      yield* Ref.update(clones, (map) => {
        const existing = map.get(projectId);
        if (!existing) return map;
        const next = new Map(map);
        next.set(projectId, { ...existing, fiber });
        return next;
      });
    });

  const start: ProjectCloneTracker["Service"]["start"] = Effect.fn("ProjectCloneTracker.start")(
    function* (input, hooks) {
      const prepared = yield* repositories.prepareClone(input);
      const startedAt = yield* nowIso;
      const snapshot: ProjectCloneSnapshot = {
        projectId: input.projectId,
        remoteUrl: prepared.remoteUrl,
        destinationPath: prepared.destinationPath,
        repository: prepared.repository,
        phase: "running",
        stage: "connecting",
        percent: null,
        detail: null,
        error: null,
        startedAt,
        endedAt: null,
        sequence: ++sequence,
      };
      const claimed = yield* Ref.modify(clones, (current) => {
        // A second start for the same project, or for a destination another
        // clone already owns, must not race two gits into one directory.
        const conflict = Array.from(current.values()).some(
          (tracked) =>
            tracked.snapshot.projectId === input.projectId ||
            tracked.input.destinationPath === prepared.destinationPath,
        );
        if (conflict) return [false, current] as const;
        const next = new Map(current);
        next.set(input.projectId, {
          snapshot,
          fiber: null,
          hooks,
          input: {
            cloneUrl: prepared.cloneUrl,
            destinationPath: prepared.destinationPath,
            repository: prepared.repository,
          },
        });
        return [true, next] as const;
      });
      if (!claimed) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: input.provider ?? "unknown",
          detail: "A clone into this destination is already in progress.",
        });
      }
      // Everything after the claim runs to completion even if the requesting
      // connection drops: a claimed entry with no fiber could neither be
      // cancelled nor retried. Any failure in here releases the claim.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* clearRetention(input.projectId);
          // The entry is registered before the project exists so a
          // thread.create or project.delete racing this call already sees it.
          yield* hooks.createProject({
            projectId: input.projectId,
            title: input.title,
            workspaceRoot: prepared.destinationPath,
            createdAt: input.createdAt,
          });
          yield* publish;
          yield* launch(input.projectId);
        }).pipe(Effect.tapError(() => remove(input.projectId))),
      );
      return {
        projectId: input.projectId,
        cwd: prepared.destinationPath,
        remoteUrl: prepared.remoteUrl,
        repository: prepared.repository,
      };
    },
  );

  const get: ProjectCloneTracker["Service"]["get"] = (projectId) =>
    Ref.get(clones).pipe(Effect.map((current) => current.get(projectId)?.snapshot ?? null));

  const cancel: ProjectCloneTracker["Service"]["cancel"] = (projectId) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (!tracked || tracked.snapshot.phase !== "running" || !tracked.fiber) return false;
      // Uninterruptible past this point: a client that disconnects mid-cancel
      // must not leave a dead fiber behind a "running" snapshot.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Fiber.interrupt(tracked.fiber!);
          const after = yield* get(projectId);
          // Git finished in the window before the interrupt landed: keep it.
          if (after?.phase === "done") return;
          if (after?.phase === "running") yield* finish(projectId, "cancelled", null);
          // The partial checkout goes so a retry starts from an empty destination.
          yield* repositories.discardClone(tracked.input.destinationPath).pipe(Effect.ignore);
        }),
      );
      return true;
    });

  const retry: ProjectCloneTracker["Service"]["retry"] = (projectId) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (
        !tracked ||
        (tracked.snapshot.phase !== "failed" && tracked.snapshot.phase !== "cancelled")
      ) {
        return false;
      }
      // A retry into leftover files would fail on the non-empty destination
      // with a less useful message, so a cleanup failure is the error here.
      yield* repositories.discardClone(tracked.input.destinationPath);
      const startedAt = yield* nowIso;
      yield* modify(projectId, (entry) => ({
        ...entry,
        snapshot: {
          ...entry.snapshot,
          phase: "running",
          stage: "connecting",
          percent: null,
          detail: null,
          error: null,
          startedAt,
          endedAt: null,
        },
      }));
      yield* launch(projectId);
      return true;
    });

  const discard: ProjectCloneTracker["Service"]["discard"] = (projectId) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (!tracked) return;
      if (tracked.fiber) yield* Fiber.interrupt(tracked.fiber);
      // Git may have finished while the interrupt was landing; the project
      // is going away either way, but a complete checkout is the user's.
      const after = yield* get(projectId);
      if (after?.phase !== "done") {
        yield* repositories.discardClone(tracked.input.destinationPath).pipe(Effect.ignore);
      }
      yield* clearRetention(projectId);
      yield* remove(projectId);
    });

  // One-slot sliding mailbox per subscriber: a slow socket only ever holds the
  // newest list, and lists are whole states so skipping intermediates is safe.
  const stream: ProjectCloneTracker["Service"]["stream"] = Stream.callback<
    ReadonlyArray<ProjectCloneSnapshot>
  >(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* list);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((snapshots) =>
            Effect.sync(() => Queue.offerUnsafe(mailbox, snapshots)),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  return ProjectCloneTracker.of({
    start: (input, hooks) => locked(start(input, hooks)),
    cancel: (projectId) => locked(cancel(projectId)),
    retry: (projectId) => locked(retry(projectId)),
    discard: (projectId) => locked(discard(projectId)),
    get,
    stream,
  });
});

const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

/**
 * A project whose clone has not landed has no files to work in. Every
 * dispatch transport (WebSocket, HTTP) runs this before normalizing so no
 * client can start a thread on an empty tree, and no attachment copies are
 * made for a command that is about to be refused.
 */
export const rejectCommandsDuringClone = (
  tracker: ProjectCloneTracker["Service"],
  command: { readonly type: string; readonly projectId?: ProjectId; readonly bootstrap?: unknown },
): Effect.Effect<void, OrchestrationDispatchCommandError> =>
  Effect.gen(function* () {
    const projectId =
      command.type === "thread.create"
        ? (command.projectId ?? null)
        : command.type === "thread.turn.start"
          ? bootstrapProjectId(command.bootstrap)
          : null;
    if (projectId === null) return;
    const clone = yield* tracker.get(projectId);
    if (clone === null || clone.phase === "done") return;
    return yield* new OrchestrationDispatchCommandError({
      message:
        clone.phase === "running"
          ? "The repository is still being cloned."
          : "The repository was not cloned. Retry the clone first.",
    });
  });

function bootstrapProjectId(bootstrap: unknown): ProjectId | null {
  if (typeof bootstrap !== "object" || bootstrap === null) return null;
  const createThread = (bootstrap as { createThread?: { projectId?: ProjectId } }).createThread;
  return createThread?.projectId ?? null;
}

/** Removing a project mid-clone stops the clone and drops its partial checkout. */
export const discardCloneForDeletedProject = (
  tracker: ProjectCloneTracker["Service"],
  command: OrchestrationCommand,
): Effect.Effect<void> =>
  command.type === "project.delete" ? tracker.discard(command.projectId) : Effect.void;

function describeCloneFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (isSourceControlRepositoryError(error)) return error.detail;
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The repository could not be cloned.";
}

export const layer = Layer.effect(ProjectCloneTracker, make);
