/**
 * SubAgentCoordinator - Cross-provider sub-agent orchestration for MCP tools.
 *
 * Backs the `agent_*` MCP toolkit: a running provider session (Claude,
 * Codex, Cursor, ...) can spawn a sibling thread on any configured provider
 * instance, send follow-up prompts, and await turn completion. Spawned
 * threads flow through the regular orchestration engine, so they persist
 * and render in the UI like user-created threads.
 *
 * Parent/child bookkeeping is in-memory only: after a server restart,
 * previously spawned threads survive as ordinary threads but can no longer
 * be driven through `agent_send`/`agent_wait`.
 */
import {
  CommandId,
  EventId,
  isProviderAvailable,
  MessageId,
  ProviderDriverKind,
  RuntimeTaskId,
  SUB_AGENT_MAX_SPAWN_DEPTH,
  sanitizeSubAgentName,
  SubAgentError,
  ThreadId,
  type TurnId,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type RuntimeMode,
  type ServerProvider,
  type SubAgentListResult,
  type SubAgentSendInput,
  type SubAgentSendResult,
  type SubAgentSpawnInput,
  type SubAgentSpawnResult,
  type SubAgentStatus,
  type SubAgentWaitInput,
  type SubAgentWaitResult,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { enforceSubAgentStandardMode } from "../../../orchestration/subAgentModelPolicy.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import { readTurnStallThresholdMs } from "../../../provider/turnReliabilityConfig.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

const WAIT_POLL_INTERVAL_MILLIS = 500;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 60;
const DEFAULT_TITLE_MAX_LENGTH = 60;
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const CODEX_STANDARD_SERVICE_TIER_ID = "default";
const PARENT_ACTIVITY_TEXT_MAX_LENGTH = 2_000;

interface SubAgentRecord {
  readonly parentThreadId: ThreadId;
  readonly depth: number;
  /** `createdAt` of the most recent turn-start command sent to this child. */
  readonly lastTurnRequestedAt: string;
  /** Optional short name from `agent_spawn` (without `Agent: ` prefix). */
  readonly name?: string;
  readonly title: string;
  readonly providerInstanceId: SubAgentSpawnInput["providerInstanceId"];
  readonly model: string;
  /** Reasoning effort the child's turns run at, when the provider has one. */
  readonly effort?: string;
  /** Parent-log task row for the current child turn. */
  readonly activityTaskId: RuntimeTaskId;
  /** Parent turn that spawned/drove this child, if known. */
  readonly parentTurnId: TurnId | null;
  /** Last observed turn status; updated on spawn/send/wait and refreshed in list. */
  readonly status: SubAgentStatus;
}

export interface SubAgentCoordinatorShape {
  readonly list: (scope: McpInvocationScope) => Effect.Effect<SubAgentListResult>;
  readonly spawn: (
    scope: McpInvocationScope,
    input: SubAgentSpawnInput,
  ) => Effect.Effect<SubAgentSpawnResult, SubAgentError>;
  readonly send: (
    scope: McpInvocationScope,
    input: SubAgentSendInput,
  ) => Effect.Effect<SubAgentSendResult, SubAgentError>;
  readonly wait: (
    scope: McpInvocationScope,
    input: SubAgentWaitInput,
  ) => Effect.Effect<SubAgentWaitResult, SubAgentError>;
}

export class SubAgentCoordinator extends Context.Service<
  SubAgentCoordinator,
  SubAgentCoordinatorShape
>()("t3/mcp/toolkits/agents/SubAgentCoordinator") {}

const isSpawnableProvider = (provider: ServerProvider): boolean =>
  isProviderAvailable(provider) &&
  provider.enabled &&
  provider.installed &&
  provider.status !== "error" &&
  provider.status !== "disabled";

const defaultTitleForPrompt = (prompt: string): string => {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  const seed = firstLine.length > 0 ? firstLine : "Sub-agent task";
  return seed.length > DEFAULT_TITLE_MAX_LENGTH
    ? `${seed.slice(0, DEFAULT_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : seed;
};

/**
 * Resolve a sanitized optional name for storage and titles. Empty after
 * sanitize is treated as absent (schema decode also rejects empty names).
 */
const resolveSpawnName = (input: SubAgentSpawnInput): string | undefined => {
  if (input.name === undefined) return undefined;
  const sanitized = sanitizeSubAgentName(input.name);
  return sanitized.length > 0 ? sanitized : undefined;
};

const AGENT_TITLE_PREFIX = "Agent: ";

const truncateTitle = (title: string): string =>
  title.length > DEFAULT_TITLE_MAX_LENGTH
    ? `${title.slice(0, DEFAULT_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title;

const withAgentTitlePrefix = (title: string): string => {
  const trimmed = title.trim();
  const normalized = trimmed.length > 0 ? trimmed : "Sub-agent task";
  const seed = normalized.replace(/^agent:\s*/i, "").trim() || "Sub-agent task";
  return `${AGENT_TITLE_PREFIX}${seed}`;
};

/**
 * Every product-native `agent_spawn` child is titled with the `Agent:` prefix
 * so clients without an explicit parent/child wire marker can still render it
 * with delegated-agent styling. Prefer an explicit name, then title, then the
 * prompt-derived seed.
 */
const resolveSpawnTitle = (input: SubAgentSpawnInput, name?: string): string => {
  const base = name ?? input.title ?? defaultTitleForPrompt(input.prompt);
  return truncateTitle(withAgentTitlePrefix(base));
};

/**
 * Sub-agents are standard-only. Explicitly persist the provider's standard
 * controls so neither provider defaults nor a parent thread's fast selection
 * can leak into a child.
 */
const resolveSpawnModelSelection = (target: ServerProvider, model: string) => {
  const base = { instanceId: target.instanceId, model };
  const descriptors = target.models.find((candidate) => candidate.slug === model)?.capabilities
    ?.optionDescriptors;
  const options = [
    ...(target.driver === CODEX_DRIVER_KIND
      ? [{ id: "serviceTier", value: CODEX_STANDARD_SERVICE_TIER_ID } as const]
      : []),
    ...(descriptors?.some(
      (descriptor) => descriptor.id === "fastMode" && descriptor.type === "boolean",
    )
      ? [{ id: "fastMode", value: false } as const]
      : []),
  ];

  return enforceSubAgentStandardMode({
    ...base,
    ...(options.length > 0 ? { options } : {}),
  });
};

/** Option ids providers use for reasoning effort (claude/claudex, codex, fugu). */
const EFFORT_OPTION_IDS = new Set(["effort", "reasoningEffort", "reasoning"]);

/**
 * Reasoning effort the child's turns will run at. The child's provider resolves
 * the same descriptor value from this selection when it starts the session, so
 * this reports what the sub-agent actually runs at rather than a guess.
 * Prompt-injected values (e.g. `ultrathink`) are not effort levels and are
 * reported as absent.
 */
const resolveSpawnEffort = (
  target: ServerProvider,
  selection: ModelSelection,
): string | undefined => {
  const caps = target.models.find((candidate) => candidate.slug === selection.model)?.capabilities;
  if (!caps) {
    return undefined;
  }
  const descriptor = getProviderOptionDescriptors({
    caps,
    selections: selection.options,
  }).find((candidate) => candidate.type === "select" && EFFORT_OPTION_IDS.has(candidate.id));
  if (!descriptor || descriptor.type !== "select") {
    return undefined;
  }
  const value = getProviderOptionCurrentValue(descriptor);
  if (typeof value !== "string" || descriptor.promptInjectedValues?.includes(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const finalAssistantText = (thread: OrchestrationThread): string | null => {
  const latestTurn = thread.latestTurn;
  if (latestTurn?.assistantMessageId) {
    const byId = thread.messages.find((message) => message.id === latestTurn.assistantMessageId);
    if (byId) return byId.text;
  }
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "assistant" && latestTurn && message.turnId === latestTurn.turnId) {
      return message.text;
    }
  }
  return null;
};

const taskStatusForSubAgentStatus = (status: SubAgentStatus): "completed" | "failed" | "stopped" =>
  status === "completed" ? "completed" : status === "interrupted" ? "stopped" : "failed";

const completionSummaryForSubAgentStatus = (status: SubAgentStatus): string => {
  switch (status) {
    case "completed":
      return "Sub-agent completed.";
    case "interrupted":
      return "Sub-agent interrupted.";
    case "error":
      return "Sub-agent failed.";
    case "running":
      return "Sub-agent still running.";
  }
};

const stripAgentTitlePrefix = (title: string): string =>
  title.replace(/^agent:\s*/i, "").trim() || title;

const truncateParentActivityText = (text: string): string =>
  text.length > PARENT_ACTIVITY_TEXT_MAX_LENGTH
    ? `${text.slice(0, PARENT_ACTIVITY_TEXT_MAX_LENGTH - 1).trimEnd()}…`
    : text;

const hasTurnStartFailureSince = (thread: OrchestrationThread, sinceIso: string): boolean =>
  thread.activities.some(
    (activity) =>
      activity.tone === "error" &&
      activity.kind === "provider.turn.start.failed" &&
      activity.createdAt >= sinceIso,
  );

const turnStatus = (thread: OrchestrationThread, sinceIso: string): SubAgentStatus => {
  const latestTurn = thread.latestTurn;
  // The projection lags the dispatched turn-start command; treat a missing
  // or older latest turn as the requested turn still spinning up — unless the
  // provider already failed before creating the turn (invalid model, session
  // start error, ...), which ProviderCommandReactor records only as an error
  // activity on the thread.
  if (!latestTurn || latestTurn.requestedAt < sinceIso) {
    return hasTurnStartFailureSince(thread, sinceIso) ? "error" : "running";
  }
  if (latestTurn.state === "running") return "running";
  if ((thread.session?.activeTurnId ?? null) !== null) return "running";
  return latestTurn.state;
};

const isTerminalStatus = (status: SubAgentStatus): status is Exclude<SubAgentStatus, "running"> =>
  status !== "running";

const lastActivityAt = (thread: OrchestrationThread): string | undefined => {
  const timestamps = [
    thread.session?.updatedAt,
    thread.latestTurn?.startedAt ?? undefined,
    thread.latestTurn?.requestedAt,
    ...thread.messages.map((message) => message.updatedAt),
    ...thread.activities
      .filter((activity) => activity.kind !== "session.health")
      .map((activity) => activity.createdAt),
  ].filter((value): value is string => value !== undefined);
  return timestamps.reduce<string | undefined>(
    (latest, value) => (latest === undefined || value > latest ? value : latest),
    undefined,
  );
};

const makeSubAgentCoordinator = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  const providerService = yield* ProviderService;
  const children = yield* SynchronizedRef.make<ReadonlyMap<ThreadId, SubAgentRecord>>(new Map());

  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const dispatchFailed = (operation: string) => (cause: unknown) =>
    new SubAgentError({
      reason: "dispatch-failed",
      description: `Failed to ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });

  const requireChildOfCaller = Effect.fn("SubAgentCoordinator.requireChildOfCaller")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const record = (yield* SynchronizedRef.get(children)).get(threadId);
    if (!record || record.parentThreadId !== scope.threadId) {
      return yield* new SubAgentError({
        reason: "thread-not-found",
        description: `Thread ${threadId} is not a sub-agent spawned by this session. Use agent_spawn first; sub-agent handles do not survive server restarts.`,
      });
    }
    return record;
  });

  const readThreadDetail = Effect.fn("SubAgentCoordinator.readThreadDetail")(function* (
    threadId: ThreadId,
  ) {
    const detail = yield* snapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.mapError(dispatchFailed("read sub-agent thread state")));
    if (Option.isNone(detail)) {
      return yield* new SubAgentError({
        reason: "thread-not-found",
        description: `Sub-agent thread ${threadId} no longer exists (it may have been deleted or archived).`,
      });
    }
    return detail.value;
  });

  const writeStatus = Effect.fn("SubAgentCoordinator.writeStatus")(function* (
    threadId: ThreadId,
    status: SubAgentStatus,
    patch?: Partial<SubAgentRecord>,
  ) {
    yield* SynchronizedRef.update(children, (current) => {
      const existing = current.get(threadId);
      if (!existing) return current;
      const next = new Map(current);
      next.set(threadId, { ...existing, ...patch, status });
      return next;
    });
  });

  const appendParentTaskActivity = Effect.fn("SubAgentCoordinator.appendParentTaskActivity")(
    function* (input: {
      readonly parentThreadId: ThreadId;
      readonly taskId: RuntimeTaskId;
      readonly parentTurnId: TurnId | null;
      readonly kind: "task.started" | "task.progress" | "task.completed";
      readonly summary: string;
      readonly payload: OrchestrationThreadActivity["payload"];
      readonly createdAt?: string;
    }) {
      const createdAt = input.createdAt ?? (yield* nowIso);
      const commandUuid = yield* randomUuid;
      const activityUuid = yield* randomUuid;
      yield* engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`server:sub-agent-activity:${commandUuid}`),
          threadId: input.parentThreadId,
          createdAt,
          activity: {
            id: EventId.make(`sub-agent:${input.taskId}:${input.kind}:${activityUuid}`),
            tone: "info",
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: input.parentTurnId,
            createdAt,
          },
        })
        .pipe(Effect.mapError(dispatchFailed("append sub-agent activity")));
    },
  );

  const readParentTurnId = Effect.fn("SubAgentCoordinator.readParentTurnId")(function* (
    threadId: ThreadId,
  ) {
    const detail = yield* snapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));
    if (Option.isNone(detail)) {
      return null;
    }
    return detail.value.session?.activeTurnId ?? detail.value.latestTurn?.turnId ?? null;
  });

  const emitSpawnStartedActivity = Effect.fn("SubAgentCoordinator.emitSpawnStartedActivity")(
    function* (input: {
      readonly scope: McpInvocationScope;
      readonly taskId: RuntimeTaskId;
      readonly childThreadId: ThreadId;
      readonly providerLabel: string;
      readonly title: string;
      readonly model: string;
      readonly effort?: string | undefined;
      readonly parentTurnId: TurnId | null;
      readonly createdAt: string;
    }) {
      yield* appendParentTaskActivity({
        parentThreadId: input.scope.threadId,
        taskId: input.taskId,
        parentTurnId: input.parentTurnId,
        kind: "task.started",
        summary: "Sub-agent spawned",
        createdAt: input.createdAt,
        payload: {
          taskId: input.taskId,
          description: stripAgentTitlePrefix(input.title),
          taskType: "sub-agent",
          subagentType: input.providerLabel,
          model: input.model,
          ...(input.effort ? { effort: input.effort } : {}),
          workflowName: "agent_spawn",
          toolUseId: input.childThreadId,
        },
      });
    },
  );

  const emitSpawnProgressActivity = Effect.fn("SubAgentCoordinator.emitSpawnProgressActivity")(
    function* (input: {
      readonly record: SubAgentRecord;
      readonly threadId: ThreadId;
      readonly detail: string;
      readonly summary: string;
    }) {
      yield* appendParentTaskActivity({
        parentThreadId: input.record.parentThreadId,
        taskId: input.record.activityTaskId,
        parentTurnId: input.record.parentTurnId,
        kind: "task.progress",
        summary: "Sub-agent progress",
        payload: {
          taskId: input.record.activityTaskId,
          description: stripAgentTitlePrefix(input.record.title),
          summary: input.summary,
          lastToolName: "agent_wait",
          subagentType: input.record.providerInstanceId,
          toolUseId: input.threadId,
          detail: input.detail,
        },
      });
    },
  );

  const emitCompletionActivity = Effect.fn("SubAgentCoordinator.emitCompletionActivity")(
    function* (input: {
      readonly record: SubAgentRecord;
      readonly threadId: ThreadId;
      readonly status: Exclude<SubAgentStatus, "running">;
      readonly finalText: string | null;
      readonly createdAt?: string;
    }) {
      yield* appendParentTaskActivity({
        parentThreadId: input.record.parentThreadId,
        taskId: input.record.activityTaskId,
        parentTurnId: input.record.parentTurnId,
        kind: "task.completed",
        summary: "Sub-agent finished",
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
        payload: {
          taskId: input.record.activityTaskId,
          status: taskStatusForSubAgentStatus(input.status),
          summary: truncateParentActivityText(
            input.finalText ?? completionSummaryForSubAgentStatus(input.status),
          ),
          toolUseId: input.threadId,
        },
      });
    },
  );

  /**
   * Live turn status for a child, with a best-effort record update so
   * subsequent list/send/wait see the same value without re-reading.
   */
  const observeStatus = Effect.fn("SubAgentCoordinator.observeStatus")(function* (
    threadId: ThreadId,
    record: SubAgentRecord,
  ) {
    const thread = yield* readThreadDetail(threadId);
    const status = turnStatus(thread, record.lastTurnRequestedAt);
    if (status !== record.status) {
      yield* writeStatus(threadId, status);
      if (isTerminalStatus(status)) {
        yield* emitCompletionActivity({
          record,
          threadId,
          status,
          finalText: finalAssistantText(thread),
        }).pipe(Effect.catch(() => Effect.void));
      }
    }
    return { thread, status } as const;
  });

  const startTurn = Effect.fn("SubAgentCoordinator.startTurn")(function* (
    threadId: ThreadId,
    prompt: string,
    runtimeMode: RuntimeMode,
  ) {
    const createdAt = yield* nowIso;
    const commandUuid = yield* randomUuid;
    const messageUuid = yield* randomUuid;
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:sub-agent-turn:${commandUuid}`),
        threadId,
        message: {
          messageId: MessageId.make(messageUuid),
          role: "user",
          text: prompt,
          attachments: [],
        },
        runtimeMode,
        interactionMode: "default",
        createdAt,
      })
      .pipe(Effect.mapError(dispatchFailed("start sub-agent turn")));
    return createdAt;
  });

  const list: SubAgentCoordinatorShape["list"] = Effect.fn("SubAgentCoordinator.list")(
    function* (scope) {
      const providers = yield* providerRegistry.getProviders;
      const childRecords = yield* SynchronizedRef.get(children);
      const owned = [...childRecords.entries()].filter(
        ([, record]) => record.parentThreadId === scope.threadId,
      );

      const agents: Array<SubAgentListResult["agents"][number]> = [];
      for (const [threadId, record] of owned) {
        // Best-effort refresh from the live thread so completed agents are not
        // listed as still running after the turn settles without a wait. Failures
        // fall back to the last recorded status — list must stay infallible.
        let status = record.status;
        const detail = yield* snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));
        if (Option.isSome(detail)) {
          status = turnStatus(detail.value, record.lastTurnRequestedAt);
          if (status !== record.status) {
            yield* writeStatus(threadId, status);
            if (isTerminalStatus(status)) {
              yield* emitCompletionActivity({
                record,
                threadId,
                status,
                finalText: finalAssistantText(detail.value),
              }).pipe(Effect.catch(() => Effect.void));
            }
          }
        }
        agents.push({
          threadId,
          ...(record.name !== undefined ? { name: record.name } : {}),
          title: record.title,
          providerInstanceId: record.providerInstanceId,
          model: record.model,
          status,
        });
      }

      return {
        providers: providers.map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          ...(provider.displayName !== undefined ? { displayName: provider.displayName } : {}),
          status: provider.status,
          authStatus: provider.auth.status,
          spawnable: isSpawnableProvider(provider),
          models: provider.models.map((model) => model.slug),
          isCaller: provider.instanceId === scope.providerInstanceId,
        })),
        agents,
      };
    },
  );

  const spawn: SubAgentCoordinatorShape["spawn"] = Effect.fn("SubAgentCoordinator.spawn")(
    function* (scope, input) {
      const callerDepth = (yield* SynchronizedRef.get(children)).get(scope.threadId)?.depth ?? 0;
      if (callerDepth >= SUB_AGENT_MAX_SPAWN_DEPTH) {
        return yield* new SubAgentError({
          reason: "depth-limit-exceeded",
          description: `Sub-agents may only nest ${SUB_AGENT_MAX_SPAWN_DEPTH} levels deep; this session is already at depth ${callerDepth}. Do the work in this session instead.`,
        });
      }

      const providers = yield* providerRegistry.getProviders;
      const target = providers.find((provider) => provider.instanceId === input.providerInstanceId);
      if (!target) {
        return yield* new SubAgentError({
          reason: "provider-not-found",
          description: `No provider instance "${input.providerInstanceId}" is configured. Call agent_list for valid instance ids.`,
        });
      }
      if (!isSpawnableProvider(target)) {
        return yield* new SubAgentError({
          reason: "provider-not-spawnable",
          description: `Provider instance "${target.instanceId}" (${target.driver}) is not ready (status: ${target.status}, auth: ${target.auth.status}). Call agent_list to pick a spawnable provider.`,
        });
      }
      const callerThread = yield* snapshotQuery
        .getThreadShellById(scope.threadId)
        .pipe(Effect.mapError(dispatchFailed("read calling thread")));
      if (Option.isNone(callerThread)) {
        return yield* new SubAgentError({
          reason: "caller-thread-not-found",
          description:
            "The calling session's thread no longer exists; cannot place a sub-agent next to it.",
        });
      }
      const parent = callerThread.value;
      const inheritedModel =
        parent.modelSelection.instanceId === target.instanceId &&
        target.models.some((candidate) => candidate.slug === parent.modelSelection.model)
          ? parent.modelSelection.model
          : undefined;
      const model = input.model ?? inheritedModel ?? target.models[0]?.slug;
      if (model === undefined) {
        return yield* new SubAgentError({
          reason: "model-not-resolved",
          description: `Provider instance "${target.instanceId}" reports no models; pass an explicit model slug.`,
        });
      }

      const createdAt = yield* nowIso;
      const commandUuid = yield* randomUuid;
      const threadUuid = yield* randomUuid;
      const childThreadId = ThreadId.make(threadUuid);
      const activityTaskId = RuntimeTaskId.make(`agent:${threadUuid}`);
      const name = resolveSpawnName(input);
      const title = resolveSpawnTitle(input, name);
      const modelSelection = resolveSpawnModelSelection(target, model);
      const effort = resolveSpawnEffort(target, modelSelection);
      const parentTurnId = yield* readParentTurnId(scope.threadId);

      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`server:sub-agent-spawn:${commandUuid}`),
          threadId: childThreadId,
          projectId: parent.projectId,
          title,
          modelSelection,
          runtimeMode: parent.runtimeMode,
          interactionMode: "default",
          branch: parent.branch,
          worktreePath: parent.worktreePath,
          createdAt,
        })
        .pipe(Effect.mapError(dispatchFailed("create sub-agent thread")));

      const lastTurnRequestedAt = yield* startTurn(childThreadId, input.prompt, parent.runtimeMode);

      yield* emitSpawnStartedActivity({
        scope,
        taskId: activityTaskId,
        childThreadId,
        providerLabel: target.displayName ?? target.driver,
        title,
        model,
        ...(effort !== undefined ? { effort } : {}),
        parentTurnId,
        createdAt,
      }).pipe(Effect.catch(() => Effect.void));

      yield* SynchronizedRef.update(children, (current) => {
        const next = new Map(current);
        next.set(childThreadId, {
          parentThreadId: scope.threadId,
          depth: callerDepth + 1,
          lastTurnRequestedAt,
          ...(name !== undefined ? { name } : {}),
          title,
          providerInstanceId: target.instanceId,
          model,
          ...(effort !== undefined ? { effort } : {}),
          activityTaskId,
          parentTurnId,
          status: "running",
        });
        return next;
      });

      return {
        threadId: childThreadId,
        providerInstanceId: target.instanceId,
        model,
        title,
        ...(name !== undefined ? { name } : {}),
        status: "running" as const,
      };
    },
  );

  const send: SubAgentCoordinatorShape["send"] = Effect.fn("SubAgentCoordinator.send")(
    function* (scope, input) {
      const record = yield* requireChildOfCaller(scope, input.threadId);
      const { thread, status } = yield* observeStatus(input.threadId, record);
      if (status === "running") {
        return yield* new SubAgentError({
          reason: "invalid-status",
          description: `Sub-agent ${input.threadId} is still running. Call agent_wait before sending another prompt (status: running).`,
        });
      }
      // Terminal (completed / interrupted / error): allow follow-up turns.
      const lastTurnRequestedAt = yield* startTurn(
        input.threadId,
        input.prompt,
        thread.runtimeMode,
      );
      const activityTaskId = RuntimeTaskId.make(
        `agent:${input.threadId}:${lastTurnRequestedAt.replace(/[^A-Za-z0-9_-]/g, "-")}`,
      );
      const parentTurnId = yield* readParentTurnId(scope.threadId);
      yield* emitSpawnStartedActivity({
        scope,
        taskId: activityTaskId,
        childThreadId: input.threadId,
        providerLabel: record.providerInstanceId,
        title: record.title,
        model: record.model,
        ...(record.effort !== undefined ? { effort: record.effort } : {}),
        parentTurnId,
        createdAt: lastTurnRequestedAt,
      }).pipe(Effect.catch(() => Effect.void));
      yield* SynchronizedRef.update(children, (current) => {
        const next = new Map(current);
        next.set(input.threadId, {
          ...record,
          lastTurnRequestedAt,
          activityTaskId,
          parentTurnId,
          status: "running",
        });
        return next;
      });
      return { threadId: input.threadId, status: "running" as const };
    },
  );

  const wait: SubAgentCoordinatorShape["wait"] = Effect.fn("SubAgentCoordinator.wait")(
    function* (scope, input) {
      const record = yield* requireChildOfCaller(scope, input.threadId);

      // A prior wait (or list refresh) already marked this handle terminal.
      // Refuse so callers cannot treat a finished agent as still producing
      // output — start a follow-up turn with agent_send first.
      if (isTerminalStatus(record.status)) {
        const { status } = yield* observeStatus(input.threadId, record);
        if (isTerminalStatus(status)) {
          return yield* new SubAgentError({
            reason: "invalid-status",
            description: `Sub-agent ${input.threadId} is not running (status: ${status}). Call agent_send to start a follow-up turn, or agent_list to inspect finished agents.`,
          });
        }
      }

      const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
      const deadline = (yield* Clock.currentTimeMillis) + timeoutSeconds * 1_000;

      const runningSnapshot = Effect.fn("SubAgentCoordinator.wait.runningSnapshot")(function* (
        thread: OrchestrationThread,
        fresh: SubAgentRecord,
      ) {
        const trackedActivity = providerService.getSessionActivity
          ? yield* providerService.getSessionActivity(input.threadId)
          : undefined;
        const trackedActivityAt = trackedActivity?.lastActivityAt;
        const activityAt = [trackedActivityAt, lastActivityAt(thread), fresh.lastTurnRequestedAt]
          .filter((value): value is string => value !== undefined)
          .reduce((latest, value) => (value > latest ? value : latest), fresh.lastTurnRequestedAt);
        const activityAtMs = Option.match(DateTime.make(activityAt), {
          onNone: () => undefined,
          onSome: DateTime.toEpochMillis,
        });
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const thresholdMs = readTurnStallThresholdMs();
        const trackedStalled =
          trackedActivityAt !== undefined && trackedActivityAt >= fresh.lastTurnRequestedAt
            ? trackedActivity?.stalled
            : undefined;
        const stalled =
          trackedStalled ??
          (thresholdMs > 0 && activityAtMs !== undefined && now - activityAtMs >= thresholdMs);
        return { activityAt, stalled } as const;
      });

      while (true) {
        // Re-read the record each poll so a concurrent agent_send's new
        // lastTurnRequestedAt is observed.
        const fresh = (yield* SynchronizedRef.get(children)).get(input.threadId) ?? record;
        const thread = yield* readThreadDetail(input.threadId);
        const status = turnStatus(thread, fresh.lastTurnRequestedAt);
        if (status !== fresh.status) {
          yield* writeStatus(input.threadId, status);
        }
        if (isTerminalStatus(status)) {
          // First observation of terminal for this turn — return the result.
          const activityAt = lastActivityAt(thread) ?? fresh.lastTurnRequestedAt;
          const finalText = finalAssistantText(thread);
          if (status !== fresh.status) {
            yield* emitCompletionActivity({
              record: fresh,
              threadId: input.threadId,
              status,
              finalText,
              createdAt: activityAt,
            }).pipe(Effect.catch(() => Effect.void));
          }
          return {
            threadId: input.threadId,
            status,
            finalText,
            lastActivityAt: activityAt,
            stalled: false,
          };
        }
        const snapshot = yield* runningSnapshot(thread, fresh);
        if (snapshot.stalled) {
          yield* emitSpawnProgressActivity({
            record: fresh,
            threadId: input.threadId,
            detail: `No child-thread activity since ${snapshot.activityAt}.`,
            summary: "Sub-agent appears stalled",
          }).pipe(Effect.catch(() => Effect.void));
          return {
            threadId: input.threadId,
            status: "running" as const,
            finalText: null,
            lastActivityAt: snapshot.activityAt,
            stalled: true,
          };
        }
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          yield* emitSpawnProgressActivity({
            record: fresh,
            threadId: input.threadId,
            detail: `Child thread is still running; last activity at ${snapshot.activityAt}.`,
            summary: "Sub-agent still running",
          }).pipe(Effect.catch(() => Effect.void));
          return {
            threadId: input.threadId,
            status: "running" as const,
            finalText: null,
            lastActivityAt: snapshot.activityAt,
            stalled: snapshot.stalled,
          };
        }
        yield* Effect.sleep(Duration.millis(WAIT_POLL_INTERVAL_MILLIS));
      }
    },
  );

  return SubAgentCoordinator.of({ list, spawn, send, wait });
});

export const SubAgentCoordinatorLive = Layer.effect(SubAgentCoordinator, makeSubAgentCoordinator);

/** Exposed for tests. */
export const __testing = {
  make: makeSubAgentCoordinator,
  resolveSpawnTitle,
  resolveSpawnName,
  defaultTitleForPrompt,
  DEFAULT_TITLE_MAX_LENGTH,
};
