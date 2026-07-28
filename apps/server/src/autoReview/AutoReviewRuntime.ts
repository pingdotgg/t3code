/**
 * Boots the auto-review poller against live server services.
 * Feature stays default-off via ServerSettings.autoReview.enabled.
 *
 * Mounted from `makeServerLayer`'s application layer so RuntimeServicesLive
 * already provides JobStore, Runner, settings, and orchestration.
 */
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CommandId,
  DEFAULT_AUTO_REVIEW_FIX_CONCURRENCY,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadAutoReviewPhase,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import {
  clampAutoReviewConcurrency,
  deriveAutoReviewThreadPhase,
  isAutoReviewFixThreadBusy,
  resolveAutoReviewJobOriginThread,
  resolveAutoReviewPolicy,
  type ThreadLinkCandidate,
} from "@t3tools/shared/autoReview";

import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as AutoReviewJobStore from "./AutoReviewJobStore.ts";
import * as AutoReviewPoller from "./AutoReviewPoller.ts";
import * as AutoReviewRunner from "./AutoReviewRunner.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";

/** Generous bound for the in-memory job scans in drain/phase sync. */
const AUTO_REVIEW_JOB_LIST_LIMIT = 500;

export const autoReviewFixerThreadTitle = (prNumber: number): string =>
  `Auto-review fixer · PR #${prNumber}`;

export const isAutoReviewFixerThread = (
  thread: Pick<OrchestrationThreadShell, "title" | "parentThreadId">,
): boolean => thread.parentThreadId != null && thread.title.startsWith("Auto-review fixer · PR #");

const findAutoReviewFixerThread = (
  shell: OrchestrationShellSnapshot,
  projectId: string,
  prNumber: number,
): OrchestrationThreadShell | undefined =>
  shell.threads.find(
    (thread) =>
      String(thread.projectId) === projectId &&
      thread.parentThreadId != null &&
      thread.title === autoReviewFixerThreadTitle(prNumber),
  );

/**
 * Best-effort fix dispatch: resolves true when the turn.start command was
 * accepted, false when it failed (already swallowed) — callers park the fix
 * as pendingFix instead of losing it.
 */
type FixDispatch = (
  threadId: string,
  prompt: string,
  modelSelection: ModelSelection | null,
) => Effect.Effect<boolean>;

const busyInputForThread = (thread: OrchestrationThreadShell, now: string) => ({
  sessionStatus: thread.session?.status ?? null,
  latestTurnState: thread.latestTurn?.state ?? null,
  latestUserMessageAt: thread.latestUserMessageAt,
  latestTurnTimestamps: thread.latestTurn
    ? [thread.latestTurn.requestedAt, thread.latestTurn.startedAt, thread.latestTurn.completedAt]
    : [],
  now,
});

/** Ids of threads currently mid-turn, the unit fix concurrency is counted in. */
const busyThreadIds = (shell: OrchestrationShellSnapshot, now: string): ReadonlySet<string> =>
  new Set(
    shell.threads
      .filter((thread) => isAutoReviewFixThreadBusy(busyInputForThread(thread, now)))
      .map((thread) => String(thread.id)),
  );

/**
 * Auto-review never steers/injects into a running turn: when the origin
 * thread is busy the fix prompt is parked on the job as `pendingFix` for
 * `drainPendingFixes` to dispatch once the thread goes idle. A failed
 * dispatch is also parked rather than lost.
 */
