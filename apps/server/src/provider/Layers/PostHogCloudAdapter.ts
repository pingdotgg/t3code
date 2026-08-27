import {
  ApprovalRequestId,
  EventId,
  PostHogCloudResumeCursor,
  PostHogCloudRunId,
  PostHogCloudRuntimePayload,
  PostHogCloudTaskId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { PostHogClient } from "../../posthog/PostHogClient.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("posthogCloud");
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

interface PermissionOption {
  readonly optionId: string;
  readonly kind?: string;
  readonly name?: string;
}

interface CloudSessionContext {
  session: ProviderSession;
  taskId: PostHogCloudTaskId | undefined;
  runId: PostHogCloudRunId | undefined;
  repository: string | undefined;
  reportId: string | undefined;
  activeTurnId: TurnId | undefined;
  assistantItemId: RuntimeItemId | undefined;
  assistantText: string;
  reasoningItemId: RuntimeItemId | undefined;
  watcherRunId: PostHogCloudRunId | undefined;
  watcher: Fiber.Fiber<void> | undefined;
  sequence: number;
  readonly seen: Set<string>;
  readonly toolItems: Map<string, RuntimeItemId>;
  readonly permissions: Map<string, ReadonlyArray<PermissionOption>>;
  readonly userInputRequests: Set<string>;
  readonly locallyResolvedUserInputs: Set<string>;
}

function userInputQuestions(value: unknown): ReadonlyArray<{
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
}> {
  const metadata = record(value);
  const candidates = Array.isArray(metadata?.questions)
    ? metadata.questions
    : metadata?.question
      ? [metadata]
      : [];
  return candidates.flatMap((candidate) => {
    const question = record(candidate);
    if (typeof question?.question !== "string" || !question.question.trim()) return [];
    const text = question.question.trim();
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          const option = record(rawOption);
          if (typeof option?.label !== "string" || !option.label.trim()) return [];
          return [
            {
              label: option.label.trim(),
              description: typeof option.description === "string" ? option.description.trim() : "",
            },
          ];
        })
      : [];
    return [
      {
        id: text,
        header:
          typeof question.header === "string" && question.header.trim()
            ? question.header.trim()
            : "Question",
        question: text,
        options,
        multiSelect: question.multiSelect === true,
      },
    ];
  });
}

function normalizedUserInputAnswers(answers: ProviderUserInputAnswers): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([question, answer]) => {
      if (typeof answer === "string") return [[question, answer]];
      if (Array.isArray(answer)) {
        return [[question, answer.filter((value) => typeof value === "string").join(", ")]];
      }
      const answerRecord = record(answer);
      if (Array.isArray(answerRecord?.answers)) {
        return [
          [question, answerRecord.answers.filter((value) => typeof value === "string").join(", ")],
        ];
      }
      return [];
    }),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const content = record(value);
  return typeof content?.text === "string" ? content.text : undefined;
}

function cloudModel(
  model: string,
): { runtimeAdapter: "claude" | "codex"; model: string } | undefined {
  const separator = model.indexOf(":");
  if (separator <= 0) return undefined;
  const runtimeAdapter = model.slice(0, separator);
  const rawModel = model.slice(separator + 1);
  if ((runtimeAdapter !== "claude" && runtimeAdapter !== "codex") || rawModel.length === 0) {
    return undefined;
  }
  return { runtimeAdapter, model: rawModel };
}

function permissionDecisionKind(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
    case "acceptAlways":
      return "allow_always";
    case "accept":
      return "allow_once";
    case "decline":
    case "cancel":
      return "reject_once";
  }
}

function itemType(
  kind: unknown,
): "command_execution" | "file_change" | "web_search" | "dynamic_tool_call" {
  if (kind === "execute") return "command_execution";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file_change";
  if (kind === "search" || kind === "fetch") return "web_search";
  return "dynamic_tool_call";
}

function itemStatus(status: unknown): "inProgress" | "completed" | "failed" | undefined {
  if (status === "pending" || status === "in_progress") return "inProgress";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return undefined;
}

