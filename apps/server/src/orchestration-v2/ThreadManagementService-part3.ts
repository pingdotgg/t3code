import {
  type ChatAttachment,
  CommandId,
  isListedThreadLineage,
  MessageId,
  OrchestrationV2StopWorkflowError,
  type OrchestrationV2StopWorkflowInput,
  OrchestrationV2ForceStopThreadError,
  type OrchestrationV2ForceStopThreadInput,
  type OrchestrationV2ForceStopThreadResult,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadTranscript,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderInstanceId,
  type ProviderSessionId,
  resolveProjectProviderInstanceEnabled,
  RunId,
  type ScheduledTaskId,
  ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadManagementDurableRunProjectionError, ThreadManagementNoSteerableRunError, ThreadManagementProjectThreadsListError, ThreadManagementProjectionLoadError, ThreadManagementProviderInstanceDisabledError, ThreadManagementService, ThreadManagementThreadArchivedError, ThreadManagementThreadNotFoundError, ThreadTranscriptTooLargeError, existingThreadIdsForCommand, latestSteerableRun } from "./ThreadManagementService.ts";
import type { ThreadManagementSendResult, ThreadManagementServiceShape } from "./ThreadManagementService.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { projectedRowEncodedBytes } from "./threadHistoryPaging.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";

export const makeThreadManagementState = Effect.fn("makeThreadManagementState")(function* () {
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const layerScope = yield* Effect.scope;
  const agentScope = yield* AgentScope;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;

  const assertProviderInstanceEnabled: ThreadManagementServiceShape["assertProviderInstanceEnabled"] =
    (input) =>
      receipts.getByCommandId(input.commandId).pipe(
        Effect.orElseSucceed(() => Option.none()),
        Effect.flatMap((receipt) =>
          Option.isSome(receipt)
            ? Effect.void
            : serverSettings.getSettings.pipe(
                Effect.orDie,
                Effect.flatMap((current) =>
                  resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId)
                    ? Effect.void
                    : new ThreadManagementProviderInstanceDisabledError({
                        projectId: input.projectId,
                        instanceId: input.instanceId,
                      }),
                ),
              ),
        ),
      );

  const isProviderInstanceEnabledForProject: ThreadManagementServiceShape["isProviderInstanceEnabledForProject"] =
    (input) =>
      serverSettings.getSettings.pipe(
        Effect.orDie,
        Effect.map((current) =>
          resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId),
        ),
      );

  const hasReceipt: ThreadManagementServiceShape["hasReceipt"] = (commandId) =>
    receipts.getByCommandId(commandId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.map(Option.isSome),
    );

  const ensureLegacyTranscript = Effect.fn(
    "orchestrationV2.threadManagement.ensureLegacyTranscript",
  )(function* (threadId: ThreadId) {
    yield* legacyImporter.ensureTranscript(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Unable to hydrate migrated v1 thread transcript", {
          threadId,
          cause,
        }),
      ),
    );
  });

  const ensureProjectionTranscript = (threadId: ThreadId) =>
    ensureLegacyTranscript(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorProjectionError({
            threadId,
            cause,
          }),
      ),
    );

  const ensureCommandTranscripts = Effect.fn(
    "orchestrationV2.threadManagement.ensureCommandTranscripts",
  )(function* (command: OrchestrationV2ServerCommand) {
    yield* Effect.forEach(
      existingThreadIdsForCommand(command),
      (threadId) => ensureLegacyTranscript(threadId),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
  });

  const getThreadProjection: ThreadManagementServiceShape["getThreadProjection"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadProjection(threadId)),
    );

  const getCheckpointContext: ThreadManagementServiceShape["getCheckpointContext"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getCheckpointContext(threadId)),
    );

  const getThreadSnapshot: ThreadManagementServiceShape["getThreadSnapshot"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshot(threadId)),
    );
  const getThreadTranscript = Effect.fn("orchestrationV2.threadManagement.getThreadTranscript")(
    function* (threadId: ThreadId) {
      const { projection } = yield* getThreadSnapshot(threadId);
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const transcript = {
        threadId: projection.thread.id,
        title: projection.thread.title,
        updatedAt: projection.updatedAt,
        items: projection.visibleTurnItems,
      };
      let sizeBytes = Buffer.byteLength(
        threadTranscriptHeader(yield* environment.getEnvironmentId, transcript),
        "utf8",
      );
      if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        return yield* new ThreadTranscriptTooLargeError({ threadId });
      }
      for (const row of transcript.items) {
        sizeBytes += projectedRowEncodedBytes(row) + 1;
        if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          return yield* new ThreadTranscriptTooLargeError({ threadId });
        }
      }
      return transcript;
    },
  );
  const getThreadSnapshotWindow: ThreadManagementServiceShape["getThreadSnapshotWindow"] = (
    threadId,
    options,
  ) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshotWindow(threadId, options)),
    );

  const assertDispatchTargetEnabled = (command: OrchestrationV2ServerCommand) => {
    switch (command.type) {
      case "message.dispatch":
        return orchestrator.getThreadRecords(command.threadId, []).pipe(
          Effect.flatMap((projection) =>
            assertProviderInstanceEnabled({
              projectId: projection.thread.projectId,
              commandId: command.commandId,
              instanceId: (command.modelSelection ?? projection.thread.modelSelection).instanceId,
            }),
          ),
        );
      case "delegated_task.request":
        return orchestrator.getThreadRecords(command.parentThreadId, []).pipe(
          Effect.flatMap((parent) =>
            assertProviderInstanceEnabled({
              projectId: parent.thread.projectId,
              commandId: command.commandId,
              instanceId: command.modelSelection.instanceId,
            }),
          ),
        );
      case "prepared-run.release":
      case "prepared-run.retry":
        return orchestrator
          .getThreadRecords(command.threadId, ["runs"], { runIds: [command.runId] })
          .pipe(
            Effect.flatMap((projection) => {
              const run = projection.runs.find((candidate) => candidate.id === command.runId);
              return run === undefined
                ? Effect.void
                : assertProviderInstanceEnabled({
                    projectId: projection.thread.projectId,
                    commandId: command.commandId,
                    instanceId: run.providerInstanceId,
                  });
            }),
          );
      default:
        return Effect.void;
    }
  };

  const dispatch: ThreadManagementServiceShape["dispatch"] = (command) =>
    ensureCommandTranscripts(command).pipe(
      Effect.andThen(assertDispatchTargetEnabled(command)),
      Effect.andThen(orchestrator.dispatch(command)),
    );

  const getProjectThreadRecords: ThreadManagementServiceShape["getProjectThreadRecords"] = (
    input,
    fields,
    filter,
  ) =>
    ensureProjectionTranscript(input.threadId).pipe(
      Effect.andThen(orchestrator.getThreadRecords(input.threadId, fields, filter)),
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
      ),
      Effect.filterOrFail(
        (projection) =>
          projection.thread.projectId === input.projectId && projection.thread.deletedAt === null,
        (_projection) =>
          new ThreadManagementThreadNotFoundError({
            projectId: input.projectId,
            threadId: input.threadId,
          }),
      ),
    );

  const listProjectThreads: ThreadManagementServiceShape["listProjectThreads"] = (input) =>
    orchestrator
      .getShellSnapshot({
        location: "active",
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadManagementProjectThreadsListError({
              projectId: input.projectId,
              cause,
            }),
        ),
        Effect.map((snapshot) =>
          snapshot.threads
            .filter((thread) =>
              input.includeSubagents
                ? thread.lineage.sideChat !== true
                : isListedThreadLineage(thread.lineage),
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
                right.id.localeCompare(left.id),
            ),
        ),
      );

  const sendToThread: ThreadManagementServiceShape["sendToThread"] = Effect.fn(
    "ThreadManagementService.sendToThread",
  )(function* (input) {
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
    if (target.thread.archivedAt !== null) {
      return yield* new ThreadManagementThreadArchivedError({
        threadId: input.threadId,
      });
    }
    const steerableRun = latestSteerableRun(target);
    let dispatchMode: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" }
    >["dispatchMode"];
    if (input.mode === "steer" || input.mode === "restart") {
      if (steerableRun === undefined) {
        return yield* new ThreadManagementNoSteerableRunError({
          threadId: input.threadId,
          mode: input.mode,
        });
      }
      dispatchMode = {
        type: input.mode === "steer" ? "steer_active" : "restart_active",
        targetRunId: steerableRun.id,
      };
    } else if (input.mode === "auto" && steerableRun !== undefined) {
      dispatchMode = { type: "steer_active", targetRunId: steerableRun.id };
    } else {
      dispatchMode = {
        type: input.mode === "queue" ? "queue_after_active" : "start_immediately",
      };
    }

    const dispatched = yield* dispatch({
      type: "message.dispatch",
      commandId: input.commandId,
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
      ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
      text: input.text,
      attachments: input.attachments,
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      dispatchMode,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });
    const projection = yield* getProjectThreadRecords(input, ["runs", "messages", "turnItems"], {
      messageIds: [input.messageId],
      turnItemTypes: ["user_message"],
    });
    const message = projection.messages.find((candidate) => candidate.id === input.messageId);
    const run =
      message?.runId === null || message?.runId === undefined
        ? undefined
        : projection.runs.find((candidate) => candidate.id === message.runId);
    const turnItem =
      projection.turnItems.find(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
          candidate.type === "user_message" && candidate.messageId === input.messageId,
      ) ?? null;
    if (
      message === undefined ||
      run === undefined ||
      (turnItem === null && run.status !== "queued")
    ) {
      return yield* new ThreadManagementDurableRunProjectionError({
        threadId: input.threadId,
        messageId: input.messageId,
      });
    }
    const delivery: ThreadManagementSendResult["delivery"] =
      turnItem === null || turnItem.inputIntent === "queued_turn"
        ? "queued"
        : turnItem.inputIntent === "turn_start"
          ? "started"
          : input.mode === "restart"
            ? "restarted"
            : "steered";
    return { dispatch: dispatched, projection, message, run, turnItem, delivery };
  });

  return {
    threadDispatch,
    orchestrator,
    sessions,
    layerScope,
    agentScope,
    legacyImporter,
    serverSettings,
    receipts,
    assertProviderInstanceEnabled,
    isProviderInstanceEnabledForProject,
    hasReceipt,
    ensureLegacyTranscript,
    ensureProjectionTranscript,
    ensureCommandTranscripts,
    getThreadProjection,
    getCheckpointContext,
    getThreadSnapshot,
    getThreadTranscript,
    getThreadSnapshotWindow,
    assertDispatchTargetEnabled,
    dispatch,
    getProjectThreadRecords,
    listProjectThreads,
    sendToThread,
  };
});
