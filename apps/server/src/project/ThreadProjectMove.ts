import {
  CommandId,
  EventId,
  isRuntimeModeAbove,
  type ModelSelection,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ProviderInstanceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ProjectExportThreadResult,
  type ProjectFinishThreadMoveInput,
  type ProjectId,
  type ProjectImportThreadInput,
  type ProjectImportThreadResult,
  type ThreadId,
  type ThreadMoveBundle,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { threadMoveLeftBehindList, threadMoveNotice } from "@t3tools/shared/threadMove";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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
const TOO_LARGE = "This conversation is too large to move.";
const CHANGED =
  "It changed after the move started, so it was left active here. Its newest messages aren't in the moved copy.";

/** The source's own provider when this machine runs it, else the project default when usable. */
export function movedModelSelection(input: {
  readonly source: ModelSelection;
  readonly projectDefault: ModelSelection | null;
  readonly usable: (instanceId: ProviderInstanceId) => boolean;
}): ModelSelection | null {
  if (input.usable(input.source.instanceId)) return input.source;
  return input.projectDefault !== null && input.usable(input.projectDefault.instanceId)
    ? input.projectDefault
    : null;
}

/** Imports hold bundles to the transcript export's budget, which exports already pass. */
export function threadMoveBundleFits(bundle: ThreadMoveBundle, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(bundle), "utf8") <= maxBytes;
}

/** Changes when a run starts or any run, retries included, completes, so finish never archives work export missed. */
export function threadRevision(
  runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly completedAt: DateTime.Utc | null;
  }>,
) {
  let newest: (typeof runs)[number] | undefined;
  let lastCompletedAt = 0;
  for (const run of runs) {
    if (newest === undefined || run.ordinal > newest.ordinal) newest = run;
    if (run.completedAt !== null)
      lastCompletedAt = Math.max(lastCompletedAt, DateTime.toEpochMillis(run.completedAt));
  }
  return `${runs.length}:${newest?.id ?? ""}:${lastCompletedAt}`;
}

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
  const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;
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
    // The transcript export's size preflight, budget and concurrency limit bound the bundle.
    const transcript = yield* threads.getThreadTranscript(threadId).pipe(
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environmentIdentity),
      Effect.mapError((cause) =>
        cause._tag === "ThreadTranscriptTooLargeError"
          ? new ThreadProjectMoveError({ reason: TOO_LARGE, cause })
          : new ThreadProjectMoveError({ reason: "Could not read the thread.", cause }),
      ),
    );
    const thread = records.thread;
    let attachments = 0;
    const messages = transcript.items.flatMap(({ item }) => {
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
        diffs: records.runs.length > 0,
        worktree: thread.worktreePath !== null,
        attachments,
        scheduledTasks: tasks.tasks.filter((task) => task.threadId === threadId).length,
      },
      revision: threadRevision(records.runs),
    };
  });

  const importThread: ThreadProjectMove["Service"]["importThread"] = Effect.fn(
    "ThreadProjectMove.importThread",
  )(function* (input) {
    if (!threadMoveBundleFits(input.bundle, PROVIDER_SEND_TURN_MAX_FILE_BYTES)) {
      return yield* new ThreadProjectMoveError({ reason: TOO_LARGE });
    }
    const project = yield* readTarget(input.projectId);
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(fail("Could not read this machine's settings.")),
    );
    const projectSettings = resolveProjectSettings(settings, project.id, project).settings;
    // Provider instances are per machine, so the thread may need this project's default.
    const usableIds = yield* Effect.filter(yield* registry.list(), (instanceId) =>
      threads.isProviderInstanceEnabledForProject({ projectId: project.id, instanceId }),
    );
    const modelSelection = movedModelSelection({
      source: input.bundle.modelSelection,
      projectDefault: projectSettings.defaultModelSelection,
      usable: (instanceId) => usableIds.includes(instanceId),
    });
    if (modelSelection === null) {
      return yield* new ThreadProjectMoveError({
        reason: `This machine can't run the thread's provider (${input.bundle.modelSelection.instanceId}), and ${project.title} has no usable default model. Set up that provider here, or choose a default model for ${project.title}.`,
      });
    }
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
          message: `Moved from ${input.movedFrom}. ${threadMoveLeftBehindList(input.leftBehind)} stayed there.`,
        },
      },
    ];
    yield* eventSink.write({ events }).pipe(Effect.mapError(fail("Could not create the thread.")));
    return { threadId };
  });

  const finishMove: ThreadProjectMove["Service"]["finishMove"] = Effect.fn(
    "ThreadProjectMove.finishMove",
  )(function* (input) {
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs", "runtimeRequests"])
      .pipe(Effect.mapError(fail("Could not read the thread.")));
    const { thread, runs } = records;
    // A run can start between this check and the archive below; that window is a few
    // milliseconds, while the one this closes spans the whole confirmation and import.
    if (threadRevision(runs) !== input.revision || threadHasUnfinishedWork(records)) {
      return yield* new ThreadProjectMoveError({ reason: CHANGED });
    }
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
