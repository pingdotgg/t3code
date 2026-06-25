/**
 * TaskOrchestrator live layer.
 *
 * `startTasks` spawns one child thread per delegated sub-task in the lead's
 * working directory (shared cwd) and starts its turn, returning immediately.
 * `collectTasks` later polls those children up to a bounded deadline and reads
 * back their final assistant message. Completion is detected via
 * `latestTurn.state` leaving `"running"` (the production RuntimeReceiptBus is a
 * no-op, so we do not rely on it). Splitting spawn from collect keeps each MCP
 * tool call short enough to fit inside the provider's request timeout.
 *
 * @module TaskOrchestrator
 */
import {
  CommandId,
  type DelegateTaskInput,
  type DelegateTaskResult,
  DEFAULT_DELEGATION_CONCURRENCY,
  MAX_DELEGATED_TASKS,
  MessageId,
  type ModelSelection,
  type OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  TaskOrchestrator,
  type TaskOrchestratorCollectInput,
  type TaskOrchestratorShape,
  type TaskOrchestratorStartInput,
} from "../Services/TaskOrchestrator.ts";
import { resolveTaskModelSelection } from "../TaskModelRouter.ts";

/** How often to poll the read model for sub-task completion. */
const POLL_INTERVAL = Duration.millis(250);
/** Title fallback length when a sub-task has no explicit label. */
const TITLE_MAX_LENGTH = 80;

/** Per-child metadata kept so collect can label/attribute results to their lead. */
interface DelegatedTaskMeta {
  readonly label: string | undefined;
  readonly modelSelection: ModelSelection;
  readonly parentThreadId: ThreadId;
}

