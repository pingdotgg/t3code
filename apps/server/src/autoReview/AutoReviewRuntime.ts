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
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadAutoReviewPhase,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { deriveAutoReviewThreadPhase, isAutoReviewFixThreadBusy } from "@t3tools/shared/autoReview";

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

/**
 * Best-effort fix dispatch: resolves true when the turn.start command was
 * accepted, false when it failed (already swallowed) — callers park the fix
 * as pendingFix instead of losing it.
 */
type FixDispatch = (threadId: string, prompt: string) => Effect.Effect<boolean>;

const busyInputForThread = (thread: OrchestrationThreadShell, now: string) => ({
  sessionStatus: thread.session?.status ?? null,
  latestTurnState: thread.latestTurn?.state ?? null,
  latestUserMessageAt: thread.latestUserMessageAt,
  latestTurnTimestamps: thread.latestTurn
    ? [thread.latestTurn.requestedAt, thread.latestTurn.startedAt, thread.latestTurn.completedAt]
    : [],
  now,
});

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
}) => {
  return (input: {
    readonly jobId: string;
    readonly threadId: string;
    readonly prompt: string;
  }): Effect.Effect<"dispatched" | "queued"> =>
    Effect.gen(function* () {
      const thread = deps.shell.threads.find((t) => String(t.id) === input.threadId);
      const now = DateTime.formatIso(yield* DateTime.now);
      if (thread && isAutoReviewFixThreadBusy(busyInputForThread(thread, now))) {
        yield* deps.store.update(input.jobId, {
          pendingFix: {
            threadId: ThreadId.make(input.threadId),
            prompt: input.prompt,
            queuedAt: now,
          },
        });
        return "queued" as const;
      }
      const dispatched = yield* deps.dispatchFix(input.threadId, input.prompt);
      if (dispatched) {
        return "dispatched" as const;
      }
      yield* deps.store.update(input.jobId, {
        pendingFix: {
          threadId: ThreadId.make(input.threadId),
          prompt: input.prompt,
          queuedAt: now,
        },
      });
      return "queued" as const;
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
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const shell = yield* deps.getShell;
    if (!shell) {
      return;
    }
    const jobs = yield* deps.store.list({ limit: AUTO_REVIEW_JOB_LIST_LIMIT });
    const now = DateTime.formatIso(yield* DateTime.now);
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
      if (isAutoReviewFixThreadBusy(busyInputForThread(thread, now))) {
        continue;
      }
      const dispatched = yield* deps.dispatchFix(String(pendingFix.threadId), pendingFix.prompt);
      if (dispatched) {
        yield* deps.store.update(job.id, { pendingFix: null, autoFixEnqueued: true });
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
    for (const thread of shell.threads) {
      if (thread.archivedAt != null) {
        continue;
      }
      // Jobs carry no branch, so relevance is origin-thread linkage only; an
      // unlinked queued/running job simply leaves the phase null until the
      // runner links it on success.
      const relevant = jobs.filter((job) => String(job.originThreadId ?? "") === String(thread.id));
      const desired = deriveAutoReviewThreadPhase({
        jobs: relevant,
        threadId: String(thread.id),
        threadBusy: isAutoReviewFixThreadBusy(busyInputForThread(thread, now)),
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

    const dispatchFix: FixDispatch = (threadId, prompt) =>
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
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          })
          .pipe(Effect.asVoid);
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

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
          return {
            cwd: project?.workspaceRoot ?? "",
            candidates: shell.threads
              .filter(
                (thread) => String(thread.projectId) === job.projectId && thread.archivedAt == null,
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
            queueOrDispatchFix: makeQueueOrDispatchFix({ shell, store, dispatchFix }),
          } satisfies AutoReviewRunner.AutoReviewOriginContext;
        }),
      drainPendingFixes: makeDrainPendingFixes({ getShell, store, dispatchFix }),
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
