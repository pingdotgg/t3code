import {
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { collectOutsideEdits } from "../checkpointing/OutsideEdits.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const CAPTURE_CONCURRENCY = 4;

export class CheckpointCaptureExecutionError extends Schema.TaggedError<CheckpointCaptureExecutionError>()(
  "CheckpointCaptureExecutionError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isCheckpointCaptureExecutionError = Schema.is(CheckpointCaptureExecutionError);

export interface CheckpointCaptureServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scopeId: CheckpointScopeId;
  }) => Effect.Effect<void, CheckpointCaptureExecutionError>;
}

export class CheckpointCaptureServiceV2 extends Context.Service<
  CheckpointCaptureServiceV2,
  CheckpointCaptureServiceV2Shape
>()("t3/orchestration-v2/CheckpointCaptureService/CheckpointCaptureServiceV2") {}

export const layer: Layer.Layer<
  CheckpointCaptureServiceV2,
  never,
  | CheckpointService.CheckpointServiceV2
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(
  CheckpointCaptureServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // The home checkout counts too: a worktree thread can still edit it, and it cannot be tracked.
    const projectFolderPaths = (projectId: ProjectId | undefined) =>
      (projectId === undefined
        ? Effect.succeedNone
        : projects.get(projectId, { includeDeleted: true })
      ).pipe(
        Effect.map(
          Option.match({
            onNone: () => [],
            onSome: (project) => [
              project.workspaceRoot,
              ...project.trackedFolders.map((folder) => folder.path),
            ],
          }),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

    const execute = Effect.fn("orchestrationV2.checkpointCapture.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) {
      const context = yield* projections.getCheckpointCaptureContext(input.threadId, input);
      const {
        run,
        rootNode,
        scope,
        providerThread,
        readyCheckpointOrdinals,
        sideChat,
        serverCompaction,
      } = context;
      // Stopped runs remain terminal; their checkpoint is the next message's rollback point.
      const stopped = run?.status === "interrupted" || run?.status === "cancelled";

      // A checkpoint on a settled run proves this at-least-once effect already committed.
      if (
        run !== undefined &&
        run.checkpointId !== null &&
        (run.status === "completed" || stopped)
      ) {
        return;
      }
      // Rollback uses the same lane and can precede a capture retry; preserve the restored workspace and discarded run.
      if (run?.status === "rolled_back") {
        return;
      }

      if (
        run === undefined ||
        (run.status !== "waiting" && !stopped) ||
        rootNode === undefined ||
        scope === undefined ||
        rootNode.checkpointScopeId !== scope.id ||
        providerThread === undefined
      ) {
        return yield* new CheckpointCaptureExecutionError({
          threadId: input.threadId,
          runId: input.runId,
          scopeId: input.scopeId,
          cause: "The persisted checkpoint capture target is incomplete or no longer waiting.",
        });
      }

      const capturedAt = yield* DateTime.now;
      const baselineOrdinalWithinScope = Math.max(0, run.ordinal - 1);
      const repositoryScopes = context.repositoryScopes;
      // Each scope is checked on its own, so a retry fills only the refs still missing.
      const captureScope = Effect.fnUntraced(function* (target: {
        readonly scope: OrchestrationV2CheckpointScope;
        readonly readyOrdinals: ReadonlySet<number>;
        readonly appRunOrdinal: number | null;
      }) {
        const isRoot = target.scope.id === scope.id;
        // The baselines this capture materializes are attributed to the run materializing them. The
        // thread's scope may already be a later run's: one queued meanwhile, or sent after Stop.
        const materializeBaseline = (ordinalWithinScope: number) =>
          checkpoints.materializeBaselineCheckpoint({
            scope: target.scope,
            ordinalWithinScope,
            nodeId: rootNode.id,
            capturedAt: run.requestedAt,
            forceMissing: sideChat,
          });
        const threadStartCheckpoint =
          !isRoot || baselineOrdinalWithinScope === 0 || target.readyOrdinals.has(0)
            ? null
            : yield* materializeBaseline(0);
        const baselineCheckpoint = target.readyOrdinals.has(baselineOrdinalWithinScope)
          ? null
          : yield* materializeBaseline(baselineOrdinalWithinScope);
        const checkpoint = yield* checkpoints.capture({
          scope: target.scope,
          runId: run.id,
          nodeId: rootNode.id,
          ordinalWithinScope: run.ordinal,
          appRunOrdinal: target.appRunOrdinal,
          capturedAt,
          forceMissing: sideChat || serverCompaction,
          ...(isRoot && repositoryScopes.length > 0 ? { repositoryScopes } : {}),
        });
        return {
          baselines: [threadStartCheckpoint, baselineCheckpoint].filter(
            (baseline): baseline is OrchestrationV2Checkpoint => baseline !== null,
          ),
          checkpoint,
        };
      });
      const [rootCapture, repositoryCaptures] = yield* Effect.all(
        [
          captureScope({
            scope,
            readyOrdinals: new Set(readyCheckpointOrdinals),
            appRunOrdinal: run.ordinal,
          }),
          Effect.forEach(
            repositoryScopes,
            (repositoryScope) =>
              captureScope({
                scope: repositoryScope,
                readyOrdinals: new Set(
                  context.repositoryReadyOrdinals
                    .filter((ready) => ready.scopeId === repositoryScope.id)
                    .map((ready) => ready.ordinal),
                ),
                appRunOrdinal: null,
              }),
            { concurrency: CAPTURE_CONCURRENCY - 1 },
          ),
        ],
        { concurrency: 2 },
      );
      const outsideEdits =
        context.fileChanges.length === 0
          ? []
          : yield* collectOutsideEdits({
              paths: context.fileChanges.flatMap((change) => [
                change.fileName,
                ...change.changes.flatMap((detail) =>
                  detail.oldPath === undefined ? [detail.path] : [detail.path, detail.oldPath],
                ),
              ]),
              cwd: context.providerSessionCwd ?? scope.cwd,
              homeCwd: scope.cwd,
              coveredCwds: [
                ...(rootCapture.checkpoint.status === "missing" ? [] : [scope.cwd]),
                ...repositoryScopes.map((repositoryScope) => repositoryScope.cwd),
              ],
              projectFolderPaths: projectFolderPaths(context.projectId),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("orchestration V2 outside edit scan failed", {
                    runId: run.id,
                    cause,
                  }).pipe(Effect.as([])),
              ),
            );
      const checkpoint =
        outsideEdits.length === 0
          ? rootCapture.checkpoint
          : { ...rootCapture.checkpoint, outsideEdits };
      const commandId = CommandId.make(`command:effect:checkpoint.capture:${run.id}`);
      const checkpointEvent = (payload: OrchestrationV2Checkpoint) =>
        Effect.map(ids.allocate.event({ threadId: input.threadId, commandId }), (id) => ({
          id,
          type: "checkpoint.captured" as const,
          threadId: input.threadId,
          ...(payload.runId === null ? {} : { runId: payload.runId }),
          nodeId: payload.nodeId,
          driver: providerThread.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: capturedAt,
          payload,
        }));
      // Omit delegatedCompletion to preserve cohort writes made after capture loaded the run.
      const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } = run;
      yield* eventSink.commitCommand({
        commandId,
        threadId: input.threadId,
        commandType: "checkpoint.capture",
        acceptedAt: capturedAt,
        effects: [],
        events: [
          ...(yield* Effect.forEach(
            [
              // Root records last: clients that pick the latest ordinal-0 baseline get the thread's.
              ...repositoryCaptures.flatMap((capture) => [
                ...capture.baselines,
                capture.checkpoint,
              ]),
              ...rootCapture.baselines,
              checkpoint,
            ],
            checkpointEvent,
          )),
          {
            id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
            type: "turn-item.updated",
            threadId: input.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            driver: providerThread.driver,
            providerInstanceId: run.providerInstanceId,
            occurredAt: capturedAt,
            payload: makeCheckpointTurnItem({
              idAllocator: ids,
              run,
              rootNode,
              providerThread,
              checkpoint,
              completedAt: capturedAt,
            }),
          },
          {
            id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
            type: "run.updated",
            threadId: input.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: capturedAt,
            payload: stopped
              ? { ...runWithoutDelegatedCompletion, checkpointId: checkpoint.id }
              : {
                  ...runWithoutDelegatedCompletion,
                  status: "completed",
                  completedAt: capturedAt,
                  checkpointId: checkpoint.id,
                },
          },
          ...(stopped
            ? []
            : [
                {
                  id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                  type: "node.updated" as const,
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: rootNode.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: capturedAt,
                  payload: {
                    ...rootNode,
                    status: "completed" as const,
                    completedAt: capturedAt,
                    checkpointScopeId: scope.id,
                  },
                },
              ]),
        ],
      });
    });

    return CheckpointCaptureServiceV2.of({
      execute: Effect.fn("CheckpointCaptureServiceV2.execute")(function (input) {
        return execute(input).pipe(
          Effect.mapError((cause) =>
            isCheckpointCaptureExecutionError(cause)
              ? cause
              : new CheckpointCaptureExecutionError({ ...input, cause }),
          ),
        );
      }),
    });
  }),
);

function makeCheckpointTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly completedAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.turnItemFromProviderItem({
      driver: input.providerThread.driver,
      nativeItemId: `checkpoint:${input.checkpoint.id}`,
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.run.ordinal * 100 + 99,
    status: "completed",
    title: null,
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "checkpoint",
    checkpointId: input.checkpoint.id,
    scopeId: input.checkpoint.scopeId,
    files: input.checkpoint.files,
  };
}
