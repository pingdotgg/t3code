import {
  type ChatAttachment,
  type CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2,
  type OrchestratorV2DispatchResult,
  type OrchestratorV2Error,
} from "./Orchestrator.ts";
import {
  LegacyV1ThreadImporter,
  type LegacyV1ThreadImportError,
} from "./LegacyV1ThreadImporter.ts";

export type ThreadManagementSendMode = "auto" | "queue" | "steer" | "restart";

export interface ThreadManagementProvenance {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export function withCreationProvenance(
  command: OrchestrationV2Command,
  provenance: ThreadManagementProvenance,
): OrchestrationV2Command {
  switch (command.type) {
    case "thread.create":
    case "message.dispatch":
    case "thread.fork":
    case "thread.merge_back":
    case "delegated_task.request":
      return { ...command, ...provenance };
    default:
      return command;
  }
}

export function existingThreadIdsForCommand(
  command: OrchestrationV2Command,
): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
      return [];
    case "thread.fork":
      return [command.sourceThreadId];
    case "thread.merge_back":
      return command.sourceThreadId === command.targetThreadId
        ? [command.sourceThreadId]
        : [command.sourceThreadId, command.targetThreadId];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
      return [command.parentThreadId];
    case "thread.created.record":
      return command.parentThreadId === command.targetThreadId
        ? [command.parentThreadId]
        : [command.parentThreadId, command.targetThreadId];
    default:
      return [command.threadId];
  }
}

export type ThreadManagementTerminalRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back"
>;

export interface ThreadManagementSendInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly mode: ThreadManagementSendMode;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadManagementSendResult {
  readonly dispatch: OrchestratorV2DispatchResult;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly message: OrchestrationV2ConversationMessage;
  readonly run: OrchestrationV2Run;
  readonly turnItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>;
  readonly delivery: "started" | "queued" | "steered" | "restarted";
}

export interface ThreadManagementWaitInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
}

export interface ThreadManagementWaitResult {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run | null;
  readonly timedOut: boolean;
}

export interface ThreadManagementInterruptInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly reason?: string;
}

export type ThreadManagementInterruptResult =
  | {
      readonly type: "interrupt_requested";
      readonly run: OrchestrationV2Run;
      readonly dispatch: OrchestratorV2DispatchResult;
    }
  | { readonly type: "no_active_run" }
  | {
      readonly type: "already_terminal";
      readonly run: OrchestrationV2Run & { readonly status: ThreadManagementTerminalRunStatus };
    };

export class ThreadManagementThreadNotFoundError extends Schema.TaggedErrorClass<ThreadManagementThreadNotFoundError>()(
  "ThreadManagementThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found in project ${this.projectId}.`;
  }
}

export class ThreadManagementRunNotFoundError extends Schema.TaggedErrorClass<ThreadManagementRunNotFoundError>()(
  "ThreadManagementRunNotFoundError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} does not belong to thread ${this.threadId}.`;
  }
}

const ThreadManagementThreadNotSendableReason = Schema.Union([
  Schema.TaggedStruct("Archived", {}),
  Schema.TaggedStruct("NoSteerableRun", {
    mode: Schema.Literals(["steer", "restart"]),
  }),
]);

export class ThreadManagementThreadNotSendableError extends Schema.TaggedErrorClass<ThreadManagementThreadNotSendableError>()(
  "ThreadManagementThreadNotSendableError",
  {
    threadId: ThreadId,
    reason: ThreadManagementThreadNotSendableReason,
  },
) {
  override get message(): string {
    switch (this.reason._tag) {
      case "Archived":
        return `Thread ${this.threadId} is archived and cannot receive messages.`;
      case "NoSteerableRun":
        return `Thread ${this.threadId} has no running turn that can be ${this.reason.mode === "steer" ? "steered" : "restarted"}.`;
    }
  }
}

export class ThreadManagementThreadNotInterruptibleError extends Schema.TaggedErrorClass<ThreadManagementThreadNotInterruptibleError>()(
  "ThreadManagementThreadNotInterruptibleError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} is not currently interruptible.`;
  }
}

export class ThreadManagementProjectionLoadError extends Schema.TaggedErrorClass<ThreadManagementProjectionLoadError>()(
  "ThreadManagementProjectionLoadError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to load thread ${this.threadId} in project ${this.projectId}.`;
  }
}

