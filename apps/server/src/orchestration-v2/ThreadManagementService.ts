import {
  type ChatAttachment,
  type CommandId,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  OrchestratorV2,
  type OrchestratorV2DispatchResult,
  type OrchestratorV2Error,
} from "./Orchestrator.ts";

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

export class ThreadManagementError extends Schema.TaggedErrorClass<ThreadManagementError>()(
  "ThreadManagementError",
  {
    code: Schema.Literals([
      "thread_not_found",
      "run_not_found",
      "thread_not_sendable",
      "thread_not_interruptible",
      "orchestration_error",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

type ThreadManagementFailure = ThreadManagementError | OrchestratorV2Error;

export interface ThreadManagementServiceShape {
  readonly dispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly getProjectThread: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadManagementError>;
  readonly getShellSnapshot: () => Effect.Effect<OrchestrationV2ShellSnapshot, OrchestratorV2Error>;
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
  readonly streamDomainEvents: OrchestratorV2["Service"]["streamDomainEvents"];
}

export class ThreadManagementService extends Context.Service<
  ThreadManagementService,
  ThreadManagementServiceShape
>()("t3/orchestration-v2/ThreadManagementService") {}

export function isActiveRun(run: OrchestrationV2Run): boolean {
  return run.status === "starting" || run.status === "running" || run.status === "waiting";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function managementError(
  code: ThreadManagementError["code"],
  message: string,
  cause?: unknown,
): ThreadManagementError {
  return new ThreadManagementError({ code, message, ...(cause === undefined ? {} : { cause }) });
}

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;

  const getProjectThread: ThreadManagementServiceShape["getProjectThread"] = (input) =>
    orchestrator.getThreadProjection(input.threadId).pipe(
      Effect.mapError((cause) =>
        managementError(
          "thread_not_found",
          `Thread ${input.threadId} was not found in project ${input.projectId}.`,
          cause,
        ),
      ),
      Effect.flatMap((projection) =>
        projection.thread.projectId === input.projectId && projection.thread.deletedAt === null
          ? Effect.succeed(projection)
          : Effect.fail(
              managementError(
                "thread_not_found",
                `Thread ${input.threadId} was not found in project ${input.projectId}.`,
              ),
            ),
      ),
    );

  const listProjectThreads: ThreadManagementServiceShape["listProjectThreads"] = (input) =>
    orchestrator.getShellSnapshot().pipe(
      Effect.mapError((cause) =>
        managementError(
          "orchestration_error",
          `Unable to list threads in project ${input.projectId}: ${errorMessage(cause)}`,
          cause,
        ),
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
        return yield* managementError(
          "thread_not_sendable",
          `Thread ${input.threadId} is archived and cannot receive messages.`,
        );
      }

      const steerableRun = latestSteerableRun(target);
      let dispatchMode: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" }
      >["dispatchMode"];
      if (input.mode === "steer" || input.mode === "restart") {
        if (steerableRun === undefined) {
          return yield* managementError(
            "thread_not_sendable",
            `Thread ${input.threadId} has no running turn that can be ${input.mode === "steer" ? "steered" : "restarted"}.`,
          );
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
        return yield* managementError(
          "orchestration_error",
          `Message ${input.messageId} was accepted without a durable run projection.`,
        );
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
        return yield* managementError(
          "run_not_found",
          `Run ${input.runId} does not belong to thread ${input.threadId}.`,
        );
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
            return yield* managementError(
              "run_not_found",
              `Run ${selectedRun.id} no longer belongs to thread ${input.threadId}.`,
            );
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
        return yield* managementError(
          "run_not_found",
          `Run ${selectedRun.id} no longer belongs to thread ${input.threadId}.`,
        );
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
        return yield* managementError(
          "run_not_found",
          `Run ${input.runId} does not belong to thread ${input.threadId}.`,
        );
      }
      if (explicitRun !== undefined && isTerminalRunStatus(explicitRun.status)) {
        return {
          type: "already_terminal",
          run: explicitRun as OrchestrationV2Run & {
            readonly status: ThreadManagementTerminalRunStatus;
          },
        } as const;
      }
      const interruptibleRun = latestSteerableRun(target);
      if (input.runId === undefined && interruptibleRun === undefined) {
        return { type: "no_active_run" } as const;
      }
      if (
        interruptibleRun === undefined ||
        (explicitRun !== undefined && interruptibleRun.id !== explicitRun.id)
      ) {
        return yield* managementError(
          "thread_not_interruptible",
          `Run ${explicitRun?.id ?? input.runId} is not currently interruptible.`,
        );
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
    dispatch: orchestrator.dispatch,
    getThreadProjection: orchestrator.getThreadProjection,
    getProjectThread,
    getShellSnapshot: orchestrator.getShellSnapshot,
    listProjectThreads,
    sendToThread,
    waitForThread,
    interruptThread,
    getThreadEventSequence: orchestrator.getThreadEventSequence,
    streamStoredEvents: orchestrator.streamStoredEvents,
    streamDomainEvents: orchestrator.streamDomainEvents,
  });
});

export const layer: Layer.Layer<ThreadManagementService, never, OrchestratorV2> = Layer.effect(
  ThreadManagementService,
  make,
);
