import type {
  ProjectCloneStage,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectId,
} from "@t3tools/contracts";
import {
  OrchestrationDispatchCommandError,
  PROJECT_CLONE_DETAIL_MAX_LENGTH,
  PROJECT_CLONE_ERROR_MAX_LENGTH,
  ProjectCloneSnapshot,
  SourceControlCloneProtocol,
  SourceControlProviderKind,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { ProjectConflictError } from "./ProjectService.ts";

export class ProjectCloneTracker extends Context.Service<
  ProjectCloneTracker,
  {
    readonly start: (
      input: ProjectCloneStartInput,
      hooks: ProjectCloneHooks,
    ) => Effect.Effect<
      ProjectCloneStartResult,
      SourceControlRepositoryError | OrchestrationDispatchCommandError
    >;
    /** Interrupts a running clone and deletes the partial checkout. */
    readonly cancel: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly retry: (
      projectId: ProjectId,
      onCloned?: ProjectCloneHooks["onCloned"],
    ) => Effect.Effect<boolean, SourceControlRepositoryError>;
    /** Stops tracking, interrupts any running clone and removes unfinished checkouts. */
    readonly discard: (projectId: ProjectId) => Effect.Effect<void>;
    readonly get: (projectId: ProjectId) => Effect.Effect<ProjectCloneSnapshot | null>;
    readonly stream: Stream.Stream<ReadonlyArray<ProjectCloneSnapshot>>;
  }
>()("t3/project/ProjectCloneTracker") {}

export interface ProjectCloneHooks {
  /** Fails with `ProjectConflictError` when another project already owns the destination. */
  readonly createProject: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchCommandError | ProjectConflictError>;
  readonly onCloned: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<void>;
}

const DONE_RETENTION = "30 seconds";
// Git prints nothing while a transfer waits on the network, and the kernel can
// take 15+ minutes to give up on a dead connection. Without this the banner
// keeps showing the last transfer speed as if data were still arriving.
const STALL_AFTER = "20 seconds";

function clampText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const end = splitsSurrogatePair(text, maxLength - 1) ? maxLength - 2 : maxLength - 1;
  return `${text.slice(0, end)}…`;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const CLONE_JOURNAL = "pending-project-clones";
/** Holds a journal that could not be decoded, so a fresh journal never overwrites its entries. */
const UNREADABLE_CLONE_JOURNAL = "pending-project-clones-unreadable";
const CloneJournal = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      snapshot: ProjectCloneSnapshot,
      cloneUrl: Schema.String,
      protocol: SourceControlCloneProtocol,
    }),
  ),
);
type CloneJournalEntry = (typeof CloneJournal.Type)[number];
const decodeCloneJournal = Schema.decodeEffect(CloneJournal);
const encodeCloneJournal = Schema.encodeEffect(CloneJournal);

interface TrackedClone {
  readonly snapshot: ProjectCloneSnapshot;
  readonly fiber: Fiber.Fiber<unknown, unknown> | null;
  readonly onCloned?: ProjectCloneHooks["onCloned"];
  readonly recovered?: boolean;
  readonly cloneUrl: string;
  readonly protocol: SourceControlCloneProtocol;
}