export const makeQueueOrDispatchFix = (deps: {
  readonly shell: OrchestrationShellSnapshot;
  readonly store: AutoReviewJobStore.AutoReviewJobStore["Service"];
  readonly dispatchFix: FixDispatch;
  /** Max concurrent auto-fix turns; parked when the budget is exhausted. */
  readonly fixConcurrency: number;
}) => {
  return (input: {
    readonly jobId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelSelection: ModelSelection | null;
  }): Effect.Effect<"dispatched" | "queued"> =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const park = deps.store
        .update(input.jobId, {
          pendingFix: {
            threadId: ThreadId.make(input.threadId),
            prompt: input.prompt,
            modelSelection: input.modelSelection,
            queuedAt: now,
          },
        })
        .pipe(Effect.as("queued" as const));

      const thread = deps.shell.threads.find((t) => String(t.id) === input.threadId);
      if (thread && isAutoReviewFixThreadBusy(busyInputForThread(thread, now))) {
        return yield* park;
      }
      // Reviews run in parallel, so several can land wanting a fix at once.
      // The budget is taken atomically rather than read-then-spent: a plain
      // check here would let every concurrent review see the same empty
      // budget and dispatch. Overflow parks for `drainPendingFixes`.
      const reserved = yield* deps.store.reserveFixSlot({
        jobId: input.jobId,
        threadId: input.threadId,
        limit: deps.fixConcurrency,
        busyThreadIds: busyThreadIds(deps.shell, now),
        now,
      });
      if (!reserved) {
        return yield* park;
      }

      const dispatched = yield* deps.dispatchFix(
        input.threadId,
        input.prompt,
        input.modelSelection,
      );
      if (dispatched) {
        return "dispatched" as const;
      }
      // The slot was taken but nothing is running under it — hand it back
      // before parking, or the budget leaks until the grace window expires.
      yield* deps.store.releaseFixSlot(input.jobId);
      return yield* park;
    }).pipe(Effect.orElseSucceed(() => "queued" as const));
};

/**
 * Dispatch parked fix prompts whose origin thread went idle. Fixes are
 * dropped (pendingFix cleared) when the thread vanished or was archived, or
 * when a newer review job for the same PR head supersedes them.
 */
export const makeDrainPendingFixes = (deps: {
  readonly getShell: Effect.Effect<OrchestrationShellSnapshot | null>;
  readonly store: AutoReviewJobStore.AutoReviewJobStore["Service"];
  readonly dispatchFix: FixDispatch;
  /** Max concurrent auto-fix turns, re-read each tick so the slider is live. */
  readonly getFixConcurrency: Effect.Effect<number>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const shell = yield* deps.getShell;
    if (!shell) {
      return;
    }
    const jobs = yield* deps.store.list({ limit: AUTO_REVIEW_JOB_LIST_LIMIT });
    const now = DateTime.formatIso(yield* DateTime.now);
    const fixConcurrency = Math.max(1, yield* deps.getFixConcurrency);
    const busy = busyThreadIds(shell, now);
    for (const job of jobs) {
      const pendingFix = job.pendingFix;
      if (!pendingFix) {
        continue;
      }
      const thread = shell.threads.find((t) => String(t.id) === String(pendingFix.threadId));
      if (!thread || thread.archivedAt != null) {
        yield* deps.store.update(job.id, { pendingFix: null });
        continue;
      }
      const superseded = jobs.some(
        (other) =>
          other.id !== job.id &&
          other.projectId === job.projectId &&
          other.prNumber === job.prNumber &&
          other.headSha !== job.headSha &&
          other.createdAt > job.createdAt,
      );
      if (superseded) {
        yield* deps.store.update(job.id, { pendingFix: null });
        continue;
      }
      const threadId = String(pendingFix.threadId);
      if (isAutoReviewFixThreadBusy(busyInputForThread(thread, now))) {
        continue;
      }
      // Same atomic reservation the review path uses, so both share one
      // budget. It also subsumes the per-pass bookkeeping this loop used to
      // do by hand: a thread reserved earlier in the pass is already
      // occupied, so a second fix for it cannot take a slot.
      const reserved = yield* deps.store.reserveFixSlot({
        jobId: job.id,
        threadId,
        limit: fixConcurrency,
        busyThreadIds: busy,
        now,
      });
      if (!reserved) {
        continue;
      }
      const dispatched = yield* deps.dispatchFix(
        threadId,
        pendingFix.prompt,
        pendingFix.modelSelection,
      );
      if (!dispatched) {
        // Restore the parked fix: `reserveFixSlot` cleared it when it took
        // the slot, and nothing is running to consume it.
        yield* deps.store.releaseFixSlot(job.id);
        yield* deps.store.update(job.id, { pendingFix });
      }
    }
  }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.asVoid,
  );

