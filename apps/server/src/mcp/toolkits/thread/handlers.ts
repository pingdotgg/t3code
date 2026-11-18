import {
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import { topOfPinnedRunOrderKey } from "@t3tools/shared/pinOrderKey";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { threadManagementFailure } from "../../OrchestratorMcpService.ts";
import { agentMessageSenderOf } from "../../../orchestration-v2/AgentMessagePolicy.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertTargetWithinLimits,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import type * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as CheckpointDiffQuery from "../../../checkpointing/CheckpointDiffQuery.ts";
import type { CheckpointServiceError } from "../../../checkpointing/Errors.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { hiddenModelMessage } from "../../ModelVisibility.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { ThreadToolkit } from "./tools.ts";

// Bounded read output: metadata only, never attachment bytes or URLs.
const QUEUE_ATTACHMENTS_LIMIT = 10;
const QUEUE_HOLD_REASON_CHARS = 500;

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
    queueHeld: run.queueHeld === true,
    attachmentCount: message.attachments.length,
    attachments: message.attachments
      .slice(0, QUEUE_ATTACHMENTS_LIMIT)
      .map(({ name, type, mimeType, sizeBytes }) => ({ name, type, mimeType, sizeBytes })),
  };
}

// The queue stays held while failed worktree setup has left no worktree; that
// preparation error is the reason the apps show for a held queue.
function queueHoldReason(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "turnItems">,
): string | null {
  const worktreeSetupUnresolved =
    projection.thread.worktreePath === null &&
    projection.runs.some(
      (run) =>
        (run.status === "failed" || run.status === "interrupted") &&
        run.workspacePreparation?.type === "worktree",
    );
  if (!worktreeSetupUnresolved) return null;
  const failure = projection.turnItems.findLast(
    (item) =>
      item.type === "error" &&
      item.status === "failed" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  );
  // An interrupted setup leaves no failure item but still holds the queue.
  if (failure?.type !== "error") return "Worktree setup did not finish.";
  return Array.from(failure.failure.message).slice(0, QUEUE_HOLD_REASON_CHARS).join("");
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

/**
 * Places an agent pin at the top of the Pinned section, as a client pin is placed.
 * Without a key the sidebar sorts the pin below every keyed pin. Ordering is
 * best effort: if the index cannot be read, the pin still lands, keyless.
 */
const topOfPinnedRunKey = Effect.fn("mcp.topOfPinnedRunKey")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "listActiveShellIndex">,
) {
  const index = yield* threads.listActiveShellIndex().pipe(Effect.orElseSucceed(() => null));
  if (index === null) return undefined;
  const pinnedKeys = index.flatMap((entry) => (entry.pinnedAt == null ? [] : [entry.pinOrderKey]));
  return topOfPinnedRunOrderKey(pinnedKeys) ?? undefined;
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId && request.kind === "user_input",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.status === "resolved"
          ? "The user-input request was already answered."
          : `The user-input request is no longer pending (${request.status}).`,
    });
  return { ...context, request, item };
});
const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const DEFAULT_DIFF_CHARS = 20_000;

const diffFailure = (error: CheckpointServiceError) =>
  error._tag === "CheckpointTurnRangeUnavailableError"
    ? refuse(
        `Turn ${error.requestedTurnCount} is not available: the thread has ${error.availableTurnCount} ready turns.`,
      )
    : error._tag === "CheckpointRefUnavailableError"
      ? refuse(`Turn ${error.turnCount} has no ready checkpoint; try another turn.`)
      : unavailable();

