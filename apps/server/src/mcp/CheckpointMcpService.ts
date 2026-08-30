import {
  CheckpointMcpFailure,
  type CheckpointMcpDiffInput,
  type CheckpointMcpDiffResult,
  type CheckpointMcpListInput,
  type CheckpointMcpListResult,
  type CheckpointMcpRestoreBlocker,
  type CheckpointMcpSummary,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_FILE_LIMIT = 20;
const DEFAULT_DIFF_LIMIT = 20_000;

export class CheckpointMcpService extends Context.Service<
  CheckpointMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: CheckpointMcpListInput,
    ) => Effect.Effect<CheckpointMcpListResult, CheckpointMcpFailure>;
    readonly diff: (
      scope: McpInvocationScope,
      input: CheckpointMcpDiffInput,
    ) => Effect.Effect<CheckpointMcpDiffResult, CheckpointMcpFailure>;
  }
>()("t3/mcp/CheckpointMcpService") {}

function failure(code: CheckpointMcpFailure["code"], message: string): CheckpointMcpFailure {
  return new CheckpointMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { readonly message: unknown }).message);
  }
  return String(error);
}

function providerTurnForRun(projection: OrchestrationV2ThreadProjection, runOrdinal: number) {
  const run = projection.runs.find((candidate) => candidate.ordinal === runOrdinal);
  if (run?.activeAttemptId === null || run === undefined) return undefined;
  return (
    projection.providerTurns.find((turn) => turn.runAttemptId === run.activeAttemptId) ??
    projection.providerTurns.find((turn) => {
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      return attempt?.providerTurnId === turn.id;
    })
  );
}

function restoreBlockers(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly scope: OrchestrationV2CheckpointScope | undefined;
  readonly refAvailable: boolean;
}): ReadonlyArray<CheckpointMcpRestoreBlocker> {
  const { projection, checkpoint, scope } = input;
  const blockers = new Set<CheckpointMcpRestoreBlocker>();
  if (projection.thread.archivedAt !== null) blockers.add("thread_archived");
  if (
    projection.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    )
  ) {
    blockers.add("thread_active");
  }
  if (checkpoint.status !== "ready") blockers.add("checkpoint_not_ready");
  if (scope === undefined) blockers.add("scope_missing");
  if (!input.refAvailable) blockers.add("ref_unavailable");

  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (providerThread === undefined) {
    blockers.add("active_provider_thread_missing");
    return [...blockers];
  }
  if (providerThread.providerSessionId === null) {
    blockers.add("provider_session_missing");
    return [...blockers];
  }
  const providerSession = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  if (providerSession === undefined) {
    blockers.add("provider_session_missing");
    return [...blockers];
  }
  if (
    !providerSession.capabilities.threads.canRollbackThread ||
    !providerSession.capabilities.checkpointing.providerCanRollbackConversation
  ) {
    blockers.add("provider_rollback_unsupported");
  }
  if (!providerSession.capabilities.checkpointing.providerRollbackReturnsSnapshot) {
    blockers.add("provider_snapshot_unsupported");
  }

  const runOrdinal = checkpoint.appRunOrdinal ?? 0;
  if (runOrdinal > 0) {
    const providerTurn = providerTurnForRun(projection, runOrdinal);
    if (providerTurn === undefined) {
      blockers.add("provider_turn_missing");
    } else if (providerTurn.providerThreadId !== providerThread.id) {
      blockers.add("provider_thread_mismatch");
    }
  }
  return [...blockers];
}

