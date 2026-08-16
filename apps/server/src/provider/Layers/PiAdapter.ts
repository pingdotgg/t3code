import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { decodePiModelSlug } from "../pi/PiModel.ts";
import {
  makePiRpcClient,
  PiRpcCommandError,
  type PiRpcClient,
  type PiRpcError,
  type PiRpcSpawnOptions,
} from "../pi/PiRpcClient.ts";
import { PiThinkingLevel, type PiRpcEvent, type PiRpcSessionStats } from "../pi/PiRpcSchema.ts";
import {
  allocateFreshPiSessionFile,
  cleanupFreshPiSessionFile,
  piInstanceStateRoot,
  PiSessionCursor,
  piStateMatchesCursor,
  validatePiResumeSessionFile,
} from "../pi/PiSessionFile.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const isPiRpcCommandError = Schema.is(PiRpcCommandError);
const decodePiSessionCursor = Schema.decodeUnknownEffect(PiSessionCursor);
const decodePiThinkingLevel = Schema.decodeUnknownEffect(PiThinkingLevel);
const DETERMINISTIC_ARGS = ["--offline"] as const;

export type PiRpcClientFactory = (
  options: PiRpcSpawnOptions,
) => Effect.Effect<PiRpcClient, PiRpcError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>;

export interface PiAdapterOptions {
  readonly binaryPath: string;
  readonly args?: ReadonlyArray<string>;
  readonly providerInstanceId: ProviderInstanceId;
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly makeRpcClient?: PiRpcClientFactory;
  readonly onSessionPublished?: () => Effect.Effect<void>;
}

interface ActiveTurn {
  readonly id: TurnId;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  assistantItemId: RuntimeItemId;
  reasoningItemId: RuntimeItemId;
  assistantSegment: number;
  readonly toolItemIds: Map<string, RuntimeItemId>;
  readonly toolArgs: Map<string, Record<string, unknown>>;
  assistantText: string;
  assistantStarted: boolean;
  reasoningStarted: boolean;
  lastAssistantMessageIncomplete: boolean;
  compactionContinuationPending: boolean;
  interruptRequested: boolean;
  terminal: boolean;
}

type PiInteractiveExtensionMethod = "select" | "confirm" | "input" | "editor";

interface PendingExtensionInput {
  readonly extensionRequestId: string;
  readonly method: PiInteractiveExtensionMethod;
  readonly questionId: string;
}

interface PiAgentTask {
  readonly taskId: RuntimeTaskId;
  readonly toolUseId: string;
  title: string;
  role: string | undefined;
  model: string | undefined;
  effort: string | undefined;
}

interface PiWorkflowTask {
  readonly taskId: RuntimeTaskId;
  state: "running" | "done" | "error";
}

interface PiExtensionSubagentTask {
  readonly taskId: RuntimeTaskId;
  readonly description: string;
  readonly title: string;
  readonly role: string;
  readonly model: string | undefined;
  readonly toolUseId: string;
  state: "running" | "completed" | "failed" | "stopped";
}

type PiThreadTokenUsage = Extract<
  ProviderRuntimeEvent,
  { type: "thread.token-usage.updated" }
>["payload"]["usage"];

interface SessionContext {
  session: ProviderSession;
  readonly cursor: PiSessionCursor;
  readonly lease: SessionFileLease;
  readonly mcpConfigFile: string | undefined;
  readonly client: PiRpcClient;
  readonly scope: Scope.Closeable;
  eventFiber: Fiber.Fiber<void>;
  activeTurn: ActiveTurn | undefined;
  steeringPromptsInFlight: number;
  steeringGeneration: number;
  deferredSettlement: PiRpcEvent | undefined;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingExtensionInput>;
  readonly resolvingUserInputs: Set<ApprovalRequestId>;
  readonly agentTasksByToolCall: Map<string, PiAgentTask>;
  readonly agentTasksById: Map<string, PiAgentTask>;
  readonly workflowTasks: Map<string, PiWorkflowTask>;
  readonly extensionSubagentTasks: Map<string, PiExtensionSubagentTask>;
  lastEventCreatedAt: string | undefined;
  lastTokenUsage: PiThreadTokenUsage | undefined;
  thinkingLevel: PiThinkingLevel | undefined;
  closing: boolean;
  stopped: boolean;
}