/** A field the chosen action needs. `null` counts as given, as in `beforeRunId: null`. */
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);
const readConfiguration = Effect.fn("mcp.readThreadConfiguration")(function* (
  threadId: ThreadId | undefined,
) {
  const {
    projection: { thread },
  } = yield* readThread(threadId);
  return {
    threadId: thread.id,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    autoSettle: thread.autoSettleDisabledAt == null,
    goal: thread.goal ?? null,
    goalLoop: thread.goalLoop ?? null,
  };
});
/** Applies the owner's block policy before an agent puts text into a thread it names. */
const refuseBlocked = Effect.fn("mcp.refuseBlockedThreadWrite")(function* (
  threadId: ThreadId | undefined,
  attempted: string,
  text: string,
) {
  // No thread named means the caller's own.
  if (threadId === undefined) return;
  const { scope, threads } = yield* readCaller();
  yield* threads
    .refuseBlockedSender(agentMessageSenderOf(scope), { threadId, attempted, text })
    .pipe(Effect.mapError(threadManagementFailure));
});
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return {
        taskId: task.id,
        threadId,
        ...(threadId === null
          ? {}
          : {
              link: McpInvocationContext.threadLinkFor(scope, threadId),
            }),
        lastRunStatus: task.lastRunStatus,
        lastRunError: task.lastRunError,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      if (input.threadId !== undefined) {
        // readThread is the t3_thread_read rule: existing and not deleted; archived stays readable.
        const { threads, projection } = yield* readThread(input.threadId);
        const result = yield* threads
          .searchThread({ threadId: projection.thread.id, query: input.query })
          .pipe(Effect.mapError(unavailable));
        return {
          threadId: projection.thread.id,
          totalMatches: result.totalMatches,
          matches: result.navigation ?? [],
        };
      }
      const { caller } = yield* readCaller();
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const { matches } = yield* threadSearch
        .searchThreads({
          query: input.query,
          projectId: input.projectId ?? caller?.projectId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        .pipe(Effect.mapError(unavailable));
      return {
        currentThreadId: scope.thread?.threadId ?? null,
        matches: matches.map((match) => ({
          ...match,
          link: McpInvocationContext.threadLinkFor(scope, match.threadId, match.title),
        })),
      };
    }),
  ),
  t3_thread_transfer: McpToolAccess.either(
    (input) => input.action === "status",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
        return {
          transfers: projection.contextTransfers.map(
            ({ id, sourceThreadId, targetThreadId, status }) => ({
              id,
              sourceThreadId,
              targetThreadId,
              status,
            }),
          ),
        };
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId, input.targetThreadId],
      (input) =>
        Effect.gen(function* () {
          const sourcePoint = input.sourcePoint ?? { type: "latest_stable" as const };
          const { threads, projection } = yield* readThread(input.threadId);
          const commandId = yield* newCommandId();
          if (input.action === "merge_back") {
            const targetThreadId = yield* required(input.targetThreadId, "targetThreadId");
            yield* readThread(targetThreadId);
            yield* refuseBlocked(
              targetThreadId,
              "a merge back",
              `From thread ${projection.thread.id}.`,
            );
            const result = yield* threads
              .dispatch({
                type: "thread.merge_back",
                commandId,
                sourceThreadId: projection.thread.id,
                targetThreadId,
                sourcePoint,
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.mapError(dispatchFailure));
            return { sequence: result.sequence, targetThreadId };
          }
          const targetThreadId = ThreadId.make(`${commandId}:fork`);
          const result = yield* threads
            .dispatch({
              type: "thread.fork",
              commandId,
              sourceThreadId: projection.thread.id,
              targetThreadId,
              sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence, targetThreadId };
        }),
    ),
  ),
  t3_pending_request: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        if (input.action === "list") {
          const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
          return {
            requestIds: projection.runtimeRequests
              .filter((request) => request.kind === "user_input" && request.status === "pending")
              .map((request) => request.id),
          };
        }
        const requestId = yield* required(input.requestId, "requestId");
        const { item } = yield* readQuestion({ threadId: input.threadId, requestId });
        return { requestId, questions: item.questions };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const requestId = yield* required(input.requestId, "requestId");
        // readQuestion refuses anything but a pending user-input question, so approvals and
        // already-resolved requests are turned away before any command dispatches.
        const { threads, projection } = yield* readQuestion({
          threadId: input.threadId,
          requestId,
        });
        if (input.action !== "dismiss") {
          yield* refuseBlocked(
            input.threadId,
            "an answer to a question",
            Object.entries(input.answers ?? {})
              .map(
                ([question, answer]) =>
                  `${question}: ${typeof answer === "string" ? answer : Array.isArray(answer) ? answer.join(", ") : "(structured answer)"}`,
              )
              .join("\n"),
          );
        }
        const result = yield* threads
          .dispatch(
            input.action === "dismiss"
              ? {
                  type: "thread.user-input.dismiss",
                  threadId: projection.thread.id,
                  commandId: yield* newCommandId(),
                  requestId,
                }
              : {
                  type: "runtime-request.respond",
                  threadId: projection.thread.id,
                  commandId: yield* newCommandId(),
                  requestId,
                  answers: yield* required(input.answers, "answers"),
                },
          )
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_thread_diff: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const queried = yield* checkpointDiffQuery
        .getThreadDiff({
          threadId: projection.thread.id,
          turn: input.turn,
          ignoreWhitespace: input.ignoreWhitespace,
        })
        .pipe(Effect.mapError(diffFailure));
      const maxChars = input.maxChars ?? DEFAULT_DIFF_CHARS;
      // Diffs reach 10 MB; slice UTF-16 units instead of materializing code points,
      // stepping back so a surrogate pair is never split.
      let end = Math.min(maxChars, queried.diff.length);
      const lastUnit = queried.diff.charCodeAt(end - 1);
      if (end < queried.diff.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
      return {
        threadId: projection.thread.id,
        fromTurnCount: queried.fromTurnCount,
        toTurnCount: queried.toTurnCount,
        latestTurnCount: queried.latestTurnCount,
        diff: queried.diff.slice(0, end),
        truncated: end < queried.diff.length,
        totalChars: queried.diff.length,
      };
    }),
  ),
  t3_thread_configuration: McpToolAccess.reads((input) => readConfiguration(input.threadId)),
  t3_thread_configure: McpToolAccess.either(
    (input) => input.modelSelection === undefined,
    McpToolAccess.reads((input) => readConfiguration(input.threadId)),
    writesThread((input) =>
      Effect.gen(function* () {
        const modelSelection = yield* required(input.modelSelection, "modelSelection");
        const {
          threads,
          projection: { thread },
        } = yield* readThread(input.threadId);
        // An agent may not switch a thread to a model the user hid.
        const hiddenReason = hiddenModelMessage({
          settings: yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
            Effect.mapError(unavailable),
          ),
          providers: yield* (yield* ProviderRegistry.ProviderRegistry).getProviders.pipe(
            Effect.mapError(unavailable),
          ),
          selection: modelSelection,
        });
        if (hiddenReason !== null) {
          return yield* new OrchestratorMcpFailure({
            code: "model_unavailable",
            message: hiddenReason,
          });
        }
        const type = modelSelectionCommandType(thread.providerInstanceId, modelSelection);
        const result = yield* threads
          .dispatch({ type, threadId: thread.id, commandId: yield* newCommandId(), modelSelection })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  // The orchestrator re-checks the direction under the thread lock; this
  // pre-check only gives the refusal its message.
  t3_thread_lower_modes: writesThread((input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      const runtimeMode = input.runtimeMode ?? thread.runtimeMode;
      const interactionMode = input.interactionMode ?? thread.interactionMode;
      yield* assertTargetWithinLimits(thread, { id: thread.id, runtimeMode, interactionMode }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: error.code,
              message: "Agents can only lower a thread's modes; raise them in the app.",
            }),
        ),
      );
      const commands: Array<OrchestrationV2Command> = [];
      if (runtimeMode !== thread.runtimeMode)
        commands.push({
          type: "thread.runtime-mode.set",
          commandId: yield* newCommandId(),
          threadId: thread.id,
          runtimeMode,
        });
      if (interactionMode !== thread.interactionMode)
        commands.push({
          type: "thread.interaction-mode.set",
          commandId: yield* newCommandId(),
          threadId: thread.id,
          interactionMode,
        });
      if (commands.length === 0)
        return yield* refuse(`The thread already runs in ${runtimeMode}/${interactionMode} mode.`);
      let sequence = 0;
      for (const command of commands) {
        sequence = (yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure)))
          .sequence;
      }
      return { sequence };
    }),
  ),
  // An idle loop is driven by GoalLoopService, so a goal set here seeds its loop paused.
  t3_thread_goal: writesThread((input) =>
    refuseBlocked(input.threadId, "a goal", input.goal ?? "").pipe(
      Effect.andThen(
        dispatch(input.threadId, (common) => ({
          ...common,
          type: "thread.metadata.update",
          goal: input.goal,
          ...(input.goal === null ? {} : { goalLoopState: "paused" as const }),
        })),
      ),
    ),
  ),
  // ponytail: expected state is checked before dispatch, not under the thread lock (dispatch
  // takes that lock and it is not reentrant). A guard field on the client loop command would
  // close the window.
  t3_thread_goal_loop: writesThread((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      if (thread.goal == null) return yield* refuse("The thread has no goal.");
      const state = thread.goalLoop?.state ?? "idle";
      if (state !== input.expectedState)
        return yield* refuse(`The goal loop is ${state}, not ${input.expectedState}.`);
      yield* refuseBlocked(
        input.threadId,
        `a goal loop change (${input.action})`,
        input.reason ?? "",
      );
      return yield* dispatch(thread.id, (common) => ({
        ...common,
        type: "thread.goal.loop",
        action: input.action,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }));
    }),
  ),
  t3_run_start: writesThread((input) =>
    Effect.gen(function* () {
      // The orchestrator only retries a run whose workspace preparation failed and only starts
      // a queued run while the thread is stopped, so runId is checked atomically there.
      if (input.action === "retry_preparation")
        return yield* dispatch(input.threadId, (common) => ({
          ...common,
          type: "prepared-run.retry",
          runId: input.runId,
        }));
      if (input.action === "start_queued")
        return yield* dispatch(input.threadId, (common) => ({
          ...common,
          type: "queued-run.start",
          runId: input.runId,
        }));
      // ponytail: queue.resume has no expected-run field, so the head is checked before
      // dispatch; a queue edit in that window can change what starts.
      const { threads, projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const next = queuedRunsInDeliveryOrder(projection)[0];
      if (next?.id !== input.runId || next.queueHeld !== true)
        return yield* refuse(
          next === undefined
            ? "The thread has no queued run."
            : next.queueHeld !== true
              ? "The queue is not held."
              : `The next queued run is ${next.id}.`,
        );
      const result = yield* threads
        .dispatch({
          type: "queue.resume",
          commandId: yield* newCommandId(),
          threadId: projection.thread.id,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_queue: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { threads, projection: queued } = yield* readThread(input.threadId, ["runs"], {
          runStatuses: ["queued"],
        });
        const messages = yield* threads
          .getMessagesById(
            queued.thread.id,
            queued.runs.map((run) => run.userMessageId),
          )
          .pipe(Effect.mapError(unavailable));
        const projection = { runs: queued.runs, messages: [...messages.values()] };
        // Only a held queue has a reason, and finding it needs every run and error item.
        const holdReason = readThread(queued.thread.id, ["runs", "turnItems"], {
          turnItemTypes: ["error"],
        }).pipe(Effect.map((held) => queueHoldReason(held.projection)));
        if (input.action === "list") {
          const runs = queuedRunsInDeliveryOrder(projection);
          const cursor = input.cursor ?? 0;
          const end = cursor + (input.limit ?? 20);
          const queueHeld = projection.runs.some(
            (run) => run.status === "queued" && run.queueHeld === true,
          );
          return {
            items: runs.slice(cursor, end).flatMap((run) => {
              const entry = queueEntry(projection, run.id, 1000);
              return entry === undefined ? [] : [entry];
            }),
            nextCursor: end < runs.length ? end : null,
            queueHeld,
            holdReason: queueHeld ? yield* holdReason : null,
          };
        }
        const queuedRunId = yield* required(input.queuedRunId, "queuedRunId");
        const entry = queueEntry(projection, queuedRunId, 16000);
        if (entry === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The queued message was not found.",
          });
        }
        return { ...entry, holdReason: entry.queueHeld ? yield* holdReason : null };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const runId = yield* required(input.queuedRunId, "queuedRunId");
        switch (input.action) {
          case "edit": {
            const text = yield* required(input.text, "text");
            yield* refuseBlocked(input.threadId, "an edit to a queued message", text);
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.edit",
              runId,
              text,
            }));
          }
          case "reorder": {
            const beforeRunId = yield* required(input.beforeRunId, "beforeRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.reorder",
              runId,
              beforeRunId,
            }));
          }
          case "promote_to_steer": {
            const targetRunId = yield* required(input.targetRunId, "targetRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-message.promote-to-steer",
              queuedRunId: runId,
              targetRunId,
            }));
          }
          default:
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.cancel",
              runId,
            }));
        }
      }),
    ),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_read": {
          // A read receipt at the version observed above, never the handler's
          // own clock and never an open or search event. A passed snooze wake
          // is stamped (mirroring the clients) only when it is newer, so the
          // clock serves that one comparison and never becomes the stamp.
          const observedAt = projection.thread.updatedAt;
          const snoozedUntil = projection.thread.snoozedUntil;
          const wokeAt =
            snoozedUntil != null &&
            DateTime.toEpochMillis(snoozedUntil) <= DateTime.toEpochMillis(yield* DateTime.now)
              ? snoozedUntil
              : null;
          const visitedAt =
            wokeAt != null && DateTime.toEpochMillis(wokeAt) > DateTime.toEpochMillis(observedAt)
              ? wokeAt
              : observedAt;
          command = { ...common, type: "thread.visit", visitedAt: DateTime.formatIso(visitedAt) };
          break;
        }
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        case "enable_auto_settle":
        case "disable_auto_settle":
          command = {
            ...common,
            type: "thread.auto-settle.set",
            enabled: input.action === "enable_auto_settle",
          };
          break;
        case "pin": {
          // Always send a key, as the client does: the reducer ignores it for a
          // thread that is already pinned, and a projection read before this
          // command can be stale if an unpin commits in between.
          const orderKey = yield* topOfPinnedRunKey(threads);
          command = { ...common, type: "thread.pin", ...(orderKey ? { orderKey } : {}) };
          break;
        }
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});