/**
 * Reconcile each non-archived thread shell's autoReviewPhase with the job
 * store. Diffing against the shell's current phase keeps restarts
 * self-reconciling: the in-memory job store starts empty, so stale phases
 * drift back to null on the first tick.
 */
export const makeSyncThreadPhases = (deps: {
  readonly getShell: Effect.Effect<OrchestrationShellSnapshot | null>;
  readonly store: AutoReviewJobStore.AutoReviewJobStore["Service"];
  readonly setPhase: (
    threadId: string,
    phase: OrchestrationThreadAutoReviewPhase | null,
  ) => Effect.Effect<void>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const shell = yield* deps.getShell;
    if (!shell) {
      return;
    }
    const jobs = yield* deps.store.list({ limit: AUTO_REVIEW_JOB_LIST_LIMIT });
    const now = DateTime.formatIso(yield* DateTime.now);
    // Candidate pool for provisionally attributing in-flight (still unlinked)
    // jobs to a thread, mirroring what the runner passes on success.
    const candidates: ReadonlyArray<ThreadLinkCandidate> = shell.threads.map((thread) => ({
      threadId: String(thread.id),
      projectId: String(thread.projectId),
      deletedAt: thread.archivedAt,
      updatedAt: thread.updatedAt,
      status: thread.session?.status ?? "idle",
      prNumber: null,
      prState: null,
      branch: thread.branch,
    }));
    const attributedThreadId = new Map<string, string | null>(
      jobs.map((job) => [job.id, resolveAutoReviewJobOriginThread({ job, candidates })]),
    );
    for (const thread of shell.threads) {
      if (thread.archivedAt != null) {
        continue;
      }
      // Relevance is origin-thread linkage, plus queued/running jobs whose
      // head branch resolves to this thread — those are not linked yet, and
      // without them the thread would read as idle/done mid-review.
      const relevant = jobs.filter((job) => attributedThreadId.get(job.id) === String(thread.id));
      const fixThreadBusy = (() => {
        const latest = relevant
          .filter((job) => job.status === "succeeded" && job.fixThreadId != null)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!latest?.fixThreadId) {
          return undefined;
        }
        const fixer = shell.threads.find(
          (candidate) => String(candidate.id) === String(latest.fixThreadId),
        );
        return fixer ? isAutoReviewFixThreadBusy(busyInputForThread(fixer, now)) : false;
      })();
      const desired = deriveAutoReviewThreadPhase({
        jobs: relevant,
        threadId: String(thread.id),
        threadBusy: isAutoReviewFixThreadBusy(busyInputForThread(thread, now)),
        ...(fixThreadBusy === undefined ? {} : { fixThreadBusy }),
      });
      if (desired === thread.autoReviewPhase) {
        continue;
      }
      yield* deps.setPhase(String(thread.id), desired);
    }
  }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.asVoid,
  );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const store = yield* AutoReviewJobStore.AutoReviewJobStore;
    yield* AutoReviewRunner.AutoReviewRunner;
    yield* GitHubCli.GitHubCli;

    const getShell = snapshots.getShellSnapshot().pipe(Effect.orElseSucceed(() => null));

    const dispatchFix: FixDispatch = (threadId, prompt, modelSelection) =>
      Effect.gen(function* () {
        const commandUuid = yield* crypto.randomUUIDv4;
        const messageUuid = yield* crypto.randomUUIDv4;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestration
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`auto-review-fix:${commandUuid}`),
            threadId: ThreadId.make(threadId),
            message: {
              messageId: MessageId.make(`auto-review-fix-msg:${messageUuid}`),
              role: "user",
              text: prompt,
              attachments: [],
            },
            // Omitted rather than nulled: the command treats an absent
            // selection as "keep the thread's model", which is the default
            // "the thread that did the work also fixes it" behaviour.
            ...(modelSelection ? { modelSelection } : {}),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          })
          .pipe(Effect.asVoid);
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    const resolveFixThread = (input: {
      readonly shell: OrchestrationShellSnapshot;
      readonly originThreadId: string;
      readonly projectId: string;
      readonly prNumber: number;
      readonly modelSelection: ModelSelection | null;
    }) =>
      Effect.gen(function* () {
        if (!input.modelSelection) {
          return input.originThreadId;
        }

        const existing = findAutoReviewFixerThread(input.shell, input.projectId, input.prNumber);
        if (existing) {
          if (existing.archivedAt != null) {
            const commandUuid = yield* crypto.randomUUIDv4;
            yield* orchestration
              .dispatch({
                type: "thread.unarchive",
                commandId: CommandId.make(`auto-review-fixer-unarchive:${commandUuid}`),
                threadId: existing.id,
              })
              .pipe(Effect.asVoid);
          }
          return String(existing.id);
        }

        const origin = input.shell.threads.find(
          (thread) => String(thread.id) === input.originThreadId,
        );
        if (!origin) {
          return input.originThreadId;
        }
        const threadUuid = yield* crypto.randomUUIDv4;
        const commandUuid = yield* crypto.randomUUIDv4;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const fixerThreadId = ThreadId.make(threadUuid);
        yield* orchestration
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(`auto-review-fixer-create:${commandUuid}`),
            threadId: fixerThreadId,
            projectId: ProjectId.make(input.projectId),
            title: autoReviewFixerThreadTitle(input.prNumber),
            modelSelection: input.modelSelection,
            runtimeMode: origin.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: origin.branch,
            worktreePath: origin.worktreePath,
            parentThreadId: origin.id,
            createdAt,
          })
          .pipe(Effect.asVoid);
        return String(fixerThreadId);
      });

    const settleFixThread = (
      shell: OrchestrationShellSnapshot,
      input: { readonly projectId: string; readonly prNumber: number },
    ) =>
      Effect.gen(function* () {
        const fixer = findAutoReviewFixerThread(shell, input.projectId, input.prNumber);
        if (!fixer || fixer.archivedAt != null) {
          return;
        }
        const commandUuid = yield* crypto.randomUUIDv4;
        yield* orchestration
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`auto-review-fixer-archive:${commandUuid}`),
            threadId: fixer.id,
          })
          .pipe(Effect.asVoid);
      });

    const setPhase = (
      threadId: string,
      phase: OrchestrationThreadAutoReviewPhase | null,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const commandUuid = yield* crypto.randomUUIDv4;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestration
          .dispatch({
            type: "thread.auto-review-phase.set",
            commandId: CommandId.make(`auto-review-phase:${commandUuid}`),
            threadId: ThreadId.make(threadId),
            phase,
            createdAt,
          })
          .pipe(Effect.asVoid);
      }).pipe(Effect.orElseSucceed(() => undefined));

    const deps: AutoReviewPoller.AutoReviewPollerDeps = {
      getSettings: settings.getSettings,
      listProjects: snapshots.getShellSnapshot().pipe(
        Effect.map((shell) =>
          shell.projects.map((project) => ({
            id: String(project.id),
            workspaceRoot: project.workspaceRoot,
            deletedAt: null,
          })),
        ),
        Effect.orElseSucceed(() => []),
      ),
      isGitHubProject: (cwd: string) =>
        sourceControl.resolveHandle({ cwd }).pipe(
          Effect.map((handle) => handle.provider.kind === "github"),
          Effect.orElseSucceed(() => false),
        ),
      contextForJob: (job) =>
        Effect.gen(function* () {
          const shell = yield* getShell;
          if (!shell) {
            return { cwd: "", candidates: [] };
          }
          const project = shell.projects.find((p) => String(p.id) === job.projectId);
          // Re-resolved per job so a settings edit takes effect on the next
          // review rather than at the next server restart.
          const policy = yield* settings.getSettings.pipe(
            Effect.map((current) => resolveAutoReviewPolicy(current.autoReview, job.projectId)),
            Effect.orElseSucceed(() => null),
          );
          return {
            cwd: project?.workspaceRoot ?? "",
            candidates: shell.threads
              .filter(
                (thread) =>
                  String(thread.projectId) === job.projectId &&
                  thread.archivedAt == null &&
                  !isAutoReviewFixerThread(thread),
              )
              .map((thread) => ({
                threadId: String(thread.id),
                projectId: String(thread.projectId),
                deletedAt: thread.archivedAt,
                updatedAt: thread.updatedAt,
                status: thread.session?.status ?? "idle",
                prNumber: null as number | null,
                prState: null as "open" | "closed" | "merged" | null,
                branch: thread.branch,
              })),
            // Omitted when the project opted out of auto-fix: the review is
            // still posted, but nothing is dispatched to the origin thread.
            ...(policy?.autoFixOriginThread === false
              ? {}
              : {
                  queueOrDispatchFix: (input: {
                    readonly jobId: string;
                    readonly threadId: string;
                    readonly prompt: string;
                    readonly modelSelection: ModelSelection | null;
                    readonly projectId: string;
                    readonly prNumber: number;
                  }) =>
                    Effect.gen(function* () {
                      const targetThreadId = yield* resolveFixThread({
                        shell,
                        originThreadId: input.threadId,
                        projectId: input.projectId,
                        prNumber: input.prNumber,
                        modelSelection: input.modelSelection,
                      }).pipe(Effect.orElseSucceed(() => input.threadId));
                      const outcome = yield* makeQueueOrDispatchFix({
                        shell,
                        store,
                        dispatchFix,
                        fixConcurrency:
                          policy?.fixConcurrency ?? DEFAULT_AUTO_REVIEW_FIX_CONCURRENCY,
                      })({
                        jobId: input.jobId,
                        threadId: targetThreadId,
                        prompt: input.prompt,
                        modelSelection: input.modelSelection,
                      });
                      return { outcome, threadId: targetThreadId };
                    }),
                }),
            // Always retire an existing dedicated fixer after a clean review,
            // even if the user disabled auto-fix after that thread was made.
            settleFixThread: (input: { readonly projectId: string; readonly prNumber: number }) =>
              settleFixThread(shell, input).pipe(
                Effect.orElseSucceed(() => undefined),
                Effect.asVoid,
              ),
          } satisfies AutoReviewRunner.AutoReviewOriginContext;
        }),
      drainPendingFixes: makeDrainPendingFixes({
        getShell,
        store,
        dispatchFix,
        getFixConcurrency: settings.getSettings.pipe(
          Effect.map((current) =>
            clampAutoReviewConcurrency(
              current.autoReview.fixConcurrency,
              DEFAULT_AUTO_REVIEW_FIX_CONCURRENCY,
            ),
          ),
          Effect.orElseSucceed(() => DEFAULT_AUTO_REVIEW_FIX_CONCURRENCY),
        ),
      }),
      syncThreadPhases: makeSyncThreadPhases({ getShell, store, setPhase }),
    };

    const poller = yield* AutoReviewPoller.make(deps);
    yield* Effect.forkScoped(
      poller.start.pipe(
        Effect.delay(Duration.seconds(5)),
        Effect.andThen(Effect.logInfo("Auto-review poller started")),
        Effect.orElseSucceed(() => undefined),
      ),
    );
  }),
);