/** @public */
export const make = Effect.gen(function* () {
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  // A journal that cannot be loaded must not stop the server from opening existing projects.
  // An unreadable store keeps the journal untouched and refuses new clone state until restart; an
  // undecodable journal is set aside before a fresh one replaces it.
  let journalUnavailable = false;
  const entries: ReadonlyArray<CloneJournalEntry> = yield* secrets.get(CLONE_JOURNAL).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.logError("The pending clone journal could not be read.", cause).pipe(
          Effect.andThen(
            Effect.sync(() => {
              journalUnavailable = true;
              return [];
            }),
          ),
        ),
      onSuccess: (stored) =>
        Option.isNone(stored)
          ? Effect.succeed([])
          : decodeCloneJournal(new TextDecoder().decode(stored.value)).pipe(
              Effect.catch((cause) =>
                Effect.logError(
                  `The pending clone journal could not be decoded; it was kept as ${UNREADABLE_CLONE_JOURNAL}.`,
                  cause,
                ).pipe(
                  Effect.andThen(secrets.set(UNREADABLE_CLONE_JOURNAL, stored.value)),
                  Effect.catch((saveCause) =>
                    Effect.logError(
                      "The undecodable clone journal could not be kept.",
                      saveCause,
                    ).pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          journalUnavailable = true;
                        }),
                      ),
                    ),
                  ),
                  Effect.as([]),
                ),
              ),
            ),
    }),
  );
  const journal = new Map<string, CloneJournalEntry>();
  const restored = new Map<ProjectId, TrackedClone>();
  const stoppedAt = yield* nowIso;
  let sequence = 0;
  for (const entry of entries) {
    const { destinationPath } = entry.snapshot;
    const project = yield* projects.findActiveByWorkspaceRoot(destinationPath).pipe(
      Effect.catch((cause) =>
        Effect.logError("A pending clone's project could not be looked up.", cause).pipe(
          // Kept as stored so the next journal write does not drop it before a later restart.
          Effect.andThen(Effect.sync(() => journal.set(destinationPath, entry))),
          Effect.as(Option.none()),
        ),
      ),
    );
    if (Option.isNone(project)) continue;
    const { projectId } = project.value;
    const snapshot: ProjectCloneSnapshot = {
      ...entry.snapshot,
      ...(entry.snapshot.phase === "running"
        ? {
            phase: "failed",
            error: "The server restarted before the clone finished.",
            endedAt: stoppedAt,
          }
        : {}),
      stalled: false,
      projectId,
      sequence: ++sequence,
    };
    journal.set(destinationPath, { ...entry, snapshot });
    restored.set(projectId, { ...entry, snapshot, fiber: null, recovered: true });
  }
  const clones = yield* Ref.make(restored);
  const changes = yield* PubSub.unbounded<ReadonlyArray<ProjectCloneSnapshot>>();
  const retentionFibers = new Map<ProjectId, Fiber.Fiber<unknown, never>>();
  const cloneScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(cloneScope, Exit.void));
  // Serialize actions on the shared entry and directory so retries cannot race clones.
  const actionLock = yield* Semaphore.make(1);
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => actionLock.withPermits(1)(effect);
  const journalLock = yield* Semaphore.make(1);
  const writeJournal = Effect.fn("ProjectCloneTracker.writeJournal")(function* (
    destination: string,
    entry: CloneJournalEntry | null,
  ) {
    yield* journalLock
      .withPermits(1)(
        Effect.gen(function* () {
          if (entry === null && !journal.has(destination)) return;
          if (journalUnavailable) {
            return yield* Effect.fail("The clone journal could not be loaded at startup.");
          }
          const next = new Map(journal);
          if (entry === null) next.delete(destination);
          else next.set(destination, entry);
          const encoded = yield* encodeCloneJournal(Array.from(next.values()));
          yield* secrets.set(CLONE_JOURNAL, new TextEncoder().encode(encoded));
          if (entry === null) journal.delete(destination);
          else journal.set(destination, entry);
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: SourceControlProviderKind.make("unknown"),
              detail: "The clone state could not be saved.",
              cause,
            }),
        ),
      );
  });

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

  const scheduleRemoval = Effect.fn("ProjectCloneTracker.scheduleRemoval")(function* (
    projectId: ProjectId,
  ) {
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
        stalled: false,
      },
    })).pipe(Effect.asVoid);

  const markStalled = (projectId: ProjectId) =>
    modify(projectId, (tracked) => ({
      ...tracked,
      snapshot: { ...tracked.snapshot, stalled: true },
    })).pipe(Effect.asVoid);

  /** Marks the clone stalled once, then waits for git to speak again. */
  const watchForStall = (projectId: ProjectId, pulses: Queue.Dequeue<void>) =>
    Queue.take(pulses).pipe(
      Effect.timeoutOption(STALL_AFTER),
      Effect.flatMap((pulse) =>
        Option.isSome(pulse)
          ? Effect.void
          : markStalled(projectId).pipe(Effect.andThen(Queue.take(pulses))),
      ),
      Effect.forever,
    );

  const finish = Effect.fn("ProjectCloneTracker.finish")(function* (
    projectId: ProjectId,
    phase: "done" | "failed" | "cancelled",
    error: string | null,
  ) {
    const endedAt = yield* nowIso;
    const existing = (yield* Ref.get(clones)).get(projectId);
    if (!existing) return;
    const { destinationPath } = existing.snapshot;
    const snapshot = {
      ...existing.snapshot,
      phase,
      endedAt,
      percent: phase === "done" ? 100 : existing.snapshot.percent,
      stalled: false,
      error: error === null ? null : clampText(error, PROJECT_CLONE_ERROR_MAX_LENGTH),
    };
    if (phase === "done") {
      yield* writeJournal(destinationPath, null).pipe(Effect.ignore({ log: true }));
    } else if (phase === "failed") {
      yield* writeJournal(destinationPath, {
        snapshot,
        cloneUrl: existing.cloneUrl,
        protocol: existing.protocol,
      }).pipe(Effect.ignore({ log: true }));
    }
    // A clone refused before git ran never owned the destination; the next retry must not delete it.
    const ownsNothing = error === SourceControlRepositoryService.DESTINATION_NOT_EMPTY;
    yield* modify(projectId, (tracked) => ({
      ...tracked,
      fiber: null,
      snapshot,
      ...(ownsNothing ? { recovered: true } : {}),
    }));
    if (phase === "done") yield* scheduleRemoval(projectId);
  });

  const cloneWatchingForStall = Effect.fn("ProjectCloneTracker.cloneWatchingForStall")(function* (
    projectId: ProjectId,
    tracked: TrackedClone,
  ) {
    const pulses = yield* Queue.sliding<void>(1);
    yield* watchForStall(projectId, pulses).pipe(Effect.forkScoped);
    return yield* repositories.cloneRepository(
      {
        remoteUrl: tracked.cloneUrl,
        destinationPath: tracked.snapshot.destinationPath,
        protocol: tracked.protocol,
      },
      {
        onProgress: (update) =>
          Queue.offer(pulses, undefined).pipe(Effect.andThen(progress(projectId, update))),
        timeoutMs: null,
      },
    );
  }, Effect.scoped);

  /**
   * `onExit` records outcomes even on interruption; `matchCause` would be skipped.
   * Mark the clone done before the post-clone hook so a late Cancel cannot remove it.
   */
  const runClone = (projectId: ProjectId, tracked: TrackedClone) =>
    cloneWatchingForStall(projectId, tracked).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? finish(projectId, "done", null)
          : Cause.hasInterruptsOnly(exit.cause)
            ? finish(projectId, "cancelled", null)
            : finish(projectId, "failed", describeCloneFailure(exit.cause)),
      ),
      Effect.flatMap(() =>
        (
          tracked.onCloned?.({ projectId, workspaceRoot: tracked.snapshot.destinationPath }) ??
          Effect.void
        ).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.ignoreCause(),
    );

  const launch = Effect.fn("ProjectCloneTracker.launch")(function* (projectId: ProjectId) {
    const current = yield* Ref.get(clones);
    const tracked = current.get(projectId);
    if (!tracked) return;
    const fiber = yield* runClone(projectId, tracked).pipe(Effect.forkIn(cloneScope));
    yield* Ref.update(clones, (map) => {
      const existing = map.get(projectId);
      if (!existing || existing.snapshot.phase !== "running") return map;
      const next = new Map(map);
      next.set(projectId, { ...existing, fiber });
      return next;
    });
  });

  const moveClaim = (from: ProjectId, to: ProjectId) =>
    Ref.modify(clones, (current) => {
      const claim = current.get(from);
      if (!claim || current.has(to)) return [false, current] as const;
      const next = new Map(current);
      next.delete(from);
      next.set(to, { ...claim, snapshot: { ...claim.snapshot, projectId: to } });
      return [true, next] as const;
    });

  const start: ProjectCloneTracker["Service"]["start"] = Effect.fn("ProjectCloneTracker.start")(
    function* (input, hooks) {
      const prepared = yield* repositories.prepareClone(input, {
        reuseCheckout: input.reuseExistingCheckout === true,
      });
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
        stalled: false,
        error: null,
        startedAt,
        endedAt: null,
        sequence: ++sequence,
      };
      const claim = yield* Ref.modify(clones, (current) => {
        const overlapping = Array.from(current.values()).filter(
          (tracked) =>
            tracked.snapshot.projectId === input.projectId ||
            tracked.snapshot.destinationPath === prepared.destinationPath,
        );
        // Only a running clone owns its destination; a failed or cancelled one
        // left nothing behind, so a fresh start supersedes it.
        if (overlapping.some((tracked) => tracked.snapshot.phase === "running")) {
          return [null, current] as const;
        }
        const next = new Map(current);
        for (const stale of overlapping) next.delete(stale.snapshot.projectId);
        next.set(input.projectId, {
          snapshot,
          fiber: null,
          onCloned: hooks.onCloned,
          cloneUrl: prepared.cloneUrl,
          protocol: input.protocol ?? "auto",
        });
        return [overlapping, next] as const;
      });
      const alreadyInProgress = new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider: input.provider ?? SourceControlProviderKind.make("unknown"),
        detail: "A clone into this destination is already in progress.",
      });
      if (claim === null) return yield* alreadyInProgress;
      // A superseded done entry's pending removal would otherwise delete the new claim.
      yield* Effect.forEach(claim, (stale) => clearRetention(stale.snapshot.projectId), {
        discard: true,
      });
      // A refused start drops only its own claim; the entries it displaced stay retryable.
      const releaseClaim = Ref.update(clones, (current) => {
        const next = new Map(current);
        next.delete(input.projectId);
        for (const stale of claim) {
          if (!next.has(stale.snapshot.projectId)) next.set(stale.snapshot.projectId, stale);
        }
        return next;
      }).pipe(Effect.andThen(publish));
      // Finish or release the claim despite disconnects; a claim without a fiber cannot be cancelled or retried.
      const projectId = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* clearRetention(input.projectId);
          const previousEntry = journal.get(prepared.destinationPath) ?? null;
          if (!prepared.existingCheckout) {
            yield* writeJournal(prepared.destinationPath, {
              snapshot,
              cloneUrl: prepared.cloneUrl,
              protocol: input.protocol ?? "auto",
            });
          }
          // Register before creation so racing thread.create and project.delete see the clone.
          const projectId = yield* hooks
            .createProject({
              projectId: input.projectId,
              title: input.title,
              workspaceRoot: prepared.destinationPath,
              createdAt: input.createdAt,
            })
            .pipe(
              Effect.as(input.projectId),
              // Reuse the project that already owns the destination.
              Effect.catchTags({
                ProjectConflictError: (conflict) =>
                  moveClaim(input.projectId, conflict.conflictingProjectId).pipe(
                    Effect.flatMap((moved) =>
                      moved ? Effect.succeed(conflict.conflictingProjectId) : alreadyInProgress,
                    ),
                  ),
              }),
              Effect.tapError(() =>
                prepared.existingCheckout
                  ? Effect.void
                  : writeJournal(prepared.destinationPath, previousEntry).pipe(
                      Effect.ignore({ log: true }),
                    ),
              ),
            );
          if (prepared.existingCheckout) {
            yield* finish(projectId, "done", null);
            yield* hooks
              .onCloned({ projectId, workspaceRoot: prepared.destinationPath })
              .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(cloneScope));
          } else {
            yield* publish;
            yield* launch(projectId);
          }
          return projectId;
        }).pipe(Effect.tapError(() => releaseClaim)),
      );
      return {
        projectId,
        cwd: prepared.destinationPath,
        remoteUrl: prepared.remoteUrl,
        repository: prepared.repository,
      };
    },
  );

  const keepsFiles = (projectId: ProjectId) =>
    Ref.get(clones).pipe(Effect.map((current) => current.get(projectId)?.recovered === true));

  const get: ProjectCloneTracker["Service"]["get"] = (projectId) =>
    Ref.get(clones).pipe(Effect.map((current) => current.get(projectId)?.snapshot ?? null));

  const cancel: ProjectCloneTracker["Service"]["cancel"] = Effect.fn("ProjectCloneTracker.cancel")(
    function* (projectId) {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (!tracked || tracked.snapshot.phase !== "running" || !tracked.fiber) return false;
      // Finish cancellation despite disconnects to avoid dead fibers behind running snapshots.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Fiber.interrupt(tracked.fiber!);
          const after = yield* get(projectId);
          if (after?.phase === "done") return;
          if (after?.phase === "running") yield* finish(projectId, "cancelled", null);
          // Read after the interrupt: a clone refused before git ran marks its files as not its own.
          if (!(yield* keepsFiles(projectId))) {
            yield* repositories.discardClone(tracked.snapshot.destinationPath).pipe(Effect.ignore);
          }
          const snapshot = yield* get(projectId);
          if (snapshot) {
            yield* writeJournal(snapshot.destinationPath, {
              snapshot,
              cloneUrl: tracked.cloneUrl,
              protocol: tracked.protocol,
            }).pipe(Effect.ignore({ log: true }));
          }
        }),
      );
      return true;
    },
  );

  const retry: ProjectCloneTracker["Service"]["retry"] = Effect.fn("ProjectCloneTracker.retry")(
    function* (projectId, onCloned) {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (
        !tracked ||
        (tracked.snapshot.phase !== "failed" && tracked.snapshot.phase !== "cancelled")
      ) {
        return false;
      }
      const { destinationPath } = tracked.snapshot;
      if (tracked.recovered) {
        // After a restart we cannot know which files the interrupted clone created, so none are
        // deleted. A complete checkout of this repository finishes the clone as `start` would.
        const prepared = yield* repositories
          .prepareClone(
            { remoteUrl: tracked.cloneUrl, destinationPath },
            { reuseCheckout: true, requireCompleteCheckout: true },
          )
          .pipe(
            Effect.mapError((error) =>
              error.detail === SourceControlRepositoryService.DESTINATION_NOT_EMPTY
                ? new SourceControlRepositoryError({
                    operation: error.operation,
                    provider: error.provider,
                    detail: `${destinationPath} is not empty. Inspect or move the folder, then retry.`,
                  })
                : error,
            ),
          );
        if (prepared.existingCheckout) {
          const hook = onCloned ?? tracked.onCloned;
          // `recovered` stays set until `done` commits: an interrupted retry must still keep files.
          yield* finish(projectId, "done", null);
          if (hook) {
            yield* hook({ projectId, workspaceRoot: destinationPath }).pipe(
              Effect.ignoreCause({ log: true }),
              Effect.forkIn(cloneScope),
            );
          }
          return true;
        }
      } else {
        yield* repositories.discardClone(destinationPath);
      }
      const startedAt = yield* nowIso;
      const snapshot: ProjectCloneSnapshot = {
        ...tracked.snapshot,
        phase: "running",
        stage: "connecting",
        percent: null,
        detail: null,
        stalled: false,
        error: null,
        startedAt,
        endedAt: null,
      };
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* writeJournal(destinationPath, {
            snapshot,
            cloneUrl: tracked.cloneUrl,
            protocol: tracked.protocol,
          });
          yield* modify(projectId, (entry) => ({
            ...entry,
            recovered: false,
            ...(onCloned ? { onCloned } : {}),
            snapshot,
          }));
          yield* launch(projectId);
        }),
      );
      return true;
    },
  );

  const discard: ProjectCloneTracker["Service"]["discard"] = Effect.fn(
    "ProjectCloneTracker.discard",
  )(function* (projectId) {
    const current = yield* Ref.get(clones);
    const tracked = current.get(projectId);
    if (!tracked) return;
    if (tracked.fiber) yield* Fiber.interrupt(tracked.fiber);
    // Git may have finished while the interrupt was landing; the project
    // is going away either way, but a complete checkout is the user's.
    const after = yield* get(projectId);
    if (after?.phase !== "done" && !(yield* keepsFiles(projectId))) {
      yield* repositories.discardClone(tracked.snapshot.destinationPath).pipe(Effect.ignore);
    }
    yield* writeJournal(tracked.snapshot.destinationPath, null).pipe(Effect.ignore({ log: true }));
    yield* clearRetention(projectId);
    yield* remove(projectId);
  });

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

  // Forwarders retain the underlying operation spans.
  return ProjectCloneTracker.of({
    start: Effect.fnUntraced(function* (input, hooks) {
      return yield* locked(start(input, hooks));
    }),
    cancel: Effect.fnUntraced(function* (projectId) {
      return yield* locked(cancel(projectId));
    }),
    retry: Effect.fnUntraced(function* (projectId, onCloned) {
      return yield* locked(retry(projectId, onCloned));
    }),
    discard: Effect.fnUntraced(function* (projectId) {
      return yield* locked(discard(projectId));
    }),
    get,
    stream,
  });
});

const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

/**
 * Every dispatch transport (WebSocket, HTTP) runs this before normalizing so no
 * client can start a thread on an empty tree, and no attachment copies are made
 * for a command that is about to be refused.
 */
export const rejectCommandsDuringClone = Effect.fn("ProjectCloneTracker.rejectCommandsDuringClone")(
  function* (
    tracker: ProjectCloneTracker["Service"],
    command: {
      readonly type: string;
      readonly projectId?: ProjectId;
      readonly bootstrap?: unknown;
    },
  ): Effect.fn.Return<void, OrchestrationDispatchCommandError> {
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
  },
);

function bootstrapProjectId(bootstrap: unknown): ProjectId | null {
  if (typeof bootstrap !== "object" || bootstrap === null) return null;
  const createThread = (bootstrap as { createThread?: { projectId?: ProjectId } }).createThread;
  return createThread?.projectId ?? null;
}

function describeCloneFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (isSourceControlRepositoryError(error)) return error.detail;
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The repository could not be cloned.";
}

export const layer = Layer.effect(ProjectCloneTracker, make);
