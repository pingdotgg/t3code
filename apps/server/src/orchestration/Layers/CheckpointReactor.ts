import {
  CommandId,
  type CheckpointRef,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { PreTurnCheckpoint } from "../Services/PreTurnCheckpoint.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { OrchestrationCommandInvariantError, type OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
      readonly revertRecovery?: {
        readonly providerRollbackStarted: boolean;
      };
    };

type ProviderTurnTerminalEvent = Extract<
  ProviderRuntimeEvent,
  { type: "turn.completed" | "turn.aborted" }
>;

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

function revertRollbackStartedCommandId(requestCommandId: CommandId): CommandId {
  return CommandId.make(`checkpoint:revert-provider-rollback-started:${requestCommandId}`);
}

function revertCompleteCommandId(requestCommandId: CommandId): CommandId {
  return CommandId.make(`checkpoint:revert-complete:${requestCommandId}`);
}

function isRevertRollbackStartedEventFor(
  event: OrchestrationEvent,
  requestCommandId: CommandId,
): boolean {
  return (
    event.type === "thread.activity-appended" &&
    event.commandId === revertRollbackStartedCommandId(requestCommandId)
  );
}

function isRevertCompletedEventFor(
  event: OrchestrationEvent,
  requestCommandId: CommandId,
): boolean {
  return (
    event.type === "thread.reverted" &&
    event.commandId === revertCompleteCommandId(requestCommandId)
  );
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const preTurnCheckpoint = yield* PreTurnCheckpoint;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const sql = yield* SqlClient.SqlClient;

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const retryPostRestore = <A, E, R>(
    operation: string,
    context: Readonly<Record<string, unknown>>,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`checkpoint revert ${operation} failed; retrying`, {
          ...context,
          error,
        }),
      ),
      Effect.retry(
        Schedule.exponential("100 millis").pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, Duration.seconds(5))),
          ),
        ),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!isGitWorkspace(cwd)) {
      return undefined;
    }
    return cwd;
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: ProviderTurnTerminalEvent, resolvedCheckpointCwd?: string) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd =
        resolvedCheckpointCwd ??
        (yield* resolveCheckpointCwd({
          threadId: thread.id,
          thread,
          projects,
          preferSessionRuntime: true,
        }));
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status:
          event.type === "turn.completed"
            ? checkpointStatusFromRuntime(event.payload.state)
            : "ready",
        assistantMessageId: undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const recordCompletionCheckpointFailure = Effect.fn("recordCompletionCheckpointFailure")(
    function* (event: ProviderTurnTerminalEvent, detail: string) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const checkpointTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;
      const checkpointRef = checkpointRefForThreadTurn(thread.id, checkpointTurnCount);
      const assistantMessageId =
        thread.messages
          .toReversed()
          .find((entry) => entry.role === "assistant" && entry.turnId === turnId)?.id ??
        MessageId.make(`assistant:${turnId}`);

      yield* appendCaptureFailureActivity({
        threadId: thread.id,
        turnId,
        detail,
        createdAt: event.createdAt,
      }).pipe(Effect.catch(() => Effect.void));
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make(`checkpoint:completion-error:${event.eventId}`),
        threadId: thread.id,
        turnId,
        completedAt: event.createdAt,
        checkpointRef,
        status: "error",
        files: [],
        assistantMessageId,
        checkpointTurnCount,
        createdAt: event.createdAt,
      });
      yield* receiptBus.publish({
        type: "checkpoint.diff.finalized",
        threadId: thread.id,
        turnId,
        checkpointTurnCount,
        checkpointRef,
        status: "error",
        createdAt: event.createdAt,
      });
      yield* receiptBus.publish({
        type: "turn.processing.quiesced",
        threadId: thread.id,
        turnId,
        checkpointTurnCount,
        createdAt: event.createdAt,
      });
    },
  );

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fn("captureCheckpointFromPlaceholder")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    // Only replace placeholders; skip events from our own real captures.
    if (status !== "missing") {
      return;
    }

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // turn.diff.updated is a live, mid-turn signal. Its placeholder may be
    // projected for UI bookkeeping, but materializing it while a provider is
    // still active would freeze a partial workspace boundary and make terminal
    // finalization skip all later writes from the same turn.
    if (thread.session?.status === "starting" || thread.session?.status === "running") {
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* preTurnCheckpoint.withWorkspaceBoundary(
      checkpointCwd,
      Effect.gen(function* () {
        // A terminal runtime event can race this placeholder path. Re-read
        // after taking the shared boundary so only one path materializes and
        // projects the checkpoint.
        const currentThread = yield* resolveThreadDetail(threadId);
        if (!currentThread) {
          return;
        }
        if (
          currentThread.checkpoints.some(
            (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
          )
        ) {
          return;
        }

        yield* captureAndDispatchCheckpoint({
          threadId,
          turnId,
          thread: currentThread,
          cwd: checkpointCwd,
          turnCount: checkpointTurnCount,
          status: "ready",
          assistantMessageId: event.payload.assistantMessageId ?? undefined,
          createdAt: event.payload.completedAt,
        });
      }),
    );
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      if (!toTurnId(event.turnId)) {
        return;
      }
      yield* preTurnCheckpoint.ensure({
        threadId: event.threadId,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: ProviderTurnTerminalEvent) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd ||
        isTemporaryWorktreeBranch(thread.branch)
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  const finalizeTurnCompletion: CheckpointReactorShape["finalizeTurnCompletion"] = Effect.fn(
    "CheckpointReactor.finalizeTurnCompletion",
  )(function* (event) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }
    const thread = yield* resolveThreadDetail(event.threadId);
    if (!thread) {
      return;
    }
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
      return;
    }
    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* preTurnCheckpoint.withWorkspaceBoundary(
      checkpointCwd,
      Effect.gen(function* () {
        // Runtime ingestion and the background provider subscription can both
        // observe the same terminal event. Re-read after acquiring the shared
        // boundary so the loser avoids a duplicate git-status refresh/capture.
        const currentThread = yield* resolveThreadDetail(event.threadId);
        if (!currentThread) {
          return;
        }
        if (
          currentThread.session?.activeTurnId &&
          !sameId(currentThread.session.activeTurnId, turnId)
        ) {
          return;
        }
        if (
          currentThread.checkpoints.some(
            (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
          )
        ) {
          return;
        }

        yield* refreshLocalGitStatusFromTurnCompletion(event);
        yield* captureCheckpointFromTurnCompletion(event, checkpointCwd).pipe(
          Effect.catch((error) => recordCompletionCheckpointFailure(event, error.message)),
        );
      }),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    yield* preTurnCheckpoint.ensure({
      threadId: event.payload.threadId,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
    recovery?: { readonly providerRollbackStarted: boolean },
  ) {
    const requestCommandId = event.commandId;
    if (requestCommandId === null) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: "thread.checkpoint.revert",
        detail: `Persisted revert request '${event.eventId}' is missing its command id.`,
      });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const initialThread = yield* resolveThreadDetail(event.payload.threadId);
    if (!initialThread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    const initialProjects = yield* resolveThreadProjects(initialThread.projectId);
    const cwd = yield* resolveCheckpointCwd({
      threadId: initialThread.id,
      thread: initialThread,
      projects: initialProjects,
      preferSessionRuntime: true,
    });
    if (!cwd) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this thread has no git workspace.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    yield* preTurnCheckpoint.withWorkspaceBoundary(
      cwd,
      Effect.gen(function* () {
        // A completion or another revert may have advanced the read model
        // while this event waited for the workspace boundary. Re-read inside
        // the lock and keep restore, provider rollback, stale-ref cleanup, and
        // projection completion in the same filesystem boundary.
        const thread = yield* resolveThreadDetail(event.payload.threadId);
        if (!thread) {
          yield* appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: "Thread was not found in read model.",
            createdAt: now,
          }).pipe(Effect.catch(() => Effect.void));
          return;
        }

        const currentTurnCount = thread.checkpoints.reduce(
          (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
          0,
        );

        if (event.payload.turnCount > currentTurnCount) {
          yield* appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
            createdAt: now,
          }).pipe(Effect.catch(() => Effect.void));
          return;
        }

        const targetCheckpointRef =
          event.payload.turnCount === 0
            ? checkpointRefForThreadTurn(event.payload.threadId, 0)
            : thread.checkpoints.find(
                (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
              )?.checkpointRef;

        if (!targetCheckpointRef) {
          yield* appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
            createdAt: now,
          }).pipe(Effect.catch(() => Effect.void));
          return;
        }

        const restored = yield* checkpointStore.restoreCheckpoint({
          cwd,
          checkpointRef: targetCheckpointRef,
          fallbackToHead: event.payload.turnCount === 0,
        });
        if (!restored) {
          yield* appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
            createdAt: now,
          }).pipe(Effect.catch(() => Effect.void));
          return;
        }

        // Once restore succeeds, returning with the old projected history is
        // unsafe: the workspace and provider/read-model timelines would refer
        // to different turns. Keep this tail uninterruptible and retry the
        // authoritative cleanup/projection operations until they persist.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* workspaceEntries.refresh(cwd).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("checkpoint revert workspace refresh failed", {
                  threadId: event.payload.threadId,
                  turnCount: event.payload.turnCount,
                  cwd,
                  cause: Cause.pretty(cause),
                }),
              ),
            );

            const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
            const providerRollbackOutcomeUnknown =
              rolledBackTurns > 0 && recovery?.providerRollbackStarted === true;
            let providerRollbackFailure: string | null = providerRollbackOutcomeUnknown
              ? "Provider rollback may already have completed before the server restarted. It was not repeated."
              : null;
            let providerSessionStopped = false;
            if (rolledBackTurns > 0 && !providerRollbackOutcomeUnknown) {
              // Persist the irreversible phase boundary before invoking the
              // provider's relative rollback. Recovery can then avoid applying
              // the same relative operation twice after an outcome-unknown
              // process crash.
              yield* retryPostRestore(
                "provider rollback phase marker",
                { threadId: event.payload.threadId, turnCount: event.payload.turnCount },
                orchestrationEngine.dispatch({
                  type: "thread.activity.append",
                  commandId: revertRollbackStartedCommandId(requestCommandId),
                  threadId: event.payload.threadId,
                  activity: {
                    id: EventId.make(
                      `checkpoint:revert-provider-rollback-started:${requestCommandId}`,
                    ),
                    tone: "info",
                    kind: "checkpoint.revert.provider-rollback.started",
                    summary: "Synchronizing provider conversation",
                    payload: {
                      turnCount: event.payload.turnCount,
                      rolledBackTurns,
                    },
                    turnId: null,
                    createdAt: now,
                  },
                  createdAt: now,
                }),
              );

              const rollbackExit = yield* Effect.exit(
                providerService.rollbackConversation({
                  threadId: event.payload.threadId,
                  numTurns: rolledBackTurns,
                }),
              );
              if (Exit.isFailure(rollbackExit)) {
                providerRollbackFailure = Cause.pretty(rollbackExit.cause);
                yield* Effect.logWarning(
                  "checkpoint filesystem restored but provider conversation rollback failed",
                  {
                    threadId: event.payload.threadId,
                    turnCount: event.payload.turnCount,
                    rolledBackTurns,
                    cause: providerRollbackFailure,
                  },
                );
              }
            }

            if (providerRollbackFailure !== null) {
              // Do not leave an outcome-unknown or stale provider process
              // available for the next turn. Even if stop itself fails, the
              // projected error state below makes the inconsistency visible.
              const stopExit = yield* Effect.exit(
                providerService.stopSession({ threadId: event.payload.threadId }),
              );
              providerSessionStopped = Exit.isSuccess(stopExit);
              if (Exit.isFailure(stopExit)) {
                yield* Effect.logWarning(
                  "checkpoint revert failed to stop desynchronized provider session",
                  {
                    threadId: event.payload.threadId,
                    cause: Cause.pretty(stopExit.cause),
                  },
                );
              }

              const currentSession = thread.session;
              yield* retryPostRestore(
                "provider quarantine projection",
                { threadId: event.payload.threadId, turnCount: event.payload.turnCount },
                orchestrationEngine.dispatch({
                  type: "thread.session.set",
                  commandId: CommandId.make(
                    `checkpoint:revert-provider-quarantine:${requestCommandId}`,
                  ),
                  threadId: event.payload.threadId,
                  session: {
                    threadId: event.payload.threadId,
                    status: providerSessionStopped ? "stopped" : "error",
                    providerName: currentSession?.providerName ?? null,
                    ...(currentSession?.providerInstanceId !== undefined
                      ? { providerInstanceId: currentSession.providerInstanceId }
                      : {}),
                    runtimeMode: currentSession?.runtimeMode ?? thread.runtimeMode,
                    activeTurnId: null,
                    lastError: providerRollbackOutcomeUnknown
                      ? `Workspace reverted, but provider rollback outcome is unknown after restart: ${providerRollbackFailure}`
                      : `Workspace reverted, but provider conversation rollback failed: ${providerRollbackFailure}`,
                    updatedAt: now,
                  },
                  createdAt: now,
                }),
              );
            }

            const staleCheckpointRefs: Array<CheckpointRef> = [];
            for (const checkpoint of thread.checkpoints) {
              if (checkpoint.checkpointTurnCount > event.payload.turnCount) {
                staleCheckpointRefs.push(checkpoint.checkpointRef);
              }
            }

            if (staleCheckpointRefs.length > 0) {
              yield* retryPostRestore(
                "stale ref cleanup",
                { threadId: event.payload.threadId, turnCount: event.payload.turnCount, cwd },
                checkpointStore.deleteCheckpointRefs({
                  cwd,
                  checkpointRefs: staleCheckpointRefs,
                }),
              );
            }

            yield* retryPostRestore(
              "projection completion",
              { threadId: event.payload.threadId, turnCount: event.payload.turnCount },
              orchestrationEngine.dispatch({
                type: "thread.revert.complete",
                commandId: revertCompleteCommandId(requestCommandId),
                threadId: event.payload.threadId,
                turnCount: event.payload.turnCount,
                createdAt: now,
              }),
            );

            if (providerRollbackFailure !== null) {
              yield* retryPostRestore(
                "provider rollback failure activity",
                { threadId: event.payload.threadId, turnCount: event.payload.turnCount },
                orchestrationEngine.dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.make(
                    `checkpoint:revert-provider-rollback-${providerRollbackOutcomeUnknown ? "unknown" : "failed"}:${requestCommandId}`,
                  ),
                  threadId: event.payload.threadId,
                  activity: {
                    id: EventId.make(
                      `checkpoint:revert-provider-rollback-${providerRollbackOutcomeUnknown ? "unknown" : "failed"}:${requestCommandId}`,
                    ),
                    tone: "error",
                    kind: providerRollbackOutcomeUnknown
                      ? "checkpoint.revert.provider-rollback.unknown"
                      : "checkpoint.revert.provider-rollback.failed",
                    summary: providerRollbackOutcomeUnknown
                      ? "Workspace reverted; provider rollback outcome was unknown"
                      : "Workspace reverted, but provider rollback failed",
                    payload: {
                      turnCount: event.payload.turnCount,
                      rolledBackTurns,
                      detail: providerRollbackFailure,
                      providerSessionStopped,
                    },
                    turnId: null,
                    createdAt: now,
                  },
                  createdAt: now,
                }),
              );
            }
          }),
        );
      }),
    );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: OrchestrationEvent,
    revertRecovery?: { readonly providerRollbackStarted: boolean },
  ) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event, revertRecovery).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }

    // A provider turn.diff.updated event can create a placeholder checkpoint
    // before its terminal event arrives. React to the projected domain event
    // as an additional opportunity to materialize that placeholder.
    if (event.type === "thread.turn-diff-completed") {
      yield* captureCheckpointFromPlaceholder(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      yield* finalizeTurnCompletion(event);
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain"
      ? processDomainEvent(input.event, input.revertRecovery)
      : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    const providerEvents = yield* providerService.subscribeEvents;
    const processDomainInput = (event: OrchestrationEvent) => {
      if (
        event.type !== "thread.turn-start-requested" &&
        event.type !== "thread.message-sent" &&
        event.type !== "thread.checkpoint-revert-requested" &&
        event.type !== "thread.turn-diff-completed"
      ) {
        return Effect.void;
      }
      return worker.enqueue({ source: "domain", event });
    };

    const domainRecovery = Effect.gen(function* () {
      const recoveryHead = yield* orchestrationEngine.latestSequence;
      const historicalEvents =
        recoveryHead === 0
          ? []
          : yield* sql<{ readonly sequence: number }>`
              SELECT sequence
              FROM orchestration_events
              WHERE sequence <= ${recoveryHead}
                AND (
                  event_type IN (
                    'thread.checkpoint-revert-requested',
                    'thread.reverted'
                  )
                  OR command_id LIKE 'checkpoint:revert-provider-rollback-started:%'
                )
              ORDER BY sequence ASC
            `.pipe(
              Effect.flatMap((rows) =>
                Effect.forEach(
                  rows,
                  (row) =>
                    orchestrationEngine
                      .readEvents(row.sequence - 1, 1)
                      .pipe(Stream.runHead, Effect.map(Option.getOrUndefined)),
                  { concurrency: 1 },
                ),
              ),
              Effect.map((events) => events.filter((event) => event !== undefined)),
              Effect.tapError((error) =>
                Effect.logError("checkpoint revert recovery scan failed; retrying", { error }),
              ),
              Effect.retry(
                Schedule.exponential("100 millis").pipe(
                  Schedule.modifyDelay(({ duration }) =>
                    Effect.succeed(Duration.min(duration, Duration.seconds(5))),
                  ),
                ),
              ),
            );
      const revertRequests = historicalEvents.filter(
        (
          event,
        ): event is Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }> =>
          event.type === "thread.checkpoint-revert-requested" && event.commandId !== null,
      );

      yield* Effect.forEach(
        revertRequests,
        (request) => {
          const requestCommandId = request.commandId;
          if (requestCommandId === null) {
            return Effect.void;
          }
          const completed = historicalEvents.some(
            (event) =>
              isRevertCompletedEventFor(event, requestCommandId) ||
              (event.sequence > request.sequence &&
                event.type === "thread.reverted" &&
                event.payload.threadId === request.payload.threadId &&
                event.payload.turnCount === request.payload.turnCount),
          );
          if (completed) {
            return Effect.void;
          }
          const providerRollbackStarted = historicalEvents.some((event) =>
            isRevertRollbackStartedEventFor(event, requestCommandId),
          );
          return worker.enqueue({
            source: "domain",
            event: request,
            revertRecovery: { providerRollbackStarted },
          });
        },
        { concurrency: 1, discard: true },
      );

      // The subscription was acquired before the replay head. Events at or
      // below that head are covered by the durable scan; filtering them here
      // prevents a recovered relative revert from running twice.
      yield* Stream.runForEach(
        domainEvents.pipe(Stream.filter((event) => event.sequence > recoveryHead)),
        processDomainInput,
      );
    });

    yield* forkParked(domainRecovery);

    yield* forkParked(
      Stream.runForEach(providerEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
    finalizeTurnCompletion,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