const deriveTitle = (task: DelegateTaskInput): string => {
  if (task.label !== undefined) return task.label;
  // First non-blank line of the prompt; prompt is guaranteed non-empty so this
  // always yields a non-empty title (required by the thread title schema).
  const firstLine =
    task.prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? task.prompt.trim();
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…`
    : firstLine;
};

const finalAssistantText = (thread: OrchestrationThread): string | undefined => {
  const latestTurn = thread.latestTurn;
  if (latestTurn?.assistantMessageId != null) {
    const byId = thread.messages.find((message) => message.id === latestTurn.assistantMessageId);
    if (byId !== undefined) return byId.text;
  }
  const assistantMessages = thread.messages.filter(
    (message) =>
      message.role === "assistant" && (latestTurn === null || message.turnId === latestTurn.turnId),
  );
  return assistantMessages.at(-1)?.text;
};

const makeTaskOrchestrator = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const registry = yield* Ref.make<ReadonlyMap<string, DelegatedTaskMeta>>(new Map());

  const newUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const readDetail = (threadId: ThreadId): Effect.Effect<OrchestrationThread | undefined> =>
    query.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined), Effect.orDie);

  const pollUntilDone = (
    threadId: ThreadId,
    deadlineMs: number,
  ): Effect.Effect<OrchestrationThread | undefined> =>
    Effect.gen(function* () {
      const detail = yield* readDetail(threadId);
      const latestTurn = detail?.latestTurn ?? null;
      if (detail !== undefined && latestTurn !== null && latestTurn.state !== "running") {
        return detail;
      }
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadlineMs) return detail;
      yield* Effect.sleep(POLL_INTERVAL);
      return yield* pollUntilDone(threadId, deadlineMs);
    });

  const resultBase = (threadId: ThreadId, meta: DelegatedTaskMeta | undefined) => ({
    label: meta?.label,
    threadId,
    instanceId: meta?.modelSelection.instanceId,
    model: meta?.modelSelection.model,
  });

  const resultFromDetail = (
    threadId: ThreadId,
    meta: DelegatedTaskMeta | undefined,
    detail: OrchestrationThread | undefined,
  ): DelegateTaskResult => {
    const base = resultBase(threadId, meta);
    const latestTurn = detail?.latestTurn ?? null;
    if (detail === undefined || latestTurn === null || latestTurn.state === "running") {
      return { ...base, status: "running" } satisfies DelegateTaskResult;
    }
    if (latestTurn.state === "error") {
      return {
        ...base,
        status: "error",
        error: detail.session?.lastError ?? "Sub-task ended in an error state.",
      } satisfies DelegateTaskResult;
    }
    return {
      ...base,
      status: "completed",
      message: finalAssistantText(detail) ?? "",
    } satisfies DelegateTaskResult;
  };

  const spawnOne = (
    parent: OrchestrationThread,
    routing: TaskOrchestratorRoutingSettings,
    task: DelegateTaskInput,
  ): Effect.Effect<DelegateTaskResult> =>
    Effect.gen(function* () {
      const childId = ThreadId.make(yield* newUuid);
      const modelSelection = resolveTaskModelSelection(task, {
        parentModelSelection: parent.modelSelection,
        routing,
      });
      const base = {
        label: task.label,
        threadId: childId,
        instanceId: modelSelection.instanceId,
        model: modelSelection.model,
      } as const;

      return yield* Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(`mcp:delegate:create:${childId}`),
            threadId: childId,
            projectId: parent.projectId,
            title: deriveTitle(task),
            modelSelection,
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            branch: null,
            // Shared working directory: child runs where the lead thread runs.
            worktreePath: parent.worktreePath,
            parentThreadId: parent.id,
            ...(task.label !== undefined ? { taskLabel: task.label } : {}),
            createdAt,
          })
          .pipe(Effect.orDie);

        const turnAt = yield* nowIso;
        const messageId = MessageId.make(yield* newUuid);
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`mcp:delegate:turn:${childId}`),
            threadId: childId,
            message: { messageId, role: "user", text: task.prompt, attachments: [] },
            modelSelection,
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            createdAt: turnAt,
          })
          .pipe(Effect.orDie);

        yield* Ref.update(registry, (current) => {
          const next = new Map(current);
          next.set(childId, { label: task.label, modelSelection, parentThreadId: parent.id });
          return next;
        });

        return { ...base, status: "running" } satisfies DelegateTaskResult;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({
            ...base,
            status: "error",
            error: Cause.pretty(cause),
          } satisfies DelegateTaskResult),
        ),
      );
    });

  const startTasks: TaskOrchestratorShape["startTasks"] = (input: TaskOrchestratorStartInput) =>
    Effect.gen(function* () {
      const parent = yield* readDetail(input.parentThreadId);
      if (parent === undefined) {
        return { results: [] };
      }
      const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
      const tasks = input.tasks.slice(0, MAX_DELEGATED_TASKS);
      const concurrency = Math.max(
        1,
        Math.min(input.maxConcurrency ?? DEFAULT_DELEGATION_CONCURRENCY, MAX_DELEGATED_TASKS),
      );
      const results = yield* Effect.forEach(
        tasks,
        (task) => spawnOne(parent, settings.taskRouting, task),
        { concurrency },
      );
      return { results };
    });

  const collectTasks: TaskOrchestratorShape["collectTasks"] = (
    input: TaskOrchestratorCollectInput,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(registry);
      const targetIds: ReadonlyArray<ThreadId> =
        input.threadIds !== undefined && input.threadIds.length > 0
          ? input.threadIds
          : Array.from(current.entries())
              .filter(([, meta]) => meta.parentThreadId === input.parentThreadId)
              .map(([id]) => ThreadId.make(id));
      if (targetIds.length === 0) {
        return { results: [] };
      }
      const startMs = yield* Clock.currentTimeMillis;
      const deadlineMs = startMs + Math.max(0, input.waitMs);
      const results = yield* Effect.forEach(
        targetIds,
        (threadId) =>
          pollUntilDone(threadId, deadlineMs).pipe(
            Effect.map((detail) => resultFromDetail(threadId, current.get(threadId), detail)),
            Effect.catchCause((cause) =>
              Effect.succeed({
                ...resultBase(threadId, current.get(threadId)),
                status: "error",
                error: Cause.pretty(cause),
              } satisfies DelegateTaskResult),
            ),
          ),
        { concurrency: Math.max(1, Math.min(targetIds.length, MAX_DELEGATED_TASKS)) },
      );
      return { results };
    });

  const isDelegatedChild: TaskOrchestratorShape["isDelegatedChild"] = (threadId: ThreadId) =>
    Ref.get(registry).pipe(Effect.map((current) => current.has(threadId)));

  return TaskOrchestrator.of({ startTasks, collectTasks, isDelegatedChild });
});

// Local alias so the routing param type stays readable without importing the
// settings type (it is the `taskRouting` slice of ServerSettings).
type TaskOrchestratorRoutingSettings = Parameters<typeof resolveTaskModelSelection>[1]["routing"];

export const layer = Layer.effect(TaskOrchestrator, makeTaskOrchestrator);