function isSurrogateBoundary(value: string, cursor: number): boolean {
  if (cursor <= 0 || cursor >= value.length) return false;
  const before = value.charCodeAt(cursor - 1);
  const after = value.charCodeAt(cursor);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadThread = Effect.fn("CheckpointMcpService.loadThread")(function* (
    scope: McpInvocationScope,
    requestedThreadId: CheckpointMcpListInput["threadId"],
  ) {
    const caller = yield* threadManagement.getThreadProjection(scope.threadId).pipe(
      Effect.mapError(() =>
        failure("thread_not_found", `Calling thread '${scope.threadId}' was not found.`),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Calling thread '${scope.threadId}' was not found.`),
      ),
    );
    const threadId = requestedThreadId ?? scope.threadId;
    if (threadId === scope.threadId) return caller;
    return yield* threadManagement
      .getProjectThread({ projectId: caller.thread.projectId, threadId })
      .pipe(
        Effect.mapError(() =>
          failure(
            "thread_not_found",
            `Thread '${threadId}' was not found in the calling thread's project.`,
          ),
        ),
      );
  });

  const readAvailability = Effect.fn("CheckpointMcpService.readAvailability")(function* (
    checkpoint: OrchestrationV2Checkpoint,
    scope: OrchestrationV2CheckpointScope | undefined,
  ) {
    if (scope === undefined) {
      return {
        availability: "metadata_incomplete" as const,
        detail: `Checkpoint scope '${checkpoint.scopeId}' is missing.`,
        refAvailable: false,
      };
    }
    if (checkpoint.status === "missing") {
      return {
        availability: "ref_missing" as const,
        detail: "The durable checkpoint metadata records a missing filesystem ref.",
        refAvailable: false,
      };
    }
    if (checkpoint.status !== "ready") {
      return {
        availability: "metadata_incomplete" as const,
        detail: `Checkpoint status is '${checkpoint.status}'.`,
        refAvailable: false,
      };
    }
    return yield* checkpointStore
      .hasCheckpointRef({ cwd: scope.cwd, checkpointRef: checkpoint.ref })
      .pipe(
        Effect.match({
          onFailure: (error) => ({
            availability: "unreadable" as const,
            detail: errorMessage(error),
            refAvailable: false,
          }),
          onSuccess: (exists) => ({
            availability: exists ? ("available" as const) : ("ref_missing" as const),
            detail: exists ? null : "The checkpoint filesystem ref does not exist.",
            refAvailable: exists,
          }),
        }),
      );
  });

  const list: CheckpointMcpService["Service"]["list"] = Effect.fn("CheckpointMcpService.list")(
    function* (scope, input) {
      yield* requireCapability(scope);
      const projection = yield* loadThread(scope, input.threadId);
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      const fileLimit = input.fileLimit ?? DEFAULT_FILE_LIMIT;
      const ordered = [...projection.checkpoints].sort(
        (left, right) =>
          DateTime.toEpochMillis(right.capturedAt) - DateTime.toEpochMillis(left.capturedAt) ||
          right.ordinalWithinScope - left.ordinalWithinScope,
      );
      if (cursor > ordered.length) {
        return yield* failure(
          "invalid_request",
          `cursor ${cursor} exceeds the checkpoint count ${ordered.length}.`,
        );
      }
      const selected = ordered.slice(cursor, cursor + limit);
      const checkpoints = yield* Effect.forEach(
        selected,
        (checkpoint): Effect.Effect<CheckpointMcpSummary> => {
          const scopeSummary = projection.checkpointScopes.find(
            (candidate) => candidate.id === checkpoint.scopeId,
          );
          return readAvailability(checkpoint, scopeSummary).pipe(
            Effect.map((availability) => {
              const blockers = restoreBlockers({
                projection,
                checkpoint,
                scope: scopeSummary,
                refAvailable: availability.refAvailable,
              });
              return {
                checkpointId: checkpoint.id,
                scopeId: checkpoint.scopeId,
                threadId: checkpoint.threadId,
                runId: checkpoint.runId,
                nodeId: checkpoint.nodeId,
                parentCheckpointId: checkpoint.parentCheckpointId,
                ordinalWithinScope: checkpoint.ordinalWithinScope,
                appRunOrdinal: checkpoint.appRunOrdinal,
                status: checkpoint.status,
                capturedAt: DateTime.formatIso(checkpoint.capturedAt),
                scope:
                  scopeSummary === undefined
                    ? null
                    : {
                        scopeId: scopeSummary.id,
                        runId: scopeSummary.runId,
                        nodeId: scopeSummary.nodeId,
                        parentScopeId: scopeSummary.parentScopeId,
                        providerThreadId: scopeSummary.providerThreadId,
                        kind: scopeSummary.kind,
                        ordinalWithinParent: scopeSummary.ordinalWithinParent,
                        advancesAppRunCount: scopeSummary.advancesAppRunCount,
                        workspacePath: scopeSummary.cwd,
                        createdAt: DateTime.formatIso(scopeSummary.createdAt),
                      },
                files: checkpoint.files.slice(0, fileLimit),
                fileCount: checkpoint.files.length,
                filesTruncated: checkpoint.files.length > fileLimit,
                availability: availability.availability,
                availabilityDetail: availability.detail,
                restoreSupport: { supported: blockers.length === 0, blockers },
              };
            }),
          );
        },
        { concurrency: 4 },
      );
      const next = cursor + selected.length;
      return {
        currentThreadId: scope.threadId,
        threadId: projection.thread.id,
        checkpoints,
        nextCursor: next < ordered.length ? next : null,
        total: ordered.length,
      };
    },
  );

  const diff: CheckpointMcpService["Service"]["diff"] = Effect.fn("CheckpointMcpService.diff")(
    function* (scope, input) {
      yield* requireCapability(scope);
      const projection = yield* loadThread(scope, input.threadId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === input.scopeId,
      );
      if (checkpointScope === undefined || checkpointScope.threadId !== projection.thread.id) {
        return yield* failure(
          "scope_mismatch",
          `Checkpoint scope '${input.scopeId}' does not belong to thread '${projection.thread.id}'.`,
        );
      }
      const target = projection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId,
      );
      if (target === undefined || target.threadId !== projection.thread.id) {
        return yield* failure(
          "checkpoint_not_found",
          `Checkpoint '${input.checkpointId}' was not found on thread '${projection.thread.id}'.`,
        );
      }
      if (target.scopeId !== checkpointScope.id) {
        return yield* failure(
          "scope_mismatch",
          `Checkpoint '${target.id}' belongs to scope '${target.scopeId}', not '${checkpointScope.id}'.`,
        );
      }
      const fromCheckpointId = input.fromCheckpointId ?? target.parentCheckpointId ?? target.id;
      const from = projection.checkpoints.find((candidate) => candidate.id === fromCheckpointId);
      if (from === undefined || from.threadId !== projection.thread.id) {
        return yield* failure(
          "checkpoint_not_found",
          `Baseline checkpoint '${fromCheckpointId}' was not found on thread '${projection.thread.id}'.`,
        );
      }
      if (from.scopeId !== checkpointScope.id) {
        return yield* failure(
          "scope_mismatch",
          `Baseline checkpoint '${from.id}' belongs to scope '${from.scopeId}', not '${checkpointScope.id}'.`,
        );
      }
      if (target.status !== "ready" || from.status !== "ready") {
        return yield* failure(
          "checkpoint_unavailable",
          "Both checkpoints must have ready durable metadata before their diff can be read.",
        );
      }
      const targetAvailable = yield* checkpointStore
        .hasCheckpointRef({ cwd: checkpointScope.cwd, checkpointRef: target.ref })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "operation_failed",
              `Unable to read target checkpoint ref: ${errorMessage(error)}`,
            ),
          ),
        );
      const fromAvailable =
        from.id === target.id
          ? targetAvailable
          : yield* checkpointStore
              .hasCheckpointRef({ cwd: checkpointScope.cwd, checkpointRef: from.ref })
              .pipe(
                Effect.mapError((error) =>
                  failure(
                    "operation_failed",
                    `Unable to read baseline checkpoint ref: ${errorMessage(error)}`,
                  ),
                ),
              );
      if (!targetAvailable || !fromAvailable) {
        return yield* failure(
          "checkpoint_unavailable",
          "One or both checkpoint filesystem refs are missing.",
        );
      }

      const completeDiff =
        from.id === target.id
          ? ""
          : yield* checkpointStore
              .diffCheckpoints({
                cwd: checkpointScope.cwd,
                fromCheckpointRef: from.ref,
                toCheckpointRef: target.ref,
                fallbackFromToHead: false,
                ignoreWhitespace: input.ignoreWhitespace ?? true,
              })
              .pipe(
                Effect.mapError((error) =>
                  failure(
                    "operation_failed",
                    `Unable to compute checkpoint diff: ${errorMessage(error)}`,
                  ),
                ),
              );
      const cursor = input.cursor ?? 0;
      if (cursor > completeDiff.length || isSurrogateBoundary(completeDiff, cursor)) {
        return yield* failure(
          "invalid_request",
          `cursor ${cursor} is not a valid UTF-16 boundary for this diff.`,
        );
      }
      const limit = input.limit ?? DEFAULT_DIFF_LIMIT;
      let end = Math.min(completeDiff.length, cursor + limit);
      if (isSurrogateBoundary(completeDiff, end)) end += 1;
      return {
        threadId: projection.thread.id,
        scopeId: checkpointScope.id,
        fromCheckpointId: from.id,
        checkpointId: target.id,
        diff: completeDiff.slice(cursor, end),
        cursor,
        nextCursor: end < completeDiff.length ? end : null,
        totalLength: completeDiff.length,
        truncated: cursor > 0 || end < completeDiff.length,
      };
    },
  );

  return CheckpointMcpService.of({ list, diff });
});

export const layer: Layer.Layer<
  CheckpointMcpService,
  never,
  ThreadManagementService | CheckpointStore.CheckpointStore
> = Layer.effect(CheckpointMcpService, make);
