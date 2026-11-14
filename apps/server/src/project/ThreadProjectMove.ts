import {
  CommandId,
  EventId,
  isRuntimeModeAbove,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ProjectExportThreadResult,
  type ProjectFinishThreadMoveInput,
  type ProjectId,
  type ProjectImportThreadInput,
  type ProjectImportThreadResult,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { threadMoveNotice } from "@t3tools/shared/threadMove";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { messageEvents } from "./AgentSessionImporter.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

const MOVE_EVENT_PREFIX = "thread-machine-move";

export class ThreadProjectMoveError extends Schema.TaggedError<ThreadProjectMoveError>()(
  "ThreadProjectMoveError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ThreadProjectMove extends Context.Service<
  ThreadProjectMove,
  {
    /**
     * Moves an idle thread, with its scheduled tasks, into another project's root folder.
     * Running it again finishes a partial move.
     */
    readonly move: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<{ readonly notice: string }, ThreadProjectMoveError>;
    /** An idle thread's conversation, for moving it to another environment. Changes nothing. */
    readonly exportThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ProjectExportThreadResult, ThreadProjectMoveError>;
    /** A new thread in `projectId` holding the bundle's history; its first message starts a fresh session. */
    readonly importThread: (
      input: ProjectImportThreadInput,
    ) => Effect.Effect<ProjectImportThreadResult, ThreadProjectMoveError>;
    /** Notes where the conversation went and archives the thread, once the import succeeded. */
    readonly finishMove: (
      input: ProjectFinishThreadMoveInput,
    ) => Effect.Effect<void, ThreadProjectMoveError>;
  }
>()("t3/project/ThreadProjectMove") {}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const randomId = (yield* SecureRandom.SecureRandom).uuidV4();

  const fail = (reason: string) => (cause: unknown) =>
    new ThreadProjectMoveError({ reason, cause });

  const readTarget = Effect.fn("ThreadProjectMove.readTarget")(function* (projectId: ProjectId) {
    const target = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(fail("Could not read the project.")));
    if (Option.isNone(target) || target.value.deletedAt !== null) {
      return yield* new ThreadProjectMoveError({ reason: "Project not found." });
    }
    // No project holds one folder per thread, so its root is no place to work.
    if (yield* managedFolders.isScratchProject(projectId)) {
      return yield* new ThreadProjectMoveError({
        reason: "A thread cannot move into No project.",
      });
    }
    return target.value;
  });

  const move: ThreadProjectMove["Service"]["move"] = Effect.fn("ThreadProjectMove.move")(
    function* (input) {
      const target = yield* readTarget(input.projectId);
      const thread = yield* threads.getThreadShell(input.threadId).pipe(
        Effect.mapError(fail("Could not read the thread.")),
        Effect.filterOrFail(
          (shell) => shell !== null,
          () => new ThreadProjectMoveError({ reason: "Thread not found." }),
        ),
      );
      if (thread.projectId !== input.projectId) {
        const branch = yield* git
          .currentBranch(target.workspaceRoot)
          .pipe(Effect.orElseSucceed(() => null));
        yield* threads
          .dispatch({
            type: "thread.project.move",
            commandId: CommandId.make(`thread-project-move:${yield* randomId}`),
            threadId: input.threadId,
            projectId: input.projectId,
            branch,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ThreadProjectMoveError({
                  reason: userFacingDispatchErrorMessage(cause) ?? "Could not move the thread.",
                  cause,
                }),
            ),
          );
      }
      // Another move can commit before these writes, so follow the thread until a read matches.
      const currentProject = threads.getThreadShell(input.threadId).pipe(
        Effect.map((shell) => shell?.projectId ?? input.projectId),
        Effect.mapError(fail("Could not read the thread.")),
      );
      let projectId = yield* currentProject;
      while (true) {
        yield* scheduledTasks
          .moveThreadTasks({ threadIds: [input.threadId], projectId })
          .pipe(Effect.mapError(fail("Moved the thread, but not its scheduled tasks. Try again.")));
        const now = yield* currentProject;
        if (now === projectId) break;
        projectId = now;
      }
      return {
        notice: threadMoveNotice({
          projectTitle: target.title,
          fromWorktree: thread.worktreePath !== null,
        }),
      };
    },
  );

  const exportThread: ThreadProjectMove["Service"]["exportThread"] = Effect.fn(
    "ThreadProjectMove.exportThread",
  )(function* (threadId) {
    const records = yield* threads
      .getThreadRecords(threadId, ["runs", "runtimeRequests"])
      .pipe(Effect.mapError(fail("Could not read the thread.")));
    if (threadHasUnfinishedWork(records)) {
      return yield* new ThreadProjectMoveError({
        reason: "The thread still has work in progress. Finish or stop it first.",
      });
    }
    const { projection } = yield* threads
      .getThreadSnapshot(threadId)
      .pipe(Effect.mapError(fail("Could not read the thread.")));
    const thread = projection.thread;
    let attachments = 0;
    const messages = projection.visibleTurnItems.flatMap(({ item }) => {
      if (item.type === "user_message") attachments += item.attachments.length;
      if (item.type !== "user_message" && item.type !== "assistant_message") return [];
      if (item.text.trim() === "") return [];
      const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
      return [
        { role: item.type === "user_message" ? "user" : "assistant", text: item.text, createdAt },
      ] as const;
    });
    if (messages.length === 0) {
      return yield* new ThreadProjectMoveError({
        reason: "The thread has no conversation to move.",
      });
    }
    const tasks = yield* scheduledTasks
      .list()
      .pipe(Effect.mapError(fail("Could not read the thread's scheduled tasks.")));
    return {
      bundle: {
        title: thread.title.trim() === "" ? "Untitled thread" : thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: DateTime.formatIso(thread.createdAt),
        messages,
      },
      leftBehind: {
        diffs: projection.runs.length > 0,
        worktree: thread.worktreePath !== null,
        attachments,
        scheduledTasks: tasks.tasks.filter((task) => task.threadId === threadId).length,
      },
    };
  });

  const importThread: ThreadProjectMove["Service"]["importThread"] = Effect.fn(
    "ThreadProjectMove.importThread",
  )(function* (input) {
    const project = yield* readTarget(input.projectId);
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(fail("Could not read this machine's settings.")),
    );
    const projectSettings = resolveProjectSettings(settings, project.id, project).settings;
    // Provider instances are per machine; one this machine lacks falls back to the project default.
    const instanceId = input.bundle.modelSelection.instanceId;
    const usable =
      (yield* registry.list()).includes(instanceId) &&
      (yield* threads.isProviderInstanceEnabledForProject({ projectId: project.id, instanceId }));
    const modelSelection = usable
      ? input.bundle.modelSelection
      : (projectSettings.defaultModelSelection ?? input.bundle.modelSelection);
    const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
    const runtimeMode =
      ceiling !== undefined && isRuntimeModeAbove(input.bundle.runtimeMode, ceiling)
        ? ceiling
        : input.bundle.runtimeMode;
    const branch = yield* git
      .currentBranch(project.workspaceRoot)
      .pipe(Effect.orElseSucceed(() => null));
    const threadId = yield* ids.allocate
      .thread({ projectId: project.id })
      .pipe(Effect.mapError(fail("Could not create the thread.")));
    const now = yield* DateTime.now;
    const createdAt = Option.getOrElse(DateTime.make(input.bundle.createdAt), () => now);
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "server",
      id: threadId,
      projectId: project.id,
      title: input.bundle.title,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode,
      interactionMode: input.bundle.interactionMode,
      branch,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: null,
      // Run-less history, which the first turn hands to a fresh provider session.
      historyOrigin: "v1_import",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const noticeId = TurnItemId.make(`${MOVE_EVENT_PREFIX}:moved-from:${threadId}`);
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make(`${MOVE_EVENT_PREFIX}:thread:${threadId}:created`),
        type: "thread.created",
        threadId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: thread,
      },
      ...input.bundle.messages.flatMap((message, index) =>
        messageEvents({ prefix: MOVE_EVENT_PREFIX, threadId, index, message }),
      ),
      {
        id: EventId.make(noticeId),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...movedNoticeFields(noticeId, threadId, now),
          runId: null,
          nodeId: null,
          providerThreadId: null,
          ordinal: input.bundle.messages.length + 1,
          message: `Moved from ${input.movedFrom}. Its files and diffs stayed there.`,
        },
      },
    ];
    yield* eventSink.write({ events }).pipe(Effect.mapError(fail("Could not create the thread.")));
    return { threadId };
  });

  const finishMove: ThreadProjectMove["Service"]["finishMove"] = Effect.fn(
    "ThreadProjectMove.finishMove",
  )(function* (input) {
    const { thread, runs } = yield* threads
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(Effect.mapError(fail("Could not read the thread.")));
    const lastRun = runs.reduce<(typeof runs)[number] | undefined>(
      (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
      undefined,
    );
    const now = yield* DateTime.now;
    const noticeId =
      lastRun === undefined
        ? TurnItemId.make(`${MOVE_EVENT_PREFIX}:moved-to:${input.threadId}`)
        : ids.derive.runSignalTurnItem({ runId: lastRun.id, signal: "moved-to-machine" });
    yield* eventSink
      .write({
        events: [
          {
            id: yield* ids.allocate
              .event({ threadId: input.threadId })
              .pipe(Effect.mapError(fail("Could not note the move."))),
            type: "turn-item.updated",
            threadId: input.threadId,
            ...(lastRun === undefined ? {} : { runId: lastRun.id }),
            occurredAt: now,
            payload: {
              ...movedNoticeFields(noticeId, input.threadId, now),
              runId: lastRun?.id ?? null,
              nodeId: lastRun?.rootNodeId ?? null,
              providerThreadId: lastRun?.providerThreadId ?? null,
              // EventSink allocates the real position, after the run's existing items.
              ordinal: 0,
              message: `Moved to ${input.movedTo}. Messages sent here stay separate from that thread.`,
            },
          },
        ],
      })
      .pipe(Effect.mapError(fail("Could not note the move.")));
    if (thread.archivedAt !== null) return;
    yield* threads
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`thread-machine-move:${yield* randomId}`),
        threadId: input.threadId,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadProjectMoveError({
              reason: userFacingDispatchErrorMessage(cause) ?? "Could not archive the thread.",
              cause,
            }),
        ),
      );
  });

  return ThreadProjectMove.of({ move, exportThread, importThread, finishMove });
});

function movedNoticeFields(id: TurnItemId, threadId: ThreadId, now: DateTime.Utc) {
  return {
    id,
    threadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "system_notice",
    level: "info",
  } as const;
}

export const layer = Layer.effect(ThreadProjectMove, make);