export class ThreadManagementProjectThreadsListError extends Schema.TaggedErrorClass<ThreadManagementProjectThreadsListError>()(
  "ThreadManagementProjectThreadsListError",
  {
    projectId: ProjectId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to list threads in project ${this.projectId}.`;
  }
}

export class ThreadManagementDurableRunProjectionError extends Schema.TaggedErrorClass<ThreadManagementDurableRunProjectionError>()(
  "ThreadManagementDurableRunProjectionError",
  {
    threadId: ThreadId,
    messageId: MessageId,
  },
) {
  override get message(): string {
    return `Message ${this.messageId} was accepted on thread ${this.threadId} without a durable run projection.`;
  }
}

export const ThreadManagementError = Schema.Union([
  ThreadManagementThreadNotFoundError,
  ThreadManagementRunNotFoundError,
  ThreadManagementThreadNotSendableError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementProjectionLoadError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementDurableRunProjectionError,
]);
export type ThreadManagementError = typeof ThreadManagementError.Type;

type ThreadManagementFailure = ThreadManagementError | OrchestratorV2Error;

export interface ThreadManagementServiceShape {
  readonly ensureLegacyTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<void, LegacyV1ThreadImportError>;
  readonly dispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly getThreadSnapshot: OrchestratorV2["Service"]["getThreadSnapshot"];
  readonly getProjectThread: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadManagementError>;
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationV2ThreadShellSnapshot,
    OrchestratorV2Error
  >;
  readonly listProjectThreads: (input: {
    readonly projectId: ProjectId;
    readonly includeSubagents: boolean;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, ThreadManagementError>;
  readonly sendToThread: (
    input: ThreadManagementSendInput,
  ) => Effect.Effect<ThreadManagementSendResult, ThreadManagementFailure>;
  readonly waitForThread: (
    input: ThreadManagementWaitInput,
  ) => Effect.Effect<ThreadManagementWaitResult, ThreadManagementError>;
  readonly interruptThread: (
    input: ThreadManagementInterruptInput,
  ) => Effect.Effect<ThreadManagementInterruptResult, ThreadManagementFailure>;
  readonly getThreadEventSequence: OrchestratorV2["Service"]["getThreadEventSequence"];
  readonly streamStoredEvents: OrchestratorV2["Service"]["streamStoredEvents"];
  readonly streamStoredEventsFrom: OrchestratorV2["Service"]["streamStoredEventsFrom"];
  readonly streamDomainEvents: OrchestratorV2["Service"]["streamDomainEvents"];
}

export class ThreadManagementService extends Context.Service<
  ThreadManagementService,
  ThreadManagementServiceShape
>()("t3/orchestration-v2/ThreadManagementService") {}

export function isActiveRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

export function isTerminalRunStatus(
  status: OrchestrationV2Run["status"],
): status is ThreadManagementTerminalRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "rolled_back"
  );
}

export function latestRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2Run | undefined {
  return projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

export function latestActiveRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

export function latestSteerableRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(
      (run) =>
        run.status === "running" &&
        run.activeAttemptId !== null &&
        projection.providerTurns.some(
          (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
        ),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const legacyImporter = yield* LegacyV1ThreadImporter;

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
          new OrchestratorProjectionError({
            threadId,
            cause,
          }),
      ),
    );

  const ensureCommandTranscripts = Effect.fn(
    "orchestrationV2.threadManagement.ensureCommandTranscripts",
  )(function* (command: OrchestrationV2Command) {
    yield* Effect.forEach(
      existingThreadIdsForCommand(command),
      (threadId) => ensureLegacyTranscript(threadId),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
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

  const getThreadSnapshot: ThreadManagementServiceShape["getThreadSnapshot"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshot(threadId)),
    );

  const dispatch: ThreadManagementServiceShape["dispatch"] = (command) =>
    ensureCommandTranscripts(command).pipe(Effect.andThen(orchestrator.dispatch(command)));

  const getProjectThread: ThreadManagementServiceShape["getProjectThread"] = (input) =>
    getThreadProjection(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
      ),
      Effect.flatMap((projection) =>
        projection.thread.projectId === input.projectId && projection.thread.deletedAt === null
          ? Effect.succeed(projection)
          : Effect.fail(
              new ThreadManagementThreadNotFoundError({
                projectId: input.projectId,
                threadId: input.threadId,
              }),
            ),
      ),
    );

  const listProjectThreads: ThreadManagementServiceShape["listProjectThreads"] = (input) =>
    orchestrator.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectThreadsListError({
            projectId: input.projectId,
            cause,
          }),
      ),
      Effect.map((snapshot) =>
        snapshot.threads
          .filter((thread) => thread.projectId === input.projectId)
          .filter(
            (thread) =>
              input.includeSubagents || thread.lineage.relationshipToParent !== "subagent",
          )
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
              right.id.localeCompare(left.id),
          ),
      ),
    );

  const sendToThread: ThreadManagementServiceShape["sendToThread"] = (input) =>
    Effect.gen(function* () {
      const target = yield* getProjectThread(input);
      if (target.thread.archivedAt !== null) {
        return yield* new ThreadManagementThreadNotSendableError({
          threadId: input.threadId,
          reason: { _tag: "Archived" },
        });
      }

      const steerableRun = latestSteerableRun(target);
      let dispatchMode: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" }
      >["dispatchMode"];
      if (input.mode === "steer" || input.mode === "restart") {
        if (steerableRun === undefined) {
          return yield* new ThreadManagementThreadNotSendableError({
            threadId: input.threadId,
            reason: { _tag: "NoSteerableRun", mode: input.mode },
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

      const dispatch = yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: input.commandId,
        threadId: input.threadId,
        messageId: input.messageId,
        text: input.text,
        attachments: input.attachments,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        dispatchMode,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      const projection = yield* getProjectThread(input);
      const message = projection.messages.find((candidate) => candidate.id === input.messageId);
      const run =
        message?.runId === null || message?.runId === undefined
          ? undefined
          : projection.runs.find((candidate) => candidate.id === message.runId);
      const turnItem = projection.turnItems.find(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
          candidate.type === "user_message" && candidate.messageId === input.messageId,
      );
      if (message === undefined || run === undefined || turnItem === undefined) {
        return yield* new ThreadManagementDurableRunProjectionError({
          threadId: input.threadId,
          messageId: input.messageId,
        });
      }
      const delivery: ThreadManagementSendResult["delivery"] =
        turnItem.inputIntent === "turn_start"
          ? "started"
          : turnItem.inputIntent === "queued_turn"
            ? "queued"
            : input.mode === "restart"
              ? "restarted"
              : "steered";
      return { dispatch, projection, message, run, turnItem, delivery };
    });

  const waitForThread: ThreadManagementServiceShape["waitForThread"] = (input) =>
    Effect.gen(function* () {
      const target = yield* getProjectThread(input);
      const selectedRun =
        input.runId === undefined
          ? latestRun(target)
          : target.runs.find((candidate) => candidate.id === input.runId);
      if (input.runId !== undefined && selectedRun === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      if (selectedRun === undefined) {
        return { threadId: input.threadId, run: null, timedOut: false };
      }
      if (isTerminalRunStatus(selectedRun.status)) {
        return { threadId: input.threadId, run: selectedRun, timedOut: false };
      }

      const wait = Effect.gen(function* () {
        while (true) {
          const current = yield* getProjectThread(input);
          const run = current.runs.find((candidate) => candidate.id === selectedRun.id);
          if (run === undefined) {
            return yield* new ThreadManagementRunNotFoundError({
              threadId: input.threadId,
              runId: selectedRun.id,
            });
          }
          if (isTerminalRunStatus(run.status)) return run;
          yield* Effect.sleep(Duration.millis(Math.max(1, input.pollIntervalMs ?? 250)));
        }
      }).pipe(Effect.timeoutOption(Duration.millis(Math.max(1, input.timeoutMs))));
      const waited = yield* wait;
      if (Option.isSome(waited)) {
        return { threadId: input.threadId, run: waited.value, timedOut: false };
      }
      const current = yield* getProjectThread(input);
      const run = current.runs.find((candidate) => candidate.id === selectedRun.id);
      if (run === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: selectedRun.id,
        });
      }
      return { threadId: input.threadId, run, timedOut: true };
    });

  const interruptThread: ThreadManagementServiceShape["interruptThread"] = (input) =>
    Effect.gen(function* () {
      const target = yield* getProjectThread(input);
      const explicitRun =
        input.runId === undefined
          ? undefined
          : target.runs.find((candidate) => candidate.id === input.runId);
      if (input.runId !== undefined && explicitRun === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      if (explicitRun !== undefined && isTerminalRunStatus(explicitRun.status)) {
        return {
          type: "already_terminal",
          run: explicitRun as OrchestrationV2Run & {
            readonly status: ThreadManagementTerminalRunStatus;
          },
        } as const;
      }
      const interruptibleRun = latestActiveRun(target);
      if (interruptibleRun === undefined) {
        if (input.runId === undefined) {
          return { type: "no_active_run" } as const;
        }
        return yield* new ThreadManagementThreadNotInterruptibleError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      if (input.runId !== undefined && interruptibleRun.id !== input.runId) {
        return yield* new ThreadManagementThreadNotInterruptibleError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      const dispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: input.commandId,
        threadId: input.threadId,
        runId: interruptibleRun.id,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      return { type: "interrupt_requested", run: interruptibleRun, dispatch } as const;
    });

  return ThreadManagementService.of({
    ensureLegacyTranscript,
    dispatch,
    getThreadProjection,
    getThreadSnapshot,
    getProjectThread,
    getShellSnapshot: orchestrator.getShellSnapshot,
    listProjectThreads,
    sendToThread,
    waitForThread,
    interruptThread,
    getThreadEventSequence: orchestrator.getThreadEventSequence,
    streamStoredEvents: orchestrator.streamStoredEvents,
    streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
    streamDomainEvents: orchestrator.streamDomainEvents,
  });
});

const legacyV1ThreadImporterNoopLayer = Layer.succeed(
  LegacyV1ThreadImporter,
  LegacyV1ThreadImporter.of({
    pendingThreadCount: Effect.succeed(0),
    reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    importPendingTranscripts: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
  }),
);

export const layer: Layer.Layer<ThreadManagementService, never, OrchestratorV2> = Layer.effect(
  ThreadManagementService,
  make,
).pipe(Layer.provide(legacyV1ThreadImporterNoopLayer));

export const layerWithLegacyImporter: Layer.Layer<
  ThreadManagementService,
  never,
  LegacyV1ThreadImporter | OrchestratorV2
> = Layer.effect(ThreadManagementService, make);