function planStatus(status: unknown): "pending" | "inProgress" | "completed" {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "inProgress";
  return "pending";
}

function parseJsonLines(text: string): ReadonlyArray<unknown> {
  const entries: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface PostHogCloudAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly posthog: PostHogClient["Service"];
  readonly fileSystem: FileSystem.FileSystem;
}

export const makePostHogCloudAdapter = Effect.fn("makePostHogCloudAdapter")(function* (
  options: PostHogCloudAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const posthog = options.posthog;
  const fileSystem = options.fileSystem;
  const scope = yield* Scope.Scope;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CloudSessionContext>();
  const ingestLock = yield* Semaphore.make(1);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to create a Cloud Task runtime identifier.",
          cause,
        }),
    ),
  );

  const adapterError = (method: string) => (cause: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });

  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const sessionPayload = (context: CloudSessionContext): PostHogCloudRuntimePayload => ({
    schemaVersion: 1,
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.repository ? { repository: context.repository } : {}),
  });

  const resumeCursor = (context: CloudSessionContext): PostHogCloudResumeCursor => ({
    schemaVersion: 1,
    ...(context.runId ? { runId: context.runId } : {}),
    ...(() => {
      const cursor = record(context.session.resumeCursor);
      return typeof cursor?.lastEventId === "string" ? { lastEventId: cursor.lastEventId } : {};
    })(),
  });

  const syncSession = (context: CloudSessionContext, patch?: Partial<ProviderSession>): void => {
    context.session = {
      ...context.session,
      ...patch,
      runtimePayload: sessionPayload(context),
      resumeCursor: resumeCursor(context),
    };
  };

  const eventBase = Effect.fn("PostHogCloudAdapter.eventBase")(function* (
    context: CloudSessionContext,
    source: unknown,
    timestamp?: string,
  ) {
    context.sequence += 1;
    const eventId = EventId.make(`posthog-cloud:${context.runId ?? "pending"}:${context.sequence}`);
    return {
      eventId,
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId: context.session.threadId,
      createdAt: timestamp ?? (yield* nowIso),
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      raw: {
        source: "acp.posthog-cloud.extension" as const,
        payload: source,
      },
    };
  });

  const mapEntry = Effect.fn("PostHogCloudAdapter.mapEntry")(function* (
    context: CloudSessionContext,
    entry: unknown,
  ): Effect.fn.Return<ReadonlyArray<ProviderRuntimeEvent>, never> {
    const envelope = record(entry);
    const notification = record(envelope?.notification) ?? record(envelope?.message);
    const livePermission = envelope?.type === "permission_request" ? envelope : undefined;
    if (!notification && !livePermission) return [];
    const method = livePermission
      ? "_posthog/permission_request"
      : typeof notification?.method === "string"
        ? notification.method
        : undefined;
    const params = livePermission ?? record(notification?.params);
    const timestamp = typeof envelope?.timestamp === "string" ? envelope.timestamp : undefined;
    const base = yield* eventBase(context, entry, timestamp).pipe(Effect.orDie);

    if (method === "session/update") {
      const update = record(params?.update);
      if (!update) return [];
      const updateType = update?.sessionUpdate;
      if (updateType === "agent_message" || updateType === "agent_message_chunk") {
        const text = textFromContent(update.content);
        if (text === undefined) return [];
        const delta =
          updateType === "agent_message"
            ? context.assistantText.length === 0
              ? text
              : text.startsWith(context.assistantText)
                ? text.slice(context.assistantText.length)
                : ""
            : text;
        context.assistantText =
          updateType === "agent_message" ? text : context.assistantText + text;
        if (!delta) return [];
        const emitted: ProviderRuntimeEvent[] = [];
        if (!context.assistantItemId) {
          context.assistantItemId = RuntimeItemId.make(
            `assistant:${context.runId}:${context.sequence}`,
          );
          emitted.push({
            ...base,
            type: "item.started",
            itemId: context.assistantItemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        }
        emitted.push({
          ...base,
          type: "content.delta",
          itemId: context.assistantItemId,
          payload: { streamKind: "assistant_text", delta },
        });
        return emitted;
      }
      if (updateType === "agent_thought_chunk") {
        const delta = textFromContent(update.content);
        if (delta === undefined) return [];
        const emitted: ProviderRuntimeEvent[] = [];
        if (!context.reasoningItemId) {
          context.reasoningItemId = RuntimeItemId.make(
            `reasoning:${context.runId}:${context.sequence}`,
          );
          emitted.push({
            ...base,
            type: "item.started",
            itemId: context.reasoningItemId,
            payload: { itemType: "reasoning", status: "inProgress" },
          });
        }
        emitted.push({
          ...base,
          type: "content.delta",
          itemId: context.reasoningItemId,
          payload: { streamKind: "reasoning_text", delta },
        });
        return emitted;
      }
      if (updateType === "plan") {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        return [
          {
            ...base,
            type: "turn.plan.updated",
            payload: {
              plan: entries.flatMap((candidate) => {
                const planEntry = record(candidate);
                const step = textFromContent(planEntry?.content);
                return step ? [{ step, status: planStatus(planEntry?.status) }] : [];
              }),
            },
          },
        ];
      }
      if (updateType === "tool_call" || updateType === "tool_call_update") {
        const rawId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
        if (!rawId) return [];
        const existing = context.toolItems.get(rawId);
        const itemId = existing ?? RuntimeItemId.make(rawId);
        context.toolItems.set(rawId, itemId);
        const status = itemStatus(update.status) ?? "inProgress";
        const payload = {
          itemType: itemType(update.kind),
          status,
          ...(typeof update.title === "string" && update.title.trim()
            ? { title: update.title.trim() }
            : {}),
          data: update,
        } as const;
        if (!existing || updateType === "tool_call") {
          return [{ ...base, type: "item.started", itemId, payload }];
        }
        return [
          {
            ...base,
            type: status === "completed" || status === "failed" ? "item.completed" : "item.updated",
            itemId,
            payload,
          },
        ];
      }
      if (updateType === "usage_update") {
        const used = typeof update.used === "number" ? update.used : undefined;
        if (used === undefined || used < 0) return [];
        return [
          {
            ...base,
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens: Math.floor(used),
                ...(typeof update.size === "number" && update.size > 0
                  ? { maxTokens: Math.floor(update.size) }
                  : {}),
              },
            },
          },
        ];
      }
      return [];
    }

    if (method === "_posthog/run_started") {
      return [{ ...base, type: "session.state.changed", payload: { state: "running" } }];
    }
    if (method === "_posthog/progress") {
      const label =
        typeof params?.label === "string"
          ? params.label
          : typeof params?.title === "string"
            ? params.title
            : typeof params?.detail === "string"
              ? params.detail
              : undefined;
      if (!label) return [];
      return [
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make("posthog-cloud-setup"),
            description: label,
            summary: typeof params?.detail === "string" ? params.detail : undefined,
            status: params?.status === "completed" ? "completed" : "running",
          },
        },
      ];
    }
    if (method === "_posthog/permission_request") {
      const requestId = typeof params?.requestId === "string" ? params.requestId : undefined;
      if (!requestId) return [];
      const rawOptions = Array.isArray(params?.options) ? params.options : [];
      const optionsList = rawOptions.flatMap((candidate): ReadonlyArray<PermissionOption> => {
        const option = record(candidate);
        if (typeof option?.optionId !== "string") return [];
        return [
          {
            optionId: option.optionId,
            ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
            ...(typeof option.name === "string" ? { name: option.name } : {}),
          },
        ];
      });
      context.permissions.set(requestId, optionsList);
      const toolCall = record(params?.toolCall);
      const toolMetadata = record(toolCall?._meta);
      const questions =
        toolMetadata?.codeToolKind === "question" ? userInputQuestions(toolMetadata) : [];
      if (questions.length > 0) {
        context.userInputRequests.add(requestId);
        return [
          {
            ...base,
            type: "user-input.requested",
            requestId: RuntimeRequestId.make(requestId),
            payload: { questions },
          },
        ];
      }
      return [
        {
          ...base,
          type: "request.opened",
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            requestType: "dynamic_tool_call",
            ...(typeof toolCall?.title === "string" ? { detail: toolCall.title } : {}),
            options: optionsList.map((option) => ({
              decision:
                option.kind === "allow_always"
                  ? "acceptForSession"
                  : option.kind === "allow_once"
                    ? "accept"
                    : "decline",
              label: option.name ?? option.kind ?? option.optionId,
            })),
            args: params,
          },
        },
      ];
    }
    if (method === "_posthog/permission_resolved") {
      const requestId = typeof params?.requestId === "string" ? params.requestId : undefined;
      if (!requestId) return [];
      context.permissions.delete(requestId);
      if (context.locallyResolvedUserInputs.delete(requestId)) return [];
      if (context.userInputRequests.delete(requestId)) {
        return [
          {
            ...base,
            type: "user-input.resolved",
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: {} },
          },
        ];
      }
      return [
        {
          ...base,
          type: "request.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: "dynamic_tool_call", resolution: params },
        },
      ];
    }
    if (method === "_posthog/branch_created" || method === "_posthog/git_checkpoint") {
      const branch =
        typeof params?.branch === "string"
          ? params.branch
          : typeof params?.branchName === "string"
            ? params.branchName
            : undefined;
      return [
        {
          ...base,
          type: "thread.metadata.updated",
          payload: { metadata: { ...(params ?? {}), ...(branch ? { branch } : {}) } },
        },
      ];
    }
    if (method === "_posthog/error") {
      const message =
        typeof params?.message === "string" ? params.message : "The Cloud Task agent failed.";
      return [
        {
          ...base,
          type: "runtime.error",
          payload: { message, class: "provider_error", detail: params },
        },
      ];
    }
    if (method === "_posthog/turn_complete") {
      if (!context.activeTurnId) return [];
      const emitted: ProviderRuntimeEvent[] = [];
      if (context.assistantItemId) {
        emitted.push({
          ...base,
          type: "item.completed",
          itemId: context.assistantItemId,
          payload: { itemType: "assistant_message", status: "completed" },
        });
      }
      if (context.reasoningItemId) {
        emitted.push({
          ...base,
          type: "item.completed",
          itemId: context.reasoningItemId,
          payload: { itemType: "reasoning", status: "completed" },
        });
      }
      emitted.push({
        ...base,
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: typeof params?.stopReason === "string" ? params.stopReason : null,
          ...(params?.usage !== undefined ? { usage: params.usage } : {}),
        },
      });
      context.assistantItemId = undefined;
      context.assistantText = "";
      context.reasoningItemId = undefined;
      context.activeTurnId = undefined;
      syncSession(context, { status: "ready", activeTurnId: undefined, updatedAt: base.createdAt });
      return emitted;
    }
    return [];
  });

  const ingestEntry = (context: CloudSessionContext, entry: unknown) =>
    ingestLock.withPermits(1)(
      Effect.gen(function* () {
        const key = fingerprint(entry);
        if (context.seen.has(key)) return;
        context.seen.add(key);
        const mapped = yield* mapEntry(context, entry);
        yield* Effect.forEach(mapped, publish, { discard: true });
      }),
    );

  const completeRun = Effect.fn("PostHogCloudAdapter.completeRun")(function* (
    context: CloudSessionContext,
  ) {
    if (!context.taskId || !context.runId) return true;
    const run = yield* posthog
      .getCloudRun({ taskId: context.taskId, runId: context.runId })
      .pipe(Effect.mapError(adapterError("get-run")));
    if (!TERMINAL_STATUSES.has(run.status)) return false;
    const createdAt = yield* nowIso;
    const activeTurnId = context.activeTurnId;
    const state = run.status === "failed" ? "error" : "ready";
    syncSession(context, {
      status: state,
      activeTurnId: undefined,
      updatedAt: createdAt,
      ...(run.error_message ? { lastError: run.error_message } : {}),
    });
    const output = record(run.output);
    const runState = record(run.state);
    const repository =
      typeof runState?.repository === "string" ? runState.repository : context.repository;
    const prUrl = typeof output?.pr_url === "string" ? output.pr_url : undefined;
    if (run.branch || repository || prUrl) {
      yield* publish({
        ...(yield* eventBase(context, run, createdAt).pipe(Effect.orDie)),
        type: "thread.metadata.updated",
        payload: {
          metadata: {
            ...(run.branch ? { branch: run.branch } : {}),
            ...(repository ? { repository } : {}),
            ...(prUrl ? { prUrl } : {}),
          },
        },
      });
    }
    if (run.status === "failed") {
      yield* publish({
        ...(yield* eventBase(context, run, createdAt).pipe(Effect.orDie)),
        type: "runtime.error",
        payload: {
          message: run.error_message ?? "The Cloud Task failed.",
          class: "provider_error",
          detail: run,
        },
      });
    }
    if (activeTurnId) {
      const base = yield* eventBase(context, run, createdAt).pipe(Effect.orDie);
      yield* publish(
        run.status === "completed"
          ? {
              ...base,
              type: "turn.completed",
              turnId: activeTurnId,
              payload: { state: "completed", stopReason: null },
            }
          : {
              ...base,
              type: "turn.aborted",
              turnId: activeTurnId,
              payload: { reason: run.status === "cancelled" ? "run_cancelled" : "run_failed" },
            },
      );
    }
    return true;
  });

  const watchRun = Effect.fn("PostHogCloudAdapter.watchRun")(function* (
    context: CloudSessionContext,
    runId: PostHogCloudRunId,
    includeHistory: boolean,
  ) {
    if (!context.taskId || context.watcherRunId === runId) return;
    if (context.watcher) yield* Fiber.interrupt(context.watcher);
    context.watcherRunId = runId;
    const taskId = context.taskId;
    const buffered = yield* Ref.make<{ hydrating: boolean; entries: ReadonlyArray<unknown> }>({
      hydrating: includeHistory,
      entries: [],
    });

    const consume = Effect.gen(function* () {
      while (context.watcherRunId === runId) {
        const cursor = record(context.session.resumeCursor);
        const streamResult = yield* posthog
          .streamCloudRun({
            taskId,
            runId,
            ...(typeof cursor?.lastEventId === "string" ? { lastEventId: cursor.lastEventId } : {}),
            ...(!includeHistory && cursor?.lastEventId === undefined ? { startLatest: true } : {}),
          })
          .pipe(Effect.mapError(adapterError("stream-run")), Effect.result);
        if (streamResult._tag === "Failure") {
          yield* Effect.logWarning("PostHog Cloud Task stream could not open", {
            cause: streamResult.failure,
          });
          if (yield* completeRun(context).pipe(Effect.orElseSucceed(() => false))) return;
          yield* Effect.sleep("1 second");
          continue;
        }
        const stream = streamResult.success;
        yield* stream.pipe(
          Stream.runForEach((frame) => {
            if (frame.id) {
              syncSession(context, {
                resumeCursor: { schemaVersion: 1, runId, lastEventId: frame.id },
              });
            }
            if (frame.event === "keepalive") return Effect.void;
            if (frame.event === "stream-end") return Effect.void;
            return Ref.modify(buffered, (state) =>
              state.hydrating
                ? [Effect.void, { ...state, entries: [...state.entries, frame.data] }]
                : [ingestEntry(context, frame.data), state],
            ).pipe(Effect.flatten);
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("PostHog Cloud Task stream disconnected", { cause }),
          ),
        );
        if (yield* completeRun(context).pipe(Effect.orElseSucceed(() => false))) return;
        yield* Effect.sleep("1 second");
      }
    });

    context.watcher = yield* Effect.forkIn(consume, scope);

    if (includeHistory) {
      const logs = yield* posthog
        .readCloudRunLogs({ taskId, runId })
        .pipe(Effect.mapError(adapterError("read-run-logs")));
      yield* Effect.forEach(parseJsonLines(logs), (entry) => ingestEntry(context, entry), {
        discard: true,
      });
      const tail = yield* Ref.modify(buffered, (state) => [
        state.entries,
        { hydrating: false, entries: [] },
      ]);
      yield* Effect.forEach(tail, (entry) => ingestEntry(context, entry), { discard: true });
    }
  });

  const startSession = Effect.fn("PostHogCloudAdapter.startSession")(function* (
    input: ProviderSessionStartInput,
  ) {
    const decodedPayload = Schema.decodeUnknownOption(PostHogCloudRuntimePayload)(
      input.runtimePayload,
    );
    const payload = Option.getOrUndefined(decodedPayload);
    const persistedPayload = record(input.runtimePayload);
    const persistedActiveTurnId =
      typeof persistedPayload?.activeTurnId === "string"
        ? TurnId.make(persistedPayload.activeTurnId)
        : undefined;
    const decodedCursor = Schema.decodeUnknownOption(PostHogCloudResumeCursor)(input.resumeCursor);
    const cursor = Option.getOrUndefined(decodedCursor);
    const createdAt = yield* nowIso;
    const context: CloudSessionContext = {
      taskId: payload?.taskId,
      runId: cursor?.runId,
      repository: input.repository ?? payload?.repository,
      reportId: input.reportId,
      activeTurnId: persistedActiveTurnId,
      assistantItemId: undefined,
      assistantText: "",
      reasoningItemId: undefined,
      watcherRunId: undefined,
      watcher: undefined,
      session: {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: persistedActiveTurnId ? "running" : "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        ...(persistedActiveTurnId ? { activeTurnId: persistedActiveTurnId } : {}),
        ...(cursor ? { resumeCursor: cursor } : {}),
        ...(payload ? { runtimePayload: payload } : {}),
        createdAt,
        updatedAt: createdAt,
      },
      sequence: 0,
      seen: new Set(),
      toolItems: new Map(),
      permissions: new Map(),
      userInputRequests: new Set(),
      locallyResolvedUserInputs: new Set(),
    };
    syncSession(context);
    sessions.set(input.threadId, context);
    yield* publish({
      ...(yield* eventBase(context, input, createdAt).pipe(Effect.orDie)),
      type: "session.started",
      payload: { resume: cursor },
    });
    yield* publish({
      ...(yield* eventBase(context, input, createdAt).pipe(Effect.orDie)),
      type: "thread.started",
      payload: { providerThreadId: payload?.taskId },
    });
    if (context.taskId && context.runId) {
      yield* watchRun(context, context.runId, cursor?.lastEventId === undefined);
    }
    return context.session;
  });

  const uploadAttachments = Effect.fn("PostHogCloudAdapter.uploadAttachments")(function* (
    context: CloudSessionContext,
    attachments: NonNullable<ProviderSendTurnInput["resolvedAttachments"]>,
  ) {
    if (!context.taskId || !context.runId || attachments.length === 0) return [];
    const payloads = yield* Effect.forEach(attachments, (attachment) =>
      fileSystem.readFile(attachment.path).pipe(
        Effect.map((bytes) => ({
          name: attachment.name,
          contentType: attachment.mimeType,
          base64: Buffer.from(bytes).toString("base64"),
        })),
        Effect.mapError(adapterError("read-attachment")),
      ),
    );
    const manifest = yield* posthog
      .uploadCloudRunArtifacts({
        taskId: context.taskId,
        runId: context.runId,
        artifacts: payloads,
      })
      .pipe(Effect.mapError(adapterError("upload-attachments")));
    return manifest.slice(-attachments.length).map((artifact) => artifact.id);
  });

  const sendTurn = Effect.fn("PostHogCloudAdapter.sendTurn")(function* (
    input: ProviderSendTurnInput,
  ) {
    const context = yield* requireSession(input.threadId);
    const message = input.input?.trim();
    if (!message) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Cloud Task turns require a text prompt.",
      });
    }
    const attachments = input.resolvedAttachments ?? [];
    if ((input.attachments?.length ?? 0) !== attachments.length) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "One or more Cloud Task attachments could not be read.",
      });
    }
    const selected = input.modelSelection ? cloudModel(input.modelSelection.model) : undefined;
    if (!selected) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Select a model from the PostHog Cloud model catalogue.",
      });
    }
    const turnId = TurnId.make(yield* nextUuid);
    context.activeTurnId = turnId;
    context.assistantItemId = undefined;
    context.assistantText = "";
    context.reasoningItemId = undefined;
    const createdAt = yield* nowIso;
    syncSession(context, { status: "running", activeTurnId: turnId, updatedAt: createdAt });
    yield* publish({
      ...(yield* eventBase(context, input, createdAt).pipe(Effect.orDie)),
      type: "turn.started",
      turnId,
      payload: {
        model: selected.model,
        effort:
          getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ?? undefined,
      },
    });

    if (!context.taskId) {
      const task = yield* posthog
        .createCloudTask({
          title: message.slice(0, 120),
          description: attachments.length > 0 ? "" : message,
          ...(context.repository ? { repository: context.repository } : {}),
          ...(context.reportId ? { signalReportId: context.reportId } : {}),
        })
        .pipe(Effect.mapError(adapterError("create-task")));
      context.taskId = task.id;
    }

    let currentRun = context.runId
      ? yield* posthog
          .getCloudRun({ taskId: context.taskId, runId: context.runId })
          .pipe(Effect.mapError(adapterError("get-run")))
      : undefined;
    if (currentRun && !TERMINAL_STATUSES.has(currentRun.status) && attachments.length === 0) {
      yield* posthog
        .commandCloudRun({
          taskId: context.taskId,
          runId: currentRun.id,
          method: "user_message",
          params: { content: message, steer: false },
          id: yield* nextUuid,
        })
        .pipe(Effect.mapError(adapterError("send-message")));
    } else if (!currentRun || TERMINAL_STATUSES.has(currentRun.status)) {
      const task = yield* posthog
        .runCloudTask({
          taskId: context.taskId,
          message: attachments.length > 0 ? "" : message,
          ...(currentRun ? { resumeFromRunId: currentRun.id } : {}),
          runtimeAdapter: selected.runtimeAdapter,
          model: selected.model,
          ...(getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
            ? {
                reasoningEffort: getModelSelectionStringOptionValue(
                  input.modelSelection,
                  "reasoningEffort",
                )!,
              }
            : {}),
        })
        .pipe(Effect.mapError(adapterError("run-task")));
      currentRun = task.latest_run ?? undefined;
      if (!currentRun) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "run-task",
          detail: "PostHog started the Task without returning its TaskRun.",
        });
      }
      context.runId = currentRun.id;
      syncSession(context);
      yield* publish({
        ...(yield* eventBase(context, currentRun, createdAt).pipe(Effect.orDie)),
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make("posthog-cloud-setup"),
          description:
            currentRun.status === "queued" ? "Waiting in the queue…" : "Starting the sandbox…",
          status: "running",
        },
      });
      yield* watchRun(context, currentRun.id, false);
    }
    if (attachments.length > 0) {
      const artifactIds = yield* uploadAttachments(context, attachments);
      yield* posthog
        .commandCloudRun({
          taskId: context.taskId,
          runId: context.runId!,
          method: "user_message",
          params: { content: message, artifact_ids: artifactIds, steer: false },
          id: yield* nextUuid,
        })
        .pipe(Effect.mapError(adapterError("send-message")));
    }
    return { threadId: input.threadId, turnId, resumeCursor: resumeCursor(context) };
  });

  const interruptTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (!context.taskId || !context.runId) return;
      yield* posthog
        .commandCloudRun({
          taskId: context.taskId,
          runId: context.runId,
          method: "cancel",
          id: yield* nextUuid,
        })
        .pipe(Effect.mapError(adapterError("interrupt-turn")));
      const createdAt = yield* nowIso;
      const turnId = context.activeTurnId;
      context.activeTurnId = undefined;
      syncSession(context, { status: "ready", activeTurnId: undefined, updatedAt: createdAt });
      if (turnId) {
        yield* publish({
          ...(yield* eventBase(context, { method: "cancel" }, createdAt).pipe(Effect.orDie)),
          type: "turn.aborted",
          turnId,
          payload: { reason: "interrupted" },
        });
      }
    });

  const respondToRequest = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (!context.taskId || !context.runId) return;
      const optionsList = context.permissions.get(requestId) ?? [];
      const wanted = permissionDecisionKind(decision);
      const selected =
        optionsList.find((option) => option.kind === wanted) ??
        optionsList.find(
          (option) => wanted.startsWith("reject") && option.kind?.startsWith("reject"),
        );
      if (!selected) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: `The Cloud Task did not offer an option for '${decision}'.`,
        });
      }
      yield* posthog
        .commandCloudRun({
          taskId: context.taskId,
          runId: context.runId,
          method: "permission_response",
          params: { requestId, optionId: selected.optionId },
          id: yield* nextUuid,
        })
        .pipe(Effect.mapError(adapterError("permission-response")));
      context.permissions.delete(requestId);
    });

  const respondToUserInput = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (!context.taskId || !context.runId) return;
      const normalizedAnswers = normalizedUserInputAnswers(answers);
      const firstAnswer = Object.values(normalizedAnswers)[0];
      const offeredOptions = context.permissions.get(requestId) ?? [];
      const optionId =
        offeredOptions.find((option) => option.name === firstAnswer)?.optionId ??
        offeredOptions[0]?.optionId;
      if (!optionId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: `The Cloud Task did not offer an option for user input request '${requestId}'.`,
        });
      }
      yield* posthog
        .commandCloudRun({
          taskId: context.taskId,
          runId: context.runId,
          method: "permission_response",
          params: { requestId, optionId, answers: normalizedAnswers },
          id: yield* nextUuid,
        })
        .pipe(Effect.mapError(adapterError("user-input-response")));
      context.permissions.delete(requestId);
      context.userInputRequests.delete(requestId);
      context.locallyResolvedUserInputs.add(requestId);
      const createdAt = yield* nowIso;
      yield* publish({
        ...(yield* eventBase(context, { requestId, answers: normalizedAnswers }, createdAt).pipe(
          Effect.orDie,
        )),
        type: "user-input.resolved",
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers: normalizedAnswers },
      });
    });

  const disconnectSession = (context: CloudSessionContext) =>
    Effect.gen(function* () {
      if (context.watcher) yield* Fiber.interrupt(context.watcher);
      context.watcher = undefined;
      context.watcherRunId = undefined;
      const updatedAt = yield* nowIso;
      syncSession(context, { status: "closed", activeTurnId: undefined, updatedAt });
    });

  const stopSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (context.taskId && context.runId) {
        yield* posthog
          .cancelCloudRun({ taskId: context.taskId, runId: context.runId })
          .pipe(Effect.mapError(adapterError("stop-run")));
      }
      yield* disconnectSession(context);
    });

  const adapter: ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError
  > = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () => Effect.succeed(Array.from(sessions.values(), (context) => context.session)),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) =>
      requireSession(threadId).pipe(Effect.as({ threadId, turns: [] as const })),
    rollbackThread: (threadId) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: `Cloud Task thread '${threadId}' cannot be rolled back locally.`,
        }),
      ),
    stopAll: () =>
      Effect.forEach(Array.from(sessions.values()), disconnectSession, { discard: true }).pipe(
        Effect.ignore,
      ),
    streamEvents: Stream.fromPubSub(events),
  };

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      Array.from(sessions.values()),
      (context) => (context.watcher ? Fiber.interrupt(context.watcher) : Effect.void),
      { discard: true },
    ).pipe(Effect.andThen(PubSub.shutdown(events))),
  );

  return adapter;
});
