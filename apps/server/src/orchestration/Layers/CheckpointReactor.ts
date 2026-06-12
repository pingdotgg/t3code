import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCheckpointAttribution,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  checkpointAttributedRefForThreadTurn,
  checkpointStartRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { normalizeTouchedPath } from "../../checkpointing/TouchedPaths.ts";
import {
  CHECKPOINT_DIFF_PATHSPEC_LIMIT,
  CheckpointStore,
} from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TurnFileSnapshots } from "../../persistence/Services/TurnFileSnapshots.ts";
import { TurnFileSnapshotsLive } from "../../persistence/Layers/TurnFileSnapshots.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

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

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const turnFileSnapshots = yield* TurnFileSnapshots;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

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

  const checkpointFilesFromDiff = (diff: string) =>
    parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
      path: file.path,
      kind: "modified" as const,
      additions: file.additions,
      deletions: file.deletions,
    }));

  const normalizeSnapshotRows = (
    rows: ReadonlyArray<{
      readonly path: string;
      readonly blobSha: string | null;
      readonly deleted: boolean;
    }>,
    cwd: string,
  ) => {
    const rowsByPath = new Map<
      string,
      {
        readonly path: string;
        readonly blobSha: string | null;
        readonly deleted: boolean;
      }
    >();
    for (const row of rows) {
      const normalizedPath = normalizeTouchedPath(row.path, cwd);
      if (!normalizedPath) {
        continue;
      }
      rowsByPath.set(normalizedPath, {
        path: normalizedPath,
        blobSha: row.blobSha,
        deleted: row.deleted,
      });
    }
    return [...rowsByPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
  };

  const resolveOverlayEntries = Effect.fn("resolveOverlayEntries")(function* (input: {
    readonly cwd: string;
    readonly endCheckpointRef: ReturnType<typeof checkpointRefForThreadTurn>;
    readonly rows: ReturnType<typeof normalizeSnapshotRows>;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) {
    const entries: Array<{ readonly path: string; readonly blobSha: string | null }> = [];
    for (const row of input.rows) {
      if (row.deleted || row.blobSha !== null) {
        entries.push({
          path: row.path,
          blobSha: row.deleted ? null : row.blobSha,
        });
        continue;
      }

      const blobShaResult = yield* checkpointStore
        .readCheckpointFileBlob({
          cwd: input.cwd,
          checkpointRef: input.endCheckpointRef,
          path: row.path,
        })
        .pipe(Effect.result);
      if (blobShaResult._tag === "Failure") {
        yield* Effect.logWarning("checkpoint attribution path-only overlay lookup failed", {
          threadId: input.threadId,
          turnId: input.turnId,
          path: row.path,
          detail: blobShaResult.failure.message,
        });
        return null;
      }

      entries.push({
        path: row.path,
        blobSha: blobShaResult.success,
      });
    }
    return entries;
  });

  const buildAttributedTurnDiff = Effect.fn("buildAttributedTurnDiff")(function* (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly turnCount: number;
    readonly fromCheckpointRef: ReturnType<typeof checkpointRefForThreadTurn>;
    readonly targetCheckpointRef: ReturnType<typeof checkpointRefForThreadTurn>;
  }) {
    const storedRows = yield* turnFileSnapshots.getByTurn({
      threadId: input.threadId,
      turnId: input.turnId,
    });
    const rows = normalizeSnapshotRows(storedRows, input.cwd);
    const attributedCheckpointRef = checkpointAttributedRefForThreadTurn(
      input.threadId,
      input.turnCount,
    );

    let attribution: OrchestrationCheckpointAttribution = "unattributed";
    let toCheckpointRef = input.targetCheckpointRef;
    let paths: ReadonlyArray<string> | undefined;

    if (rows.length > CHECKPOINT_DIFF_PATHSPEC_LIMIT) {
      yield* Effect.logWarning("checkpoint attribution skipped: touched path count exceeds cap", {
        threadId: input.threadId,
        turnId: input.turnId,
        pathCount: rows.length,
        pathLimit: CHECKPOINT_DIFF_PATHSPEC_LIMIT,
      });
    } else if (rows.length > 0) {
      const hasEditSnapshotRows = rows.some((row) => row.deleted || row.blobSha !== null);
      if (hasEditSnapshotRows) {
        const overlayEntries = yield* resolveOverlayEntries({
          cwd: input.cwd,
          endCheckpointRef: input.targetCheckpointRef,
          rows,
          threadId: input.threadId,
          turnId: input.turnId,
        });

        if (overlayEntries !== null) {
          const overlayResult = yield* checkpointStore
            .captureOverlayCheckpoint({
              cwd: input.cwd,
              baseCheckpointRef: input.fromCheckpointRef,
              checkpointRef: attributedCheckpointRef,
              entries: overlayEntries,
            })
            .pipe(Effect.result);

          if (overlayResult._tag === "Success") {
            attribution = "edit-snapshots";
            toCheckpointRef = attributedCheckpointRef;
          } else {
            yield* Effect.logWarning("checkpoint attribution overlay capture failed", {
              threadId: input.threadId,
              turnId: input.turnId,
              detail: overlayResult.failure.message,
            });
          }
        }
      }

      if (attribution !== "edit-snapshots") {
        attribution = "touched-paths";
        paths = rows.map((row) => row.path);
      }
    }

    const diff = yield* checkpointStore.diffCheckpoints({
      cwd: input.cwd,
      fromCheckpointRef: input.fromCheckpointRef,
      toCheckpointRef,
      fallbackFromToHead: false,
      ignoreWhitespace: false,
      ...(paths !== undefined ? { paths } : {}),
    });

    return { diff, attribution };
  });

  const captureTurnStartCheckpoint = Effect.fn("captureTurnStartCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly currentTurnCount: number;
    readonly createdAt: string;
  }) {
    const baselineCheckpointRef = checkpointRefForThreadTurn(
      input.threadId,
      input.currentTurnCount,
    );
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (!baselineExists) {
      yield* checkpointStore.captureCheckpoint({
        cwd: input.cwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: input.threadId,
        checkpointTurnCount: input.currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: input.createdAt,
      });
    }

    const turnStartRef = checkpointStartRefForThreadTurn(
      input.threadId,
      input.currentTurnCount + 1,
    );
    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: turnStartRef,
    });
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
    const fallbackFromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const turnStartCheckpointRef = checkpointStartRefForThreadTurn(input.threadId, input.turnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const turnStartCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: turnStartCheckpointRef,
    });
    const fromCheckpointRef = turnStartCheckpointExists
      ? turnStartCheckpointRef
      : fallbackFromCheckpointRef;
    const fromCheckpointExists = turnStartCheckpointExists
      ? true
      : yield* checkpointStore.hasCheckpointRef({
          cwd: input.cwd,
          checkpointRef: fallbackFromCheckpointRef,
        });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    } else if (!turnStartCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing turn-start baseline; using fallback", {
        threadId: input.threadId,
        turnId: input.turnId,
        turnCount: input.turnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.invalidate(input.cwd);

    const diffSummary = yield* buildAttributedTurnDiff({
      cwd: input.cwd,
      threadId: input.threadId,
      turnId: input.turnId,
      turnCount: input.turnCount,
      fromCheckpointRef,
      targetCheckpointRef,
    }).pipe(
      Effect.catch((error) =>
        checkpointStore
          .diffCheckpoints({
            cwd: input.cwd,
            fromCheckpointRef,
            toCheckpointRef: targetCheckpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
          })
          .pipe(
            Effect.map((diff) => ({ diff, attribution: "unattributed" as const })),
            Effect.tapError((fallbackError) =>
              appendCaptureFailureActivity({
                threadId: input.threadId,
                turnId: input.turnId,
                detail: `Checkpoint captured, but turn diff summary is unavailable: ${fallbackError.message}`,
                createdAt: input.createdAt,
              }),
            ),
            Effect.catch((fallbackError) =>
              Effect.logWarning("failed to derive checkpoint file summary", {
                threadId: input.threadId,
                turnId: input.turnId,
                turnCount: input.turnCount,
                detail: fallbackError.message,
                attributionDetail: error.message,
              }).pipe(Effect.as({ diff: "", attribution: "unattributed" as const })),
            ),
          ),
      ),
    );

    const files = checkpointFilesFromDiff(diffSummary.diff);

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
      attribution: diffSummary.attribution,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    // Captures run only at turn completion or after the session has settled, so
    // deleting consumed edit snapshots cannot erase mid-turn baselines.
    yield* turnFileSnapshots.deleteByTurn({
      threadId: input.threadId,
      turnId: input.turnId,
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
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
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

      // Reuse any existing read-model checkpoint for this turn. Completion is
      // authoritative, and the projector replaces checkpoints by turnId.
      const existingCheckpoint = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId,
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingCheckpoint
        ? existingCheckpoint.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status: checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const finalizeMissingCheckpoint = Effect.fn("finalizeMissingCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly checkpointTurnCount: number;
    readonly assistantMessageId: MessageId | null;
    readonly completedAt: string;
  }) {
    const projects = yield* resolveThreadProjects(input.thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: input.threadId,
      thread: input.thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId: input.threadId,
      turnId: input.turnId,
      thread: input.thread,
      cwd: checkpointCwd,
      turnCount: input.checkpointTurnCount,
      status: "ready",
      assistantMessageId: input.assistantMessageId ?? undefined,
      createdAt: input.completedAt,
    });
  });

  // ProviderRuntimeIngestion creates placeholder checkpoints on
  // turn.diff.updated. Keep the placeholder while the turn is active; turn
  // completion or the settled-session fallback will replace it with a real git
  // checkpoint.
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

    if (sameId(thread.session?.activeTurnId, turnId)) {
      yield* Effect.logDebug("checkpoint capture from placeholder deferred until turn completion", {
        threadId,
        turnId,
      });
      return;
    }

    yield* finalizeMissingCheckpoint({
      threadId,
      turnId,
      thread,
      checkpointTurnCount,
      assistantMessageId: event.payload.assistantMessageId,
      completedAt: event.payload.completedAt,
    });
  });

  const finalizeMissingCheckpointsFromSettledSession = Effect.fn(
    "finalizeMissingCheckpointsFromSettledSession",
  )(function* (event: Extract<OrchestrationEvent, { type: "thread.session-set" }>) {
    const { session, threadId } = event.payload;
    if (
      session.activeTurnId !== null ||
      session.status === "running" ||
      session.status === "starting"
    ) {
      return;
    }

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint settled-session fallback skipped: thread not found", {
        threadId,
      });
      return;
    }

    const missingCheckpoints = thread.checkpoints.filter(
      (checkpoint) => checkpoint.status === "missing",
    );
    yield* Effect.forEach(
      missingCheckpoints,
      (checkpoint) =>
        finalizeMissingCheckpoint({
          threadId,
          turnId: checkpoint.turnId,
          thread,
          checkpointTurnCount: checkpoint.checkpointTurnCount,
          assistantMessageId: checkpoint.assistantMessageId,
          completedAt: checkpoint.completedAt,
        }),
      { concurrency: 1 },
    );
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      yield* captureTurnStartCheckpoint({
        threadId: thread.id,
        cwd: checkpointCwd,
        currentTurnCount,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }),
      ),
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

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    yield* captureTurnStartCheckpoint({
      threadId,
      cwd: checkpointCwd,
      currentTurnCount,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

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

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!isGitWorkspace(sessionRuntime.value.cwd)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
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
      cwd: sessionRuntime.value.cwd,
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

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects the reverted filesystem state.
    yield* workspaceEntries.invalidate(sessionRuntime.value.cwd);

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: sessionRuntime.value.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);
    const staleAuxiliaryCheckpointRefs = Array.from(
      { length: Math.max(0, currentTurnCount - event.payload.turnCount) },
      (_, index) => event.payload.turnCount + index + 1,
    ).flatMap((turnCount) => [
      checkpointStartRefForThreadTurn(event.payload.threadId, turnCount),
      checkpointAttributedRefForThreadTurn(event.payload.threadId, turnCount),
    ]);

    if (staleCheckpointRefs.length > 0 || staleAuxiliaryCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: [...staleCheckpointRefs, ...staleAuxiliaryCheckpointRefs],
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
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

    // If a turn.completed runtime event is missed or the server restarts while
    // a placeholder is pending, the next settled session snapshot is the
    // authoritative signal that no turn is running and the placeholder can be
    // finalized.
    if (event.type === "thread.session-set") {
      yield* finalizeMissingCheckpointsFromSettledSession(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.payload.threadId,
              turnId: null,
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

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      yield* refreshLocalGitStatusFromTurnCompletion(event);
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
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
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

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
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.turn-diff-completed" &&
          event.type !== "thread.session-set"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (event.type !== "turn.started" && event.type !== "turn.completed") {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make).pipe(
  Layer.provide(TurnFileSnapshotsLive),
);