interface SessionFileLease {
  startupOwned: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const trimmedString = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;

const piToolText = (value: unknown): string | undefined => {
  const record = isRecord(value) ? value : undefined;
  if (!record) return trimmedString(value);
  if (!Array.isArray(record.content)) return undefined;
  const text = record.content
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
  return text || undefined;
};

const piToolPath = (args: Record<string, unknown>): string | undefined =>
  trimmedString(args.path) ?? trimmedString(args.file_path);

const JsonUnknown = Schema.fromJsonString(Schema.Unknown);
const decodeJsonUnknown = Schema.decodeUnknownEffect(JsonUnknown);
const decodeJsonObject = (content: string) =>
  decodeJsonUnknown(content).pipe(
    Effect.map((parsed) => (isRecord(parsed) ? parsed : {})),
    Effect.orElseSucceed((): Record<string, unknown> => ({})),
  );
const encodeJson = Schema.encodeUnknownEffect(JsonUnknown);

const allocateT3McpConfig = Effect.fn("PiAdapter.allocateT3McpConfig")(function* (input: {
  readonly stateRoot: string;
  readonly threadId: ThreadId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = trimmedString(input.environment.HOME);
  const agentDir =
    trimmedString(input.environment.PI_CODING_AGENT_DIR) ??
    (home ? path.join(home, ".pi", "agent") : undefined);
  const existing = agentDir
    ? yield* fs.readFileString(path.join(agentDir, "mcp.json")).pipe(
        Effect.flatMap(decodeJsonObject),
        Effect.orElseSucceed((): Record<string, unknown> => ({})),
      )
    : ({} as Record<string, unknown>);
  const existingServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  const config = {
    ...existing,
    mcpServers: {
      ...existingServers,
      "t3-code": {
        url: input.endpoint,
        headers: { Authorization: input.authorizationHeader },
        lifecycle: "keep-alive",
      },
    },
  };
  const directory = path.resolve(input.stateRoot, "..", "mcp");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
  const configFile = path.join(directory, `${encodeURIComponent(input.threadId)}.json`);
  yield* fs.writeFileString(configFile, yield* encodeJson(config), { mode: 0o600 });
  yield* fs.chmod(configFile, 0o600);
  return configFile;
});
/**
 * Pi's agent-backed extensions share `details.agent` and `details.task`.
 * Classifying that result metadata keeps new agents working without a T3 tool-name allowlist.
 */
const piSubagentPresentation = (
  args: Record<string, unknown>,
  output: Record<string, unknown> | undefined,
) => {
  const outputDetails = isRecord(output?.details) ? output.details : undefined;
  const agent =
    trimmedString(outputDetails?.agent) ??
    trimmedString(outputDetails?.displayName) ??
    trimmedString(outputDetails?.subagentType) ??
    trimmedString(args.subagent_type);
  if (!agent) return undefined;
  const label = agent.replace(/[_-]+/gu, " ");
  const detail =
    trimmedString(outputDetails?.task) ??
    trimmedString(args.description) ??
    trimmedString(args.task) ??
    trimmedString(args.query) ??
    trimmedString(args.objective) ??
    trimmedString(args.goal) ??
    trimmedString(args.prompt) ??
    trimmedString(args.diff_description) ??
    trimmedString(args.name) ??
    trimmedString(args.scriptPath);

  return {
    title: `${label.charAt(0).toUpperCase()}${label.slice(1)} agent`,
    detail,
  };
};

const piToolPresentation = (event: Record<string, unknown>) => {
  const toolName = string(event.toolName) ?? "tool";
  const normalizedName = toolName.toLowerCase();
  const args = isRecord(event.args) ? event.args : {};
  const output = event.result ?? event.partialResult;
  const outputRecord = isRecord(output) ? output : undefined;
  const outputDetails = isRecord(outputRecord?.details) ? outputRecord.details : undefined;
  const subagent =
    piSubagentPresentation(args, outputRecord) ??
    (normalizedName === "subagent"
      ? { title: "Subagent", detail: trimmedString(args.task) }
      : undefined);
  const mcpTool =
    normalizedName === "mcp"
      ? trimmedString(args.tool)
      : trimmedString(outputDetails?.server) && trimmedString(outputDetails?.tool)
        ? trimmedString(outputDetails?.tool)
        : undefined;
  const mcpServer = trimmedString(args.server) ?? trimmedString(outputDetails?.server);
  const outputText = piToolText(output);
  const path = piToolPath(args);
  const toolCallId = string(event.toolCallId) ?? string(event.toolCallID);
  const itemType = subagent
    ? ("collab_agent_tool_call" as const)
    : mcpTool
      ? ("mcp_tool_call" as const)
      : normalizedName === "bash"
        ? ("command_execution" as const)
        : normalizedName === "write" || normalizedName === "edit"
          ? ("file_change" as const)
          : ("dynamic_tool_call" as const);
  const title = subagent
    ? subagent.title
    : mcpTool
      ? `MCP: ${mcpTool}`
      : normalizedName === "bash"
        ? "Ran command"
        : normalizedName === "read"
          ? "Read file"
          : normalizedName === "write"
            ? "Wrote file"
            : normalizedName === "edit"
              ? "Edited file"
              : normalizedName === "grep"
                ? "Searched files"
                : normalizedName === "find"
                  ? "Found files"
                  : normalizedName === "ls"
                    ? "Listed directory"
                    : toolName;
  const invocationDetail = subagent
    ? subagent.detail
    : mcpTool
      ? mcpServer
      : normalizedName === "grep"
        ? `${trimmedString(args.pattern) ? `/${trimmedString(args.pattern)}/` : "pattern"} in ${path ?? "."}`
        : normalizedName === "find"
          ? `${trimmedString(args.pattern) ?? "files"} in ${path ?? "."}`
          : normalizedName === "ls"
            ? (path ?? ".")
            : path;
  const detail = event.isError === true ? outputText?.split(/\r?\n/u)[0] : invocationDetail;
  const command = normalizedName === "bash" ? trimmedString(args.command) : undefined;
  const changes =
    (normalizedName === "write" || normalizedName === "edit") && path ? [{ path }] : undefined;

  return {
    itemType,
    title,
    ...(detail ? { detail } : {}),
    data: {
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      kind:
        normalizedName === "bash"
          ? "execute"
          : normalizedName === "read"
            ? "read"
            : normalizedName === "write" || normalizedName === "edit"
              ? "edit"
              : mcpTool
                ? "mcp"
                : "other",
      ...(command ? { command } : {}),
      rawInput: args,
      ...(outputRecord
        ? {
            rawOutput: {
              ...(outputText ? { content: outputText } : {}),
              ...(isRecord(outputRecord.details) ? outputRecord.details : {}),
            },
          }
        : {}),
      item: {
        input: args,
        ...(changes ? { changes } : {}),
      },
    },
  };
};

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (options: PiAdapterOptions) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const provideFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const root = yield* piInstanceStateRoot({
    stateDir: options.stateDir,
    instanceId: options.providerInstanceId,
  }).pipe(Effect.mapError((cause) => validation("startSession", "Invalid Pi state root.", cause)));
  const sessions = new Map<ThreadId, SessionContext>();
  const sessionFileLeases = new Map<string, SessionFileLease>();
  const threadLocks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const getThreadLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadLocks, (locks) => {
      const existing = locks.get(threadId);
      if (existing) return Effect.succeed([existing, locks] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(locks).set(threadId, lock)] as const),
      );
    });
  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) => request("crypto/randomUUIDv4", cause)),
  );

  function validation(operation: string, issue: string, cause?: unknown) {
    return new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue, cause });
  }
  function request(method: string, cause: unknown) {
    return new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail:
        isRecord(cause) && typeof cause.detail === "string"
          ? cause.detail
          : `Pi ${method} request failed.`,
      cause,
    });
  }
  function requestMessage(method: string, detail: string) {
    return new ProviderAdapterRequestError({ provider: PROVIDER, method, detail });
  }
  const offer = (event: ProviderRuntimeEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
  const base = Effect.fn("PiAdapter.eventBase")(function* (ctx: SessionContext, turn?: ActiveTurn) {
    const wallTime = yield* DateTime.now;
    const previousTime = ctx.lastEventCreatedAt
      ? DateTime.makeUnsafe(ctx.lastEventCreatedAt)
      : undefined;
    const createdAt = DateTime.formatIso(
      previousTime && DateTime.toEpochMillis(previousTime) >= DateTime.toEpochMillis(wallTime)
        ? DateTime.add(previousTime, { milliseconds: 1 })
        : wallTime,
    );
    ctx.lastEventCreatedAt = createdAt;
    return {
      eventId: EventId.make(yield* uuid),
      createdAt,
      provider: PROVIDER,
      providerInstanceId: options.providerInstanceId,
      threadId: ctx.session.threadId,
      ...(turn ? { turnId: turn.id } : {}),
    } as const;
  });
  const raw = (event: PiRpcEvent) => ({
    source: "pi.rpc.notification" as const,
    method: isRecord(event) ? string(event.type) : undefined,
    payload: event,
  });

  const resolveExtensionInput = Effect.fn("PiAdapter.resolveExtensionInput")(function* (
    ctx: SessionContext,
    requestId: ApprovalRequestId,
    pending: PendingExtensionInput,
    answers: ProviderUserInputAnswers,
    response:
      | { readonly value: string }
      | { readonly confirmed: boolean }
      | { readonly cancelled: true },
  ) {
    if (ctx.pendingUserInputs.get(requestId) !== pending || ctx.resolvingUserInputs.has(requestId))
      return false;
    ctx.resolvingUserInputs.add(requestId);
    yield* ctx.client.respondToExtensionUi({ id: pending.extensionRequestId, ...response }).pipe(
      Effect.mapError((cause) => request("extension_ui_response", cause)),
      Effect.ensuring(Effect.sync(() => ctx.resolvingUserInputs.delete(requestId))),
    );
    if (ctx.pendingUserInputs.get(requestId) !== pending) return false;
    ctx.pendingUserInputs.delete(requestId);
    yield* offer({
      type: "user-input.resolved",
      ...(yield* base(ctx, ctx.activeTurn)),
      requestId: RuntimeRequestId.make(requestId),
      payload: { answers },
      raw: {
        source: "pi.rpc.notification",
        method: "extension_ui_response",
        payload: { id: pending.extensionRequestId, ...response },
      },
    });
    return true;
  });

  const extensionQuestion = (
    requestId: ApprovalRequestId,
    event: Record<string, unknown>,
    method: PiInteractiveExtensionMethod,
  ): UserInputQuestion => {
    const title = trimmedString(event.title) ?? "Pi extension";
    const question =
      method === "confirm"
        ? (trimmedString(event.message) ?? title)
        : method === "input"
          ? (trimmedString(event.placeholder) ?? title)
          : title;
    const options =
      method === "confirm"
        ? [
            { label: "Yes", description: "Yes" },
            { label: "No", description: "No" },
          ]
        : method === "select" && Array.isArray(event.options)
          ? event.options.flatMap((option) => {
              const label = trimmedString(option);
              return label ? [{ label, description: label }] : [];
            })
          : [];
    return {
      id: `${requestId}:answer`,
      header: title,
      question,
      options,
      multiSelect: false,
    };
  };

  const handleExtensionUiRequest = Effect.fn("PiAdapter.handleExtensionUiRequest")(function* (
    ctx: SessionContext,
    event: Record<string, unknown>,
  ) {
    const method = string(event.method);
    if (method === "notify") {
      const message = trimmedString(event.message);
      const notifyType = trimmedString(event.notifyType) ?? "info";
      if (message && (notifyType === "warning" || notifyType === "error")) {
        yield* offer({
          type: "runtime.warning",
          ...(yield* base(ctx, ctx.activeTurn)),
          payload: { message },
          raw: raw(event),
        });
      }
      return;
    }
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {
      return;
    }
    const extensionRequestId = string(event.id);
    if (!extensionRequestId) return;
    const requestId = ApprovalRequestId.make(`pi-extension:${extensionRequestId}`);
    const question = extensionQuestion(requestId, event, method);
    const pending = {
      extensionRequestId,
      method,
      questionId: question.id,
    } satisfies PendingExtensionInput;
    ctx.pendingUserInputs.set(requestId, pending);
    yield* offer({
      type: "user-input.requested",
      ...(yield* base(ctx, ctx.activeTurn)),
      requestId: RuntimeRequestId.make(requestId),
      payload: { questions: [question] },
      raw: raw(event),
    });
    const timeoutMs =
      typeof event.timeout === "number" && Number.isFinite(event.timeout) && event.timeout > 0
        ? event.timeout
        : undefined;
    if (timeoutMs !== undefined) {
      yield* Effect.sleep(Duration.millis(timeoutMs)).pipe(
        Effect.andThen(resolveExtensionInput(ctx, requestId, pending, {}, { cancelled: true })),
        Effect.catch(() => Effect.void),
        Effect.forkIn(ctx.scope),
      );
    }
  });

  const beginTurn = Effect.fn("PiAdapter.beginTurn")(function* (
    ctx: SessionContext,
    payload: { readonly model?: string; readonly effort?: string } = {},
  ) {
    const turnId = TurnId.make(yield* uuid);
    const turn: ActiveTurn = {
      id: turnId,
      model: payload.model,
      effort: payload.effort,
      assistantItemId: RuntimeItemId.make(`pi-assistant:${turnId}`),
      reasoningItemId: RuntimeItemId.make(`pi-reasoning:${turnId}`),
      assistantSegment: 1,
      toolItemIds: new Map(),
      toolArgs: new Map(),
      assistantText: "",
      assistantStarted: false,
      reasoningStarted: false,
      lastAssistantMessageIncomplete: false,
      compactionContinuationPending: false,
      interruptRequested: false,
      terminal: false,
    };
    ctx.activeTurn = turn;
    ctx.session = {
      ...ctx.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: yield* now,
    };
    yield* offer({
      type: "turn.started",
      ...(yield* base(ctx, turn)),
      payload,
    });
    return turn;
  });

  const publishTerminal = Effect.fn("PiAdapter.publishTerminal")(function* (
    ctx: SessionContext,
    expected: ActiveTurn,
    terminalEvents: ReadonlyArray<ProviderRuntimeEvent>,
    status: "ready" | "error",
    errorMessage?: string,
  ) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (ctx.activeTurn !== expected || expected.terminal) return false;
        expected.terminal = true;
        ctx.activeTurn = undefined;
        yield* Effect.forEach(terminalEvents, offer, { discard: true });
        const { activeTurnId: _, ...session } = ctx.session;
        ctx.session = {
          ...session,
          status,
          ...(status === "ready" ? { resumeCursor: ctx.cursor } : {}),
          ...(errorMessage ? { lastError: errorMessage } : {}),
          updatedAt: yield* now,
        };
        return true;
      }),
    );
  });

  const close = Effect.fn("PiAdapter.close")(function* (ctx: SessionContext) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (ctx.stopped || ctx.closing) return;
        ctx.closing = true;
        yield* Effect.forEach(
          [...ctx.pendingUserInputs],
          ([requestId, pending]) =>
            resolveExtensionInput(ctx, requestId, pending, {}, { cancelled: true }).pipe(
              Effect.ignore,
            ),
          { discard: true },
        );
        const turn = ctx.activeTurn;
        if (turn && !turn.terminal) {
          const completedEvent = {
            type: "turn.completed",
            ...(yield* base(ctx, turn)),
            payload: { state: "interrupted", stopReason: "abort" },
          } as const;
          yield* publishTerminal(ctx, turn, [completedEvent], "ready");
        }
        const { activeTurnId: _, ...session } = ctx.session;
        ctx.session = { ...session, status: "closed", updatedAt: yield* now };
        yield* ctx.client.close().pipe(Effect.ignore);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        if (ctx.mcpConfigFile)
          yield* provideFiles(fs.remove(ctx.mcpConfigFile, { force: true })).pipe(Effect.ignore);
        if (sessions.get(ctx.session.threadId) === ctx) {
          sessions.delete(ctx.session.threadId);
        }
        if (!ctx.lease.startupOwned && sessionFileLeases.get(ctx.cursor.sessionFile) === ctx.lease)
          sessionFileLeases.delete(ctx.cursor.sessionFile);
        ctx.stopped = true;
      }),
    );
  });

  const completeAssistantSegment = Effect.fn("PiAdapter.completeAssistantSegment")(function* (
    ctx: SessionContext,
    turn: ActiveTurn,
    native: PiRpcEvent,
  ) {
    if (turn.assistantStarted) {
      yield* offer({
        type: "item.completed",
        ...(yield* base(ctx, turn)),
        itemId: turn.assistantItemId,
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
        },
        raw: raw(native),
      });
    }
    if (turn.reasoningStarted) {
      yield* offer({
        type: "item.completed",
        ...(yield* base(ctx, turn)),
        itemId: turn.reasoningItemId,
        payload: {
          itemType: "reasoning",
          status: "completed",
          title: "Reasoning",
        },
        raw: raw(native),
      });
    }
    turn.assistantStarted = false;
    turn.reasoningStarted = false;
    turn.assistantSegment += 1;
    turn.assistantItemId = RuntimeItemId.make(`pi-assistant:${turn.id}:${turn.assistantSegment}`);
    turn.reasoningItemId = RuntimeItemId.make(`pi-reasoning:${turn.id}:${turn.assistantSegment}`);
  });

  const failActive = Effect.fn("PiAdapter.failActive")(function* (
    ctx: SessionContext,
    message: string,
    event?: PiRpcEvent,
    fatal = true,
  ) {
    const turn = ctx.activeTurn;
    if (!turn || turn.terminal) return;
    const errorEvent = {
      type: "runtime.error",
      ...(yield* base(ctx, turn)),
      payload: { message, class: "transport_error", ...(event ? { detail: event } : {}) },
      ...(event ? { raw: raw(event) } : {}),
    } as const;
    const completedEvent = {
      type: "turn.completed",
      ...(yield* base(ctx, turn)),
      payload: { state: "failed", errorMessage: message },
    } as const;
    yield* publishTerminal(
      ctx,
      turn,
      [errorEvent, completedEvent],
      fatal ? "error" : "ready",
      fatal ? message : undefined,
    );
  });

  const toolEventKey = (event: Record<string, unknown>) =>
    string(event.toolCallId) ?? string(event.toolCallID) ?? string(event.toolName) ?? "tool";

  const itemForTool = (turn: ActiveTurn, event: Record<string, unknown>) => {
    const key = toolEventKey(event);
    const existing = turn.toolItemIds.get(key);
    if (existing) return existing;
    const id = RuntimeItemId.make(`pi-tool:${turn.id}:${key}`);
    turn.toolItemIds.set(key, id);
    return id;
  };

  const agentTaskLinkage = (task: PiAgentTask) => ({
    taskType: "subagent",
    title: task.title,
    ...(task.role ? { role: task.role } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.effort ? { effort: task.effort } : {}),
    toolUseId: task.toolUseId,
  });

  const compactTokenCount = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    const match = trimmedString(value)?.match(/(\d+(?:\.\d+)?)\s*([km])?\s+tokens?\b/iu);
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return undefined;
    const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2] ? 1_000 : 1;
    return Math.round(amount * multiplier);
  };

  const agentTextUsage = (details: Record<string, unknown> | undefined, text?: string) => {
    const totalTokens = compactTokenCount(details?.tokens) ?? compactTokenCount(text);
    if (totalTokens === undefined) return undefined;
    const reportedToolUses = details?.toolUses;
    const textToolUses = text?.match(/\bTool uses:\s*(\d+)/iu)?.[1];
    const toolUses =
      typeof reportedToolUses === "number" && Number.isFinite(reportedToolUses)
        ? Math.max(0, Math.floor(reportedToolUses))
        : textToolUses
          ? Number(textToolUses)
          : undefined;
    const reportedDuration = details?.durationMs;
    const durationMs =
      typeof reportedDuration === "number" && Number.isFinite(reportedDuration)
        ? Math.max(0, Math.floor(reportedDuration))
        : undefined;
    return {
      totalTokens,
      ...(toolUses !== undefined ? { toolUses } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  };

  const completeAgentTask = Effect.fn("PiAdapter.completeAgentTask")(function* (
    ctx: SessionContext,
    turn: ActiveTurn,
    task: PiAgentTask,
    status: "completed" | "failed" | "stopped",
    summary: string | undefined,
    native: PiRpcEvent,
    typedUsage?: {
      readonly totalTokens: number;
      readonly toolUses?: number;
      readonly durationMs?: number;
    },
  ) {
    yield* offer({
      type: "task.completed",
      ...(yield* base(ctx, turn)),
      payload: {
        taskId: task.taskId,
        status,
        ...(summary ? { summary } : {}),
        ...(typedUsage ? { typedUsage } : {}),
        ...agentTaskLinkage(task),
      },
      raw: raw(native),
    });
    for (const [id, candidate] of ctx.agentTasksById) {
      if (candidate === task) ctx.agentTasksById.delete(id);
    }
    ctx.agentTasksByToolCall.delete(task.toolUseId);
  });

  const handleSubagentToolEvent = Effect.fn("PiAdapter.handleSubagentToolEvent")(function* (
    ctx: SessionContext,
    turn: ActiveTurn,
    event: Record<string, unknown>,
    native: PiRpcEvent,
  ) {
    const type = string(event.type);
    const toolName = string(event.toolName)?.toLowerCase();
    const toolUseId = string(event.toolCallId) ?? string(event.toolCallID);
    const args = isRecord(event.args) ? event.args : {};
    const output = event.result ?? event.partialResult;
    const outputRecord = isRecord(output) ? output : undefined;
    const details = isRecord(outputRecord?.details) ? outputRecord.details : undefined;

    if (
      toolName === "agent" &&
      type === "tool_execution_start" &&
      toolUseId &&
      trimmedString(args.subagent_type) &&
      !trimmedString(args.schedule)
    ) {
      const title = trimmedString(args.description) ?? "Subagent";
      const task: PiAgentTask = {
        taskId: RuntimeTaskId.make(`pi-subagent:${toolUseId}`),
        toolUseId,
        title,
        role: trimmedString(args.subagent_type) ?? "unknown",
        model: trimmedString(args.model),
        effort: trimmedString(args.thinking),
      };
      ctx.agentTasksByToolCall.set(toolUseId, task);
      yield* offer({
        type: "task.started",
        ...(yield* base(ctx, turn)),
        payload: { taskId: task.taskId, description: title, ...agentTaskLinkage(task) },
        raw: raw(native),
      });
      return;
    }

    if (
      toolName === "agent" &&
      (type === "tool_execution_update" || type === "tool_execution_end") &&
      toolUseId
    ) {
      const task = ctx.agentTasksByToolCall.get(toolUseId);
      if (!task) return;
      task.title = trimmedString(details?.description) ?? task.title;
      task.role = trimmedString(details?.subagentType) ?? task.role;
      task.model = trimmedString(details?.modelName) ?? task.model;
      const id = trimmedString(details?.agentId);
      if (id) ctx.agentTasksById.set(id, task);
      const status = trimmedString(details?.status);
      const summary =
        trimmedString(details?.activity) ??
        (status === "background" || status === "queued"
          ? undefined
          : piToolText(output)?.slice(0, 2_000));
      const typedUsage = agentTextUsage(details, summary);
      if (type === "tool_execution_update") {
        yield* offer({
          type: "task.progress",
          ...(yield* base(ctx, turn)),
          payload: {
            taskId: task.taskId,
            description: task.title,
            status: "running",
            ...(summary ? { summary } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...agentTaskLinkage(task),
          },
          raw: raw(native),
        });
      } else if (event.isError === true || status === "error") {
        yield* completeAgentTask(ctx, turn, task, "failed", summary, native, typedUsage);
      } else if (status === "stopped" || status === "aborted") {
        yield* completeAgentTask(ctx, turn, task, "stopped", summary, native, typedUsage);
      } else if (status === "completed" || status === "steered") {
        yield* completeAgentTask(ctx, turn, task, "completed", summary, native, typedUsage);
      } else if (type === "tool_execution_end" && (!details || !status)) {
        yield* completeAgentTask(
          ctx,
          turn,
          task,
          "failed",
          piToolText(output)?.slice(0, 2_000) ?? "Agent did not start.",
          native,
        );
      } else {
        yield* offer({
          type: "task.progress",
          ...(yield* base(ctx, turn)),
          payload: {
            taskId: task.taskId,
            description: task.title,
            status: "running",
            ...(summary ? { summary } : {}),
            ...(typedUsage ? { typedUsage } : {}),
            ...agentTaskLinkage(task),
          },
          raw: raw(native),
        });
      }
      return;
    }

    if (toolName === "get_subagent_result" && type === "tool_execution_end") {
      const id = trimmedString(args.agent_id);
      const task = id ? ctx.agentTasksById.get(id) : undefined;
      if (!task) return;
      const outputText = piToolText(output)?.slice(0, 2_000);
      const status = outputText?.match(/\bStatus:\s*([a-z]+)/iu)?.[1]?.toLowerCase();
      const typedUsage = agentTextUsage(undefined, outputText);
      const summary = outputText?.match(/\r?\n\r?\n([\s\S]+)$/u)?.[1]?.trim() ?? outputText;
      if (event.isError === true || status === "error") {
        yield* completeAgentTask(ctx, turn, task, "failed", summary, native, typedUsage);
      } else if (status === "stopped" || status === "aborted") {
        yield* completeAgentTask(ctx, turn, task, "stopped", summary, native, typedUsage);
      } else if (status === "completed" || status === "steered") {
        yield* completeAgentTask(ctx, turn, task, "completed", summary, native, typedUsage);
      }
      return;
    }

    if (toolName === "subagent_spawn" && type === "tool_execution_start" && toolUseId) {
      const title = trimmedString(args.name) ?? "Subagent";
      const task: PiAgentTask = {
        taskId: RuntimeTaskId.make(`pi-subagent:${toolUseId}`),
        toolUseId,
        title,
        role: trimmedString(args.harness),
        model: trimmedString(args.model),
        effort: trimmedString(args.reasoning_effort),
      };
      ctx.agentTasksByToolCall.set(toolUseId, task);
      yield* offer({
        type: "task.started",
        ...(yield* base(ctx, turn)),
        payload: {
          taskId: task.taskId,
          description: title,
          ...agentTaskLinkage(task),
        },
        raw: raw(native),
      });
      return;
    }

    if (toolName === "subagent_spawn" && type === "tool_execution_end" && toolUseId) {
      const task = ctx.agentTasksByToolCall.get(toolUseId);
      if (!task) return;
      task.title = trimmedString(details?.title) ?? task.title;
      task.role = trimmedString(details?.harness) ?? task.role;
      task.model = trimmedString(details?.model) ?? task.model;
      const id = trimmedString(details?.id);
      if (id) ctx.agentTasksById.set(id, task);
      const summary = piToolText(output)?.slice(0, 2_000);
      if (event.isError === true) {
        yield* completeAgentTask(ctx, turn, task, "failed", summary, native);
      } else {
        yield* offer({
          type: "task.progress",
          ...(yield* base(ctx, turn)),
          payload: {
            taskId: task.taskId,
            description: task.title,
            status: "running",
            ...(summary ? { summary } : {}),
            ...agentTaskLinkage(task),
          },
          raw: raw(native),
        });
      }
      return;
    }

    if (type !== "tool_execution_end" || !details) return;
    const rawResults = Array.isArray(details.results)
      ? details.results
      : details.id
        ? [details]
        : [];
    for (const rawResult of rawResults) {
      if (!isRecord(rawResult)) continue;
      const id = trimmedString(rawResult.id);
      const status = trimmedString(rawResult.status);
      if (!id || (status !== "done" && status !== "error")) continue;
      const task = ctx.agentTasksById.get(id);
      if (!task) continue;
      task.title = trimmedString(rawResult.title) ?? task.title;
      yield* completeAgentTask(
        ctx,
        turn,
        task,
        status === "error" ? "failed" : "completed",
        piToolText(output)?.slice(0, 2_000),
        native,
      );
    }
  });

  const workflowDetails = (event: Record<string, unknown>) => {
    const output = event.result ?? event.partialResult;
    const outputRecord = isRecord(output) ? output : undefined;
    return isRecord(outputRecord?.details) ? outputRecord.details : undefined;
  };

  const finiteNonNegative = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

  const normalizeTokenUsage = (stats: PiRpcSessionStats): PiThreadTokenUsage | undefined => {
    const usedTokens = stats.contextUsage?.tokens;
    const maxTokens = stats.contextUsage?.contextWindow;
    if (typeof usedTokens !== "number" || !Number.isFinite(usedTokens) || usedTokens < 0) {
      return undefined;
    }
    return {
      usedTokens: Math.floor(usedTokens),
      totalProcessedTokens: finiteNonNegative(stats.tokens.total),
      ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
        ? { maxTokens: Math.floor(maxTokens) }
        : {}),
      inputTokens: finiteNonNegative(stats.tokens.input),
      cachedInputTokens: finiteNonNegative(stats.tokens.cacheRead),
      outputTokens: finiteNonNegative(stats.tokens.output),
      compactsAutomatically: true,
    };
  };

  const tokenUsageMatches = (left: PiThreadTokenUsage, right: PiThreadTokenUsage) =>
    left.usedTokens === right.usedTokens &&
    left.totalProcessedTokens === right.totalProcessedTokens &&
    left.maxTokens === right.maxTokens &&
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.compactsAutomatically === right.compactsAutomatically;

  const readTokenUsageEvent = Effect.fn("PiAdapter.readTokenUsageEvent")(function* (
    ctx: SessionContext,
    turn: ActiveTurn,
    native: PiRpcEvent,
  ) {
    const stats = yield* ctx.client.getSessionStats().pipe(Effect.exit);
    if (Exit.isFailure(stats) || ctx.activeTurn !== turn || turn.terminal) return undefined;
    const usage = normalizeTokenUsage(stats.value);
    if (!usage || (ctx.lastTokenUsage && tokenUsageMatches(ctx.lastTokenUsage, usage))) {
      return undefined;
    }
    ctx.lastTokenUsage = usage;
    return {
      type: "thread.token-usage.updated",
      ...(yield* base(ctx, turn)),
      payload: { usage },
      raw: raw(native),
    } satisfies ProviderRuntimeEvent;
  });

  const refreshTokenUsage = Effect.fn("PiAdapter.refreshTokenUsage")(function* (
    ctx: SessionContext,
    turn: ActiveTurn,
    native: PiRpcEvent,
  ) {
    const event = yield* readTokenUsageEvent(ctx, turn, native);
    if (event) yield* offer(event);
  });

  const handleExtensionSubagentToolEvent = Effect.fn("PiAdapter.handleExtensionSubagentToolEvent")(
    function* (
      ctx: SessionContext,
      turn: ActiveTurn,
      event: Record<string, unknown>,
      native: PiRpcEvent,
    ) {
      if (string(event.toolName)?.toLowerCase() !== "subagent") return;
      const type = string(event.type);
      if (type !== "tool_execution_update" && type !== "tool_execution_end") return;
      const toolUseId = string(event.toolCallId) ?? string(event.toolCallID);
      const details = workflowDetails(event);
      if (!toolUseId) return;
      if (!details || !Array.isArray(details.results)) {
        if (type !== "tool_execution_end") return;
        const summary = piToolText(event.result ?? event.partialResult) ?? "Subagent stopped";
        for (const [key, task] of ctx.extensionSubagentTasks) {
          if (!key.startsWith(`${toolUseId}:`) || task.state !== "running") continue;
          task.state = "stopped";
          yield* offer({
            type: "task.completed",
            ...(yield* base(ctx, turn)),
            payload: {
              taskId: task.taskId,
              status: "stopped",
              summary,
              taskType: "subagent",
              title: task.title,
              role: task.role,
              ...(task.model ? { model: task.model } : {}),
              toolUseId: task.toolUseId,
            },
            raw: raw(native),
          });
        }
        return;
      }

      for (const [index, rawResult] of details.results.entries()) {
        if (!isRecord(rawResult)) continue;
        const agent = trimmedString(rawResult.agent) ?? `Agent ${index + 1}`;
        const description = trimmedString(rawResult.task) ?? agent;
        const key = `${toolUseId}:${index}`;
        let task = ctx.extensionSubagentTasks.get(key);
        const taskId = task?.taskId ?? RuntimeTaskId.make(`pi-subagent:${key}`);
        const model = trimmedString(rawResult.model);
        const reportedSource = trimmedString(rawResult.agentSource);
        const agentScope = trimmedString(details.agentScope);
        const role =
          reportedSource && reportedSource !== "unknown"
            ? reportedSource
            : agentScope === "user"
              ? "user"
              : "unknown";
        const linkage = {
          taskType: "subagent",
          title: agent,
          role,
          ...(model ? { model } : {}),
          toolUseId,
        } as const;
        if (!task) {
          task = { taskId, description, title: agent, role, model, toolUseId, state: "running" };
          ctx.extensionSubagentTasks.set(key, task);
          yield* offer({
            type: "task.started",
            ...(yield* base(ctx, turn)),
            payload: { taskId, description, ...linkage },
            raw: raw(native),
          });
        }

        const usage = isRecord(rawResult.usage) ? rawResult.usage : {};
        const inputTokens = finiteNonNegative(usage.input);
        const outputTokens = finiteNonNegative(usage.output);
        const cachedInputTokens = finiteNonNegative(usage.cacheRead);
        const typedUsage = {
          totalTokens: inputTokens + outputTokens,
          inputTokens,
          outputTokens,
          cachedInputTokens,
        };
        if (type === "tool_execution_update") {
          if (task.state !== "running") continue;
          yield* offer({
            type: "task.progress",
            ...(yield* base(ctx, turn)),
            payload: {
              taskId,
              description,
              status: "running",
              typedUsage,
              ...linkage,
            },
            raw: raw(native),
          });
          continue;
        }

        if (task.state !== "running") continue;
        const exitCode = finiteNonNegative(rawResult.exitCode);
        const stopReason = trimmedString(rawResult.stopReason);
        const failed =
          exitCode !== 0 ||
          stopReason === "error" ||
          stopReason === "aborted" ||
          event.isError === true;
        task.state = failed ? "failed" : "completed";
        const error = trimmedString(rawResult.errorMessage) ?? trimmedString(rawResult.stderr);
        yield* offer({
          type: "task.completed",
          ...(yield* base(ctx, turn)),
          payload: {
            taskId,
            status: failed ? "failed" : "completed",
            ...((error ?? description) ? { summary: error ?? description } : {}),
            typedUsage,
            ...linkage,
          },
          raw: raw(native),
        });
      }
    },
  );

  const handleWorkflowToolEvent = Effect.fn("PiAdapter.handleWorkflowToolEvent")(function* (
    ctx: SessionContext,
    turn: ActiveTurn,
    event: Record<string, unknown>,
    native: PiRpcEvent,
  ) {
    if (string(event.toolName)?.toLowerCase() !== "workflow") return;
    const details = workflowDetails(event);
    const runId = trimmedString(details?.runId);
    if (!details || !runId || !Array.isArray(details.agents) || details.agents.length === 0) return;
    const workflowName = trimmedString(details.name) ?? runId;
    const phases = Array.isArray(details.phases)
      ? details.phases.flatMap((phase, index) => {
          if (!isRecord(phase)) return [];
          const title = trimmedString(phase.title);
          return title ? [{ index, title }] : [];
        })
      : [];
    const coordinatorKey = `${runId}:coordinator`;
    let coordinator = ctx.workflowTasks.get(coordinatorKey);
    const coordinatorTaskId =
      coordinator?.taskId ?? RuntimeTaskId.make(`pi-workflow:${coordinatorKey}`);
    const coordinatorLinkage = {
      taskType: "local_workflow",
      title: workflowName,
      role: "workflow coordinator",
      workflowName,
      ...(phases.length > 0 ? { phases } : {}),
      runHandles: { runId },
    } as const;
    if (!coordinator) {
      coordinator = { taskId: coordinatorTaskId, state: "running" };
      ctx.workflowTasks.set(coordinatorKey, coordinator);
      yield* offer({
        type: "task.started",
        ...(yield* base(ctx, turn)),
        payload: {
          taskId: coordinatorTaskId,
          description: workflowName,
          ...coordinatorLinkage,
        },
        raw: raw(native),
      });
    }
    for (const rawAgent of details.agents) {
      if (!isRecord(rawAgent)) continue;
      const index = finiteNonNegative(rawAgent.index);
      const label = trimmedString(rawAgent.label) ?? `Agent ${index + 1}`;
      const state = rawAgent.state;
      if (state !== "running" && state !== "done" && state !== "error") continue;
      const key = `${runId}:${index}`;
      let task = ctx.workflowTasks.get(key);
      const taskId = task?.taskId ?? RuntimeTaskId.make(`pi-workflow:${key}`);
      const phaseTitle = trimmedString(rawAgent.phase);
      const phaseIndex = phaseTitle
        ? phases.find((phase) => phase.title === phaseTitle)?.index
        : undefined;
      const model = trimmedString(rawAgent.model);
      const usage = isRecord(rawAgent.usage) ? rawAgent.usage : {};
      const inputTokens = finiteNonNegative(usage.input);
      const outputTokens = finiteNonNegative(usage.output);
      const cachedInputTokens = finiteNonNegative(usage.cacheRead);
      const startedAt = finiteNonNegative(rawAgent.startedAt);
      const finishedAt = finiteNonNegative(rawAgent.finishedAt);
      const typedUsage = {
        totalTokens: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        ...(startedAt > 0 && finishedAt >= startedAt ? { durationMs: finishedAt - startedAt } : {}),
      };
      const linkage = {
        taskType: "workflow-agent",
        title: label,
        role: "workflow agent",
        ...(model ? { model } : {}),
        workflowName,
        parentAgentId: coordinatorTaskId,
        agentIndex: index,
        ...(phaseIndex !== undefined ? { phaseIndex } : {}),
        ...(phaseTitle ? { phaseTitle } : {}),
        ...(phases.length > 0 ? { phases } : {}),
        runHandles: { runId },
      } as const;
      if (!task) {
        task = { taskId, state: "running" };
        ctx.workflowTasks.set(key, task);
        yield* offer({
          type: "task.started",
          ...(yield* base(ctx, turn)),
          payload: { taskId, description: label, ...linkage },
          raw: raw(native),
        });
      }
      if (task.state !== "running" && state === task.state) continue;
      task.state = state;
      const preview = trimmedString(rawAgent.preview);
      if (state === "running") {
        yield* offer({
          type: "task.progress",
          ...(yield* base(ctx, turn)),
          payload: {
            taskId,
            description: label,
            status: "running",
            ...(preview ? { summary: preview } : {}),
            typedUsage,
            ...linkage,
          },
          raw: raw(native),
        });
      } else {
        const error = trimmedString(rawAgent.error);
        yield* offer({
          type: "task.completed",
          ...(yield* base(ctx, turn)),
          payload: {
            taskId,
            status: state === "error" ? "failed" : "completed",
            ...((error ?? preview) ? { summary: error ?? preview } : {}),
            typedUsage,
            ...linkage,
          },
          raw: raw(native),
        });
      }
    }
    const terminalStates = details.agents.flatMap((rawAgent) => {
      if (!isRecord(rawAgent)) return [];
      return rawAgent.state === "done" || rawAgent.state === "error" ? [rawAgent.state] : [];
    });
    if (
      coordinator.state === "running" &&
      terminalStates.length === details.agents.length &&
      terminalStates.length > 0
    ) {
      coordinator.state = terminalStates.includes("error") ? "error" : "done";
      yield* offer({
        type: "task.completed",
        ...(yield* base(ctx, turn)),
        payload: {
          taskId: coordinatorTaskId,
          status: coordinator.state === "error" ? "failed" : "completed",
          ...coordinatorLinkage,
        },
        raw: raw(native),
      });
    }
  });

  const handleSubagentResultMessage = Effect.fn("PiAdapter.handleSubagentResultMessage")(function* (
    ctx: SessionContext,
    turn: ActiveTurn,
    event: Record<string, unknown>,
    native: PiRpcEvent,
  ) {
    const message = isRecord(event.message) ? event.message : undefined;
    if (
      message?.role !== "custom" ||
      (message.customType !== "subagent-result" && message.customType !== "subagent-notification")
    )
      return false;
    const details = isRecord(message.details) ? message.details : undefined;
    if (!details) return true;
    const content =
      trimmedString(message.content) ??
      (Array.isArray(message.content) ? piToolText({ content: message.content }) : undefined);
    const results = [details, ...(Array.isArray(details.others) ? details.others : [])];
    for (const rawResult of results) {
      if (!isRecord(rawResult)) continue;
      const id = trimmedString(rawResult.id);
      if (!id) continue;
      const task = ctx.agentTasksById.get(id);
      if (!task) continue;
      task.title =
        trimmedString(rawResult.title) ?? trimmedString(rawResult.description) ?? task.title;
      const status = trimmedString(rawResult.status);
      const summary =
        trimmedString(rawResult.error) ??
        trimmedString(rawResult.resultPreview) ??
        trimmedString(rawResult.description) ??
        content;
      const totalTokens = finiteNonNegative(rawResult.totalTokens);
      const toolUses = finiteNonNegative(rawResult.toolUses);
      const durationMs = finiteNonNegative(rawResult.durationMs);
      yield* completeAgentTask(
        ctx,
        turn,
        task,
        status === "error"
          ? "failed"
          : status === "stopped" || status === "aborted"
            ? "stopped"
            : "completed",
        summary?.slice(0, 2_000),
        native,
        {
          totalTokens,
          ...(toolUses > 0 ? { toolUses } : {}),
          ...(durationMs > 0 ? { durationMs } : {}),
        },
      );
    }
    return true;
  });

  const handleEvent = Effect.fn("PiAdapter.handleEvent")(function* (
    ctx: SessionContext,
    native: PiRpcEvent,
  ) {
    if ("_tag" in native && native._tag === "PiRpcProtocolFailureEvent") {
      yield* failActive(ctx, String(native.detail), native);
      yield* close(ctx);
      return;
    }
    if ("_tag" in native && native._tag === "PiRpcOutputLineEvent") {
      yield* Effect.logDebug("Ignored non-JSON Pi output").pipe(
        Effect.annotateLogs({ provider: "pi", output: native.line }),
      );
      return;
    }
    const event = native as Record<string, unknown>;
    const type = string(event.type);
    if (type === "extension_ui_request") {
      yield* handleExtensionUiRequest(ctx, event);
      return;
    }
    let turn = ctx.activeTurn;
    if (type === "agent_start") {
      if (!turn || turn.terminal) {
        turn = yield* beginTurn(ctx, {
          ...(ctx.session.model ? { model: ctx.session.model } : {}),
          ...(ctx.thinkingLevel ? { effort: ctx.thinkingLevel } : {}),
        });
      }
      return;
    }
    if (!turn || turn.terminal) return;
    if (type === "message_update") {
      turn.compactionContinuationPending = false;
      const update = isRecord(event.assistantMessageEvent)
        ? event.assistantMessageEvent
        : undefined;
      const updateType = string(update?.type);
      const delta = string(update?.delta);
      if ((updateType === "text_delta" || updateType === "thinking_delta") && delta) {
        const isAssistant = updateType === "text_delta";
        const itemId = isAssistant ? turn.assistantItemId : turn.reasoningItemId;
        const started = isAssistant ? turn.assistantStarted : turn.reasoningStarted;
        if (!started) {
          if (isAssistant) turn.assistantStarted = true;
          else turn.reasoningStarted = true;
          yield* offer({
            type: "item.started",
            ...(yield* base(ctx, turn)),
            itemId,
            payload: {
              itemType: isAssistant ? "assistant_message" : "reasoning",
              status: "inProgress",
              title: isAssistant ? "Assistant message" : "Reasoning",
            },
            raw: raw(native),
          });
        }
        yield* offer({
          type: "content.delta",
          ...(yield* base(ctx, turn)),
          itemId,
          payload: {
            streamKind: isAssistant ? "assistant_text" : "reasoning_text",
            delta,
          },
          raw: raw(native),
        });
      } else if (updateType === "error") {
        if (!turn.interruptRequested) {
          yield* failActive(
            ctx,
            string(update?.reason) ?? string(update?.error) ?? "Pi assistant failed.",
            native,
          );
        }
      }
      return;
    }
    if (type === "message_end") {
      yield* handleSubagentResultMessage(ctx, turn, event, native);
      const message = isRecord(event.message) ? event.message : undefined;
      if (message?.role === "assistant") {
        turn.lastAssistantMessageIncomplete =
          message.stopReason === "toolUse" &&
          Array.isArray(message.content) &&
          message.content.length === 0;
        yield* completeAssistantSegment(ctx, turn, native);
        // Codex and Claude receive usage at native response boundaries. Pi has
        // no equivalent push notification, so read its authoritative current
        // context snapshot as soon as a fresh assistant response is recorded.
        yield* refreshTokenUsage(ctx, turn, native);
      }
      if (
        message?.role === "assistant" &&
        message.stopReason === "error" &&
        !turn.interruptRequested
      ) {
        yield* failActive(
          ctx,
          trimmedString(message.errorMessage) ?? "Pi assistant failed.",
          native,
          false,
        );
      } else if (message?.role === "assistant" && message.stopReason === "aborted") {
        turn.interruptRequested = true;
      }
      return;
    }
    if (type === "compaction_end") {
      const successfulThresholdCompaction =
        event.reason === "threshold" &&
        isRecord(event.result) &&
        event.aborted !== true &&
        event.willRetry !== true;
      if (
        successfulThresholdCompaction &&
        turn.lastAssistantMessageIncomplete &&
        !turn.compactionContinuationPending &&
        !turn.interruptRequested
      ) {
        turn.lastAssistantMessageIncomplete = false;
        turn.compactionContinuationPending = true;
        ctx.steeringPromptsInFlight += 1;
        ctx.steeringGeneration += 1;
        const continued = yield* ctx.client
          .prompt(
            "Continue the current task after automatic context compaction.",
            undefined,
            "followUp",
          )
          .pipe(Effect.exit);
        ctx.steeringPromptsInFlight -= 1;
        if (Exit.isFailure(continued)) {
          turn.compactionContinuationPending = false;
          yield* failActive(
            ctx,
            "Pi failed to continue after automatic context compaction.",
            native,
          );
        }
      }
      return;
    }
    if (type?.startsWith("tool_execution_")) {
      turn.compactionContinuationPending = false;
      const lifecycle =
        type === "tool_execution_start"
          ? "item.started"
          : type === "tool_execution_update"
            ? "item.updated"
            : "item.completed";
      const itemId = itemForTool(turn, event);
      const toolKey = toolEventKey(event);
      const eventArgs = isRecord(event.args) ? event.args : undefined;
      if (eventArgs) turn.toolArgs.set(toolKey, eventArgs);
      const presentationEvent =
        eventArgs || !turn.toolArgs.has(toolKey)
          ? event
          : { ...event, args: turn.toolArgs.get(toolKey) };
      const isError = event.isError === true;
      yield* handleSubagentToolEvent(ctx, turn, presentationEvent, native);
      yield* handleExtensionSubagentToolEvent(ctx, turn, presentationEvent, native);
      yield* handleWorkflowToolEvent(ctx, turn, presentationEvent, native);
      yield* offer({
        type: lifecycle,
        ...(yield* base(ctx, turn)),
        itemId,
        payload: {
          ...piToolPresentation(presentationEvent),
          status:
            lifecycle === "item.completed" ? (isError ? "failed" : "completed") : "inProgress",
        },
        raw: raw(native),
      } as ProviderRuntimeEvent);
      return;
    }
    if (type === "agent_settled") {
      if (ctx.steeringPromptsInFlight > 0) {
        ctx.deferredSettlement = native;
        return;
      }
      const state = yield* Effect.gen(function* () {
        while (ctx.steeringPromptsInFlight === 0) {
          const steeringGeneration = ctx.steeringGeneration;
          const snapshot = yield* ctx.client.getState().pipe(
            Effect.mapError((cause) => request("get_state", cause)),
            Effect.exit,
          );
          if (ctx.steeringGeneration === steeringGeneration) return snapshot;
        }
        return undefined;
      });
      if (state === undefined) {
        ctx.deferredSettlement = native;
        return;
      }
      if (ctx.activeTurn !== turn || turn.terminal || ctx.closing || ctx.stopped) return;
      if (Exit.isFailure(state)) {
        yield* failActive(ctx, "Pi session state check failed during settlement.", native, false);
        return;
      }
      if (!piStateMatchesCursor(state.value, ctx.cursor)) {
        yield* failActive(ctx, "Pi session identity drifted during settlement.", native);
        yield* close(ctx);
        return;
      }
      if (state.value.isStreaming === true) return;
      const terminalEvents: ProviderRuntimeEvent[] = [];
      // Keep settlement as a fallback for turns that produce no assistant
      // message_end event and for a final snapshot that changed since it.
      const usageEvent = yield* readTokenUsageEvent(ctx, turn, native);
      if (turn.assistantStarted) {
        terminalEvents.push({
          type: "item.completed",
          ...(yield* base(ctx, turn)),
          itemId: turn.assistantItemId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
          },
          raw: raw(native),
        });
      }
      if (turn.reasoningStarted) {
        terminalEvents.push({
          type: "item.completed",
          ...(yield* base(ctx, turn)),
          itemId: turn.reasoningItemId,
          payload: {
            itemType: "reasoning",
            status: "completed",
            title: "Reasoning",
          },
          raw: raw(native),
        });
      }
      terminalEvents.push({
        type: "turn.completed",
        ...(yield* base(ctx, turn)),
        payload: {
          state: turn.interruptRequested ? "interrupted" : "completed",
          stopReason: turn.interruptRequested ? "abort" : null,
        },
        raw: raw(native),
      });
      if (usageEvent) terminalEvents.push(usageEvent);
      yield* publishTerminal(ctx, turn, terminalEvents, "ready");
    }
    // agent_end and turn_end are native cycle boundaries, not T3 settlement.
  });

  const requireSession = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    return ctx && !ctx.stopped
      ? Effect.succeed(ctx)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.scoped(
        Effect.gen(function* () {
          if (input.runtimeMode !== "full-access")
            return yield* validation("startSession", "Pi supports only full-access runtime mode.");
          if (input.provider && input.provider !== PROVIDER)
            return yield* validation("startSession", `Expected provider '${PROVIDER}'.`);
          if (input.providerInstanceId && input.providerInstanceId !== options.providerInstanceId)
            return yield* validation(
              "startSession",
              "Provider instance does not match this Pi adapter.",
            );
          if (sessions.has(input.threadId))
            return yield* validation(
              "startSession",
              `Thread '${input.threadId}' is already active.`,
            );
          const cwd = yield* provideFiles(
            fs.realPath(path.resolve(input.cwd ?? process.cwd())),
          ).pipe(
            Effect.mapError((cause) =>
              validation("startSession", "Invalid Pi working directory.", cause),
            ),
          );
          const fresh = input.resumeCursor === undefined;
          let cursor: PiSessionCursor | undefined;
          let freshFile: { readonly sessionFile: string } | undefined;
          const scope = yield* Scope.make();
          let transferred = false;
          let leasedFile: string | undefined;
          let startupLease: SessionFileLease | undefined;
          let candidateCtx: SessionContext | undefined;
          yield* Effect.addFinalizer(() =>
            transferred
              ? Effect.void
              : Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
                    if (candidateCtx && sessions.get(input.threadId) === candidateCtx)
                      sessions.delete(input.threadId);
                    const ownsStartupLease =
                      leasedFile !== undefined &&
                      startupLease !== undefined &&
                      sessionFileLeases.get(leasedFile) === startupLease;
                    const releaseStartupLease = Effect.sync(() => {
                      if (ownsStartupLease && sessionFileLeases.get(leasedFile!) === startupLease)
                        sessionFileLeases.delete(leasedFile!);
                    });
                    yield* freshFile && (leasedFile === undefined || ownsStartupLease)
                      ? provideFiles(cleanupFreshPiSessionFile(freshFile)).pipe(
                          Effect.ignore,
                          Effect.ensuring(releaseStartupLease),
                        )
                      : releaseStartupLease;
                  }),
                ),
          );
          if (fresh) {
            freshFile = yield* provideFiles(
              allocateFreshPiSessionFile({ stateRoot: root, fileId: yield* uuid }),
            ).pipe(Effect.mapError((cause) => request("session/allocate", cause)));
          } else {
            cursor = yield* decodePiSessionCursor(input.resumeCursor).pipe(
              Effect.mapError((cause) =>
                validation("startSession", "Invalid Pi resume cursor.", cause),
              ),
            );
            cursor = yield* provideFiles(
              validatePiResumeSessionFile({ stateRoot: root, cursor, cwd }),
            ).pipe(
              Effect.mapError((cause) =>
                validation("startSession", "Invalid Pi resume session file.", cause),
              ),
            );
          }
          const candidateFile = cursor?.sessionFile ?? freshFile!.sessionFile;
          const leaseOwner = sessionFileLeases.get(candidateFile);
          if (leaseOwner !== undefined)
            return yield* validation("startSession", "Pi session file already has a live writer.");
          startupLease = { startupOwned: true };
          sessionFileLeases.set(candidateFile, startupLease);
          leasedFile = candidateFile;
          const factory: PiRpcClientFactory = options.makeRpcClient ?? makePiRpcClient;
          const spawnEnvironment = options.environment ?? process.env;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const mcpConfigFile = mcpSession
            ? yield* provideFiles(
                allocateT3McpConfig({
                  stateRoot: root,
                  threadId: input.threadId,
                  endpoint: mcpSession.endpoint,
                  authorizationHeader: mcpSession.authorizationHeader,
                  environment: spawnEnvironment,
                }),
              ).pipe(Effect.mapError((cause) => request("mcp/configure", cause)))
            : undefined;
          if (mcpConfigFile)
            yield* Scope.addFinalizer(
              scope,
              provideFiles(fs.remove(mcpConfigFile, { force: true })).pipe(Effect.ignore),
            );
          const startClient = (withMcpConfigFlag: boolean) =>
            factory({
              command: options.binaryPath,
              args: [
                ...(options.args ?? []),
                ...(withMcpConfigFlag && mcpConfigFile ? ["--mcp-config", mcpConfigFile] : []),
                "--session",
                cursor?.sessionFile ?? freshFile!.sessionFile,
                ...DETERMINISTIC_ARGS,
              ],
              cwd,
              env: {
                ...spawnEnvironment,
                ...(mcpConfigFile ? { T3CODE_PI_MCP_CONFIG: mcpConfigFile } : {}),
              },
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.flatMap((client) =>
                client.getState().pipe(
                  Effect.map((state) => ({ client, state })),
                  Effect.onError(() => client.close()),
                ),
              ),
              Effect.mapError((cause) => request("session/start", cause)),
              Effect.result,
            );
          let started = yield* startClient(mcpConfigFile !== undefined);
          const mcpConfigFallback = mcpConfigFile !== undefined && Result.isFailure(started);
          if (mcpConfigFallback) started = yield* startClient(false);
          if (
            fresh &&
            Result.isSuccess(started) &&
            started.success.state.sessionFile === freshFile!.sessionFile &&
            typeof started.success.state.sessionId === "string" &&
            started.success.state.sessionId.length > 0 &&
            started.success.state.sessionId.trim() === started.success.state.sessionId
          ) {
            cursor = {
              schemaVersion: 1,
              sessionFile: freshFile!.sessionFile,
              sessionId: started.success.state.sessionId,
            };
          }
          if (
            Result.isFailure(started) ||
            cursor === undefined ||
            !piStateMatchesCursor(started.success.state, cursor)
          ) {
            if (Result.isSuccess(started)) yield* started.success.client.close();
            yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
            if (Result.isFailure(started)) return yield* started.failure;
            return yield* validation("startSession", "Pi reported a different session path or id.");
          }
          // Fresh Pi must have replaced the private placeholder with its exact header.
          cursor = yield* provideFiles(
            validatePiResumeSessionFile({ stateRoot: root, cursor, cwd }),
          ).pipe(
            Effect.mapError((cause) =>
              validation("startSession", "Pi session header validation failed.", cause),
            ),
            Effect.onError(() =>
              started.success.client
                .close()
                .pipe(
                  Effect.andThen(Scope.close(scope, Exit.void)),
                  Effect.andThen(
                    freshFile ? provideFiles(cleanupFreshPiSessionFile(freshFile)) : Effect.void,
                  ),
                  Effect.ignore,
                ),
            ),
          );
          const createdAt = yield* now;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.providerInstanceId,
            threadId: input.threadId,
            status: "ready",
            runtimeMode: "full-access",
            cwd,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            resumeCursor: cursor,
            createdAt,
            updatedAt: createdAt,
          };
          const ctx: SessionContext = {
            session,
            cursor,
            lease: startupLease,
            mcpConfigFile,
            client: started.success.client,
            scope,
            eventFiber: undefined as never,
            activeTurn: undefined,
            steeringPromptsInFlight: 0,
            steeringGeneration: 0,
            deferredSettlement: undefined,
            pendingUserInputs: new Map(),
            resolvingUserInputs: new Set(),
            agentTasksByToolCall: new Map(),
            agentTasksById: new Map(),
            workflowTasks: new Map(),
            extensionSubagentTasks: new Map(),
            lastEventCreatedAt: undefined,
            lastTokenUsage: undefined,
            thinkingLevel: started.success.state.thinkingLevel,
            closing: false,
            stopped: false,
          };
          candidateCtx = ctx;
          sessions.set(input.threadId, ctx);
          if (options.onSessionPublished) yield* options.onSessionPublished();
          ctx.eventFiber = yield* started.success.client.events.pipe(
            Stream.runForEach((event) => handleEvent(ctx, event)),
            Effect.ensuring(
              Effect.suspend(() =>
                ctx.closing || ctx.stopped
                  ? Effect.void
                  : failActive(ctx, "Pi RPC event stream ended unexpectedly.").pipe(
                      Effect.andThen(close(ctx)),
                      Effect.orDie,
                    ),
              ),
            ),
            Effect.orDie,
            Effect.forkIn(scope),
          );
          yield* Effect.yieldNow;
          if (ctx.closing || ctx.stopped)
            return yield* validation("startSession", "Pi RPC event stream ended during startup.");
          if (mcpConfigFallback)
            yield* offer({
              type: "runtime.warning",
              ...(yield* base(ctx)),
              payload: {
                message:
                  "Pi could not start with the T3 MCP configuration, so injected T3 browser tools are unavailable in this session. Update pi-mcp-adapter and refresh the provider status.",
              },
            });
          startupLease.startupOwned = false;
          transferred = true;
          return session;
        }),
      ),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) => {
    let createdTurn: ActiveTurn | undefined;
    return withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const steeringTurn = ctx.activeTurn?.terminal === false ? ctx.activeTurn : undefined;
        if (!steeringTurn && ctx.session.status !== "ready")
          return yield* validation("sendTurn", "Pi session must be idle before prompting.");
        if (!input.input && (!input.attachments || input.attachments.length === 0))
          return yield* validation("sendTurn", "Pi requires non-empty text or attachments.");
        const images = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) => {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: options.attachmentsDir,
              attachment,
            });
            if (!attachmentPath)
              return Effect.fail(
                requestMessage("prompt", `Invalid attachment id '${attachment.id}'.`),
              );
            return provideFiles(fs.readFile(attachmentPath)).pipe(
              Effect.map((bytes) => ({
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              })),
              Effect.mapError((cause) => request("prompt", cause)),
            );
          },
          { concurrency: 1 },
        );
        const selection = input.modelSelection;
        if (selection && selection.instanceId !== options.providerInstanceId)
          return yield* validation(
            "sendTurn",
            "Model selection belongs to another provider instance.",
          );
        const selectedModel = selection?.model ?? ctx.session.model;
        if (!selectedModel)
          return yield* validation("sendTurn", "A valid Pi model selection is required.");
        const parsed = decodePiModelSlug(selectedModel);
        if (!parsed)
          return yield* validation("sendTurn", "A valid Pi model selection is required.");
        const thinking = selection
          ? getModelSelectionStringOptionValue(selection, "thinkingLevel")
          : undefined;
        if (steeringTurn && ctx.activeTurn === steeringTurn) {
          if (
            selection &&
            (selectedModel !== steeringTurn.model ||
              (thinking !== undefined && thinking !== steeringTurn.effort))
          )
            return yield* validation(
              "sendTurn",
              "Pi model and thinking level cannot change during an active turn.",
            );
          ctx.steeringPromptsInFlight += 1;
          ctx.steeringGeneration += 1;
          return {
            _tag: "Steer" as const,
            effect: ctx.client.prompt(input.input ?? "", images, "steer").pipe(
              Effect.mapError((cause) => request("prompt", cause)),
              Effect.tap(() =>
                steeringTurn.interruptRequested
                  ? ctx.client.abort().pipe(Effect.mapError((cause) => request("abort", cause)))
                  : Effect.void,
              ),
              Effect.ensuring(
                Effect.gen(function* () {
                  ctx.steeringPromptsInFlight -= 1;
                  const deferredSettlement = ctx.deferredSettlement;
                  ctx.deferredSettlement = undefined;
                  if (deferredSettlement)
                    yield* handleEvent(ctx, deferredSettlement).pipe(Effect.orDie);
                }),
              ),
              Effect.uninterruptible,
              Effect.as({
                threadId: input.threadId,
                turnId: steeringTurn.id,
                resumeCursor: ctx.cursor,
              }),
            ),
          };
        }
        const available = yield* ctx.client
          .getAvailableModels()
          .pipe(Effect.mapError((cause) => request("get_available_models", cause)));
        if (
          !available.models.some((m) => m.provider === parsed.provider && m.id === parsed.modelId)
        )
          return yield* validation("sendTurn", "Selected Pi model is not currently available.");
        const thinkingLevel =
          thinking === undefined
            ? undefined
            : yield* decodePiThinkingLevel(thinking).pipe(
                Effect.mapError((cause) =>
                  validation("sendTurn", "Invalid Pi thinking level.", cause),
                ),
              );
        const previousModel = ctx.session.model ? decodePiModelSlug(ctx.session.model) : undefined;
        yield* ctx.client
          .setModel(parsed.provider, parsed.modelId)
          .pipe(Effect.mapError((cause) => request("set_model", cause)));
        if (thinkingLevel !== undefined) {
          yield* ctx.client.setThinkingLevel(thinkingLevel).pipe(
            Effect.mapError((cause) => request("set_thinking_level", cause)),
            Effect.onError(() =>
              previousModel &&
              (previousModel.provider !== parsed.provider ||
                previousModel.modelId !== parsed.modelId)
                ? ctx.client
                    .setModel(previousModel.provider, previousModel.modelId)
                    .pipe(Effect.ignore)
                : Effect.void,
            ),
          );
          ctx.thinkingLevel = thinkingLevel;
        }
        ctx.session = { ...ctx.session, model: selectedModel };
        if (
          ctx.closing ||
          ctx.stopped ||
          sessions.get(input.threadId) !== ctx ||
          ctx.session.status !== "ready"
        )
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        const turn = yield* beginTurn(ctx, {
          model: selectedModel,
          ...(ctx.thinkingLevel ? { effort: ctx.thinkingLevel } : {}),
        });
        createdTurn = turn;
        const turnId = turn.id;
        const prompted = yield* ctx.client.prompt(input.input ?? "", images).pipe(Effect.result);
        if (Result.isFailure(prompted)) {
          const reusable = isPiRpcCommandError(prompted.failure);
          yield* failActive(ctx, "Pi prompt failed.", undefined, !reusable);
          if (!reusable) yield* close(ctx);
          return yield* request("prompt", prompted.failure);
        }
        if (ctx.closing || ctx.stopped || sessions.get(input.threadId) !== ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        if (input.input?.trimStart().startsWith("/")) {
          const state = yield* ctx.client.getState().pipe(
            Effect.mapError((cause) => request("get_state", cause)),
            Effect.option,
          );
          if (
            Option.isSome(state) &&
            state.value.isStreaming !== true &&
            ctx.activeTurn === turn &&
            !turn.terminal
          ) {
            yield* publishTerminal(
              ctx,
              turn,
              [
                {
                  type: "turn.completed",
                  ...(yield* base(ctx, turn)),
                  payload: { state: "completed", stopReason: null },
                },
              ],
              "ready",
            );
          }
        }
        return {
          _tag: "Started" as const,
          result: { threadId: input.threadId, turnId, resumeCursor: ctx.cursor },
        };
      }),
    ).pipe(
      Effect.flatMap((action) =>
        action._tag === "Steer" ? action.effect : Effect.succeed(action.result),
      ),
      Effect.onInterrupt(() =>
        Effect.suspend(() => {
          const ctx = sessions.get(input.threadId);
          return ctx && ctx.activeTurn === createdTurn ? close(ctx) : Effect.void;
        }),
      ),
    );
  };

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const turn = ctx.activeTurn;
      const hasBackgroundTasks =
        Array.from(ctx.agentTasksById.values()).length > 0 ||
        Array.from(ctx.workflowTasks.values()).some((task) => task.state === "running") ||
        Array.from(ctx.extensionSubagentTasks.values()).some((task) => task.state === "running");
      if (!turn && !hasBackgroundTasks)
        return yield* validation("interruptTurn", "No active Pi work to interrupt.");
      if (turnId && (!turn || turn.id !== turnId))
        return yield* validation("interruptTurn", "No matching active Pi turn.");
      if (turn) turn.interruptRequested = true;
      // Pi's subagent extension passes the active tool AbortSignal to every
      // child process. Background task projections can outlive T3's active
      // turn, so still send the RPC abort when those tasks are the only live
      // work in the session.
      yield* ctx.client.abort().pipe(Effect.mapError((cause) => request("abort", cause)));
    });
  const unsupported = (operation: string, threadId: ThreadId) =>
    requireSession(threadId).pipe(
      Effect.andThen(validation(operation, `Pi does not support ${operation}.`)),
    );
  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      // Prompt preflight can wait on extension UI while sendTurn owns the
      // thread lock, so responses must use Pi's own serialized RPC writer.
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (!pending)
        return yield* requestMessage("extension_ui_response", "Unknown Pi input request.");
      const rawAnswer = answers[pending.questionId];
      const answer = (Array.isArray(rawAnswer) ? rawAnswer[0] : rawAnswer)?.trim();
      if (!answer) return yield* validation("respondToUserInput", "Pi requires an answer.");
      const response =
        pending.method === "confirm"
          ? {
              confirmed: ["yes", "true", "confirm", "confirmed"].includes(answer.toLowerCase()),
            }
          : { value: answer };
      const resolved = yield* resolveExtensionInput(ctx, requestId, pending, answers, response);
      if (!resolved)
        return yield* requestMessage("extension_ui_response", "Pi input request already resolved.");
    });
  const stopSession = (threadId: ThreadId) =>
    sessions.has(threadId) ? close(sessions.get(threadId)!) : Effect.void;
  const stopAll = () =>
    Effect.forEach([...sessions.keys()], stopSession, { discard: true, concurrency: "unbounded" });
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: (threadId) => unsupported("respondToRequest", threadId),
    respondToUserInput,
    readThread: (threadId) => unsupported("readThread", threadId),
    rollbackThread: (threadId) => unsupported("rollbackThread", threadId),
    stopSession,
    listSessions: () =>
      Effect.sync(() => [...sessions.values()].map((ctx) => ({ ...ctx.session }))),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    stopAll,
    streamEvents: Stream.fromQueue(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
