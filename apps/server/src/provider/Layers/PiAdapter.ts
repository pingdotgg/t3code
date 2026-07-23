/** `ProviderAdapterShape` for the Pi coding agent (per-thread `pi --mode rpc` sessions). */
import * as NodeURL from "node:url";

import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ModelSelection,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  type AgentSessionEvent,
  buildPiTurnCommand,
  extractAssistantTextDelta,
  extractForkMessages,
  extractReasoningTextDelta,
  extractSessionFile,
  makePiRpcTransport,
  type MakePiRpcTransportOptions,
  piForkSucceeded,
  piImageContentFromBytes,
  type PiImageContent,
  piResponseHasCommand,
  piResponseSucceeded,
  planPiModelSwitch,
  resolveForkTargetEntryId,
  resolvePiThinkingLevel,
  type PiRpcTransport,
  type PiStdoutMessage,
  type PiThinkingLevel,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from "./PiRpcClient.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const PI_STATE_TIMEOUT_MS = 5_000;
const PI_COMMANDS_TIMEOUT_MS = 5_000;
const PI_MESSAGES_TIMEOUT_MS = 5_000;
// fork/new_session rebinds to a new session file — give it more headroom
const PI_FORK_TIMEOUT_MS = 15_000;
const PI_MODEL_OPTIONS_TIMEOUT_MS = 5_000;

// keep in sync with SENTINEL_COMMAND in t3-approvals.ts
const PI_APPROVAL_SENTINEL_COMMAND = "t3-approval-gate";

// like Claude/Cursor: full-access runs ungated; approval-required and
// auto-accept-edits gate via the bundled extension (Pi has no native per-tool approval)
function approvalGateForRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
): { readonly gate: false } | { readonly gate: true; readonly mode: string } {
  if (runtimeMode === "approval-required" || runtimeMode === "auto-accept-edits") {
    return { gate: true, mode: runtimeMode };
  }
  return { gate: false };
}

// dev resolves ../assets (running from src); the vp-pack build copies the asset
// next to the bundle, so prod resolves ./assets
const APPROVAL_EXTENSION_CANDIDATES: ReadonlyArray<string> = (() => {
  const resolve = (relative: string): string | undefined => {
    try {
      return NodeURL.fileURLToPath(new URL(relative, import.meta.url));
    } catch {
      return undefined;
    }
  };
  return [resolve("../assets/pi/t3-approvals.ts"), resolve("./assets/pi/t3-approvals.ts")].filter(
    (value): value is string => value !== undefined,
  );
})();

interface PiToolItem {
  readonly id: RuntimeItemId;
  readonly type: CanonicalItemType;
  readonly toolName: string;
  args: unknown;
}

interface PiTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<PiToolItem>;
}

interface PendingApproval {
  readonly piId: string;
  readonly requestType: CanonicalRequestType;
}

interface PendingUserInput {
  readonly piId: string;
  readonly questionId: string;
  readonly method: "select" | "input" | "editor";
  readonly numberedOptions?: ReadonlyArray<string>;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly sessionScope: Scope.Closeable;
  readonly transport: PiRpcTransport;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turnState: PiTurnState | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<PiToolItem> }>;
  stopped: boolean;
  // slug the pi process is running; used to issue set_model only on change
  currentModel: string | undefined;
  appliedThinkingLevel: PiThinkingLevel | undefined;
}

// ---------------------------------------------------------------------------
// Pure classification helpers
// ---------------------------------------------------------------------------

export function classifyPiToolItemType(toolName: string): CanonicalItemType {
  // whole-token match (split camelCase/separators) so "recommend" isn't read as "command"
  const tokens = new Set(
    toolName
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[._/-]/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
  const has = (...words: ReadonlyArray<string>): boolean => words.some((word) => tokens.has(word));

  if (has("agent", "subagent", "task", "skill")) return "collab_agent_tool_call";
  if (has("bash", "shell", "command", "terminal", "exec")) return "command_execution";
  if (has("edit", "write", "patch", "apply", "file")) return "file_change";
  if (has("mcp")) return "mcp_tool_call";
  if (has("search", "web")) return "web_search";
  if (has("image")) return "image_view";
  return "dynamic_tool_call";
}

export function classifyPiApprovalRequestType(toolHint: string): CanonicalRequestType {
  const item = classifyPiToolItemType(toolHint);
  switch (item) {
    case "command_execution":
      return "command_execution_approval";
    case "file_change":
      return "file_change_approval";
    default:
      // a Pi confirm is a binary gate, not structured input; tool_user_input
      // would be dropped by the runtime-ingestion + web approval pipeline
      return "dynamic_tool_call";
  }
}

export function summarizePiToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
  const command = input["command"] ?? input["cmd"];
  if (typeof command === "string" && command.trim().length > 0) return command.trim().slice(0, 400);
  const path = input["file_path"] ?? input["path"] ?? input["filePath"];
  if (typeof path === "string" && path.trim().length > 0) return path.trim().slice(0, 400);
  const pattern = input["pattern"] ?? input["query"] ?? input["description"];
  if (typeof pattern === "string" && pattern.trim().length > 0) return pattern.trim().slice(0, 400);
  try {
    const serialized = JSON.stringify(input);
    return serialized.length <= 400 ? serialized : `${serialized.slice(0, 397)}...`;
  } catch {
    return undefined;
  }
}

// Pi encodes an RPC multi-select as `Title\n1. A\n2. B`
export function parseNumberedList(
  text: string,
): { title: string; items: ReadonlyArray<string> } | null {
  const lines = text.split("\n");
  const items: string[] = [];
  for (const line of lines.slice(1)) {
    const match = /^\d+\.\s+(.+)$/.exec(line.trim());
    if (match?.[1]) items.push(match[1]);
  }
  return items.length >= 2 ? { title: lines[0] ?? text, items } : null;
}

export function isPiApprovalConfirmed(decision: ProviderApprovalDecision): boolean {
  return decision === "accept" || decision === "acceptForSession";
}

export function buildPiApprovalResponse(
  piId: string,
  decision: ProviderApprovalDecision,
): RpcExtensionUIResponse {
  return { type: "extension_ui_response", id: piId, confirmed: isPiApprovalConfirmed(decision) };
}

// numbered-list multi-select maps labels back to Pi's 1-based, comma-joined indices
export function buildPiUserInputResponse(
  pending: {
    readonly piId: string;
    readonly questionId: string;
    readonly method: "select" | "input" | "editor";
    readonly numberedOptions?: ReadonlyArray<string>;
  },
  answers: ProviderUserInputAnswers,
): RpcExtensionUIResponse {
  const answer = answers[pending.questionId];
  const numberedOptions = pending.numberedOptions;
  if (pending.method === "input" && numberedOptions) {
    const selected: ReadonlyArray<string> = Array.isArray(answer)
      ? answer.map(String)
      : typeof answer === "string" && answer.length > 0
        ? [answer]
        : [];
    const indices = selected
      .map((label) => {
        const idx = numberedOptions.indexOf(label);
        return idx >= 0 ? String(idx + 1) : null;
      })
      .filter((value): value is string => value !== null);
    return { type: "extension_ui_response", id: pending.piId, value: indices.join(",") };
  }
  const value = typeof answer === "string" ? answer : "";
  return { type: "extension_ui_response", id: pending.piId, value };
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return fallback;
}

function readPiResumeState(resumeCursor: unknown): { sessionFile: string } | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const cursor = resumeCursor as Record<string, unknown>;
  return typeof cursor["sessionFile"] === "string" && cursor["sessionFile"].trim().length > 0
    ? { sessionFile: cursor["sessionFile"].trim() }
    : undefined;
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  // transport override for tests; defaults to the real `pi --mode rpc` spawn
  readonly makeTransport?: (
    options: MakePiRpcTransportOptions,
  ) => Effect.Effect<
    PiRpcTransport,
    PlatformError.PlatformError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options?: PiAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const baseEnvironment = options?.environment ?? process.env;

  let approvalExtensionPath: string | undefined;
  for (const candidate of APPROVAL_EXTENSION_CANDIDATES) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      approvalExtensionPath = candidate;
      break;
    }
  }
  const approvalExtensionAvailable = approvalExtensionPath !== undefined;

  const sessions = new Map<ThreadId, PiSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nextEventId = Effect.map(nextUuid, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const rawEvent = (
    source: "pi.rpc.event" | "pi.rpc.extension-ui",
    method: string,
    payload: unknown,
  ) => ({ raw: { source, method, payload } }) as const;

  const completeTurn = (
    context: PiSessionContext,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) return;
      context.turnState = undefined;
      context.turns.push({ id: turnState.turnId, items: [...turnState.items] });

      const updatedAt = yield* nowIso;
      const { activeTurnId: _activeTurnId, ...readySession } = context.session;
      context.session = { ...readySession, status: "ready", updatedAt };

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.completed",
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          state,
          ...(errorMessage ? { errorMessage } : {}),
        },
      });
    });

  const openTurn = (context: PiSessionContext): Effect.Effect<TurnId> =>
    Effect.gen(function* () {
      const turnId = TurnId.make(yield* nextUuid);
      const startedAt = yield* nowIso;
      context.turnState = { turnId, startedAt, items: [] };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId,
        type: "turn.started",
        payload: context.currentModel ? { model: context.currentModel } : {},
      });
      return turnId;
    });

  const handlePiEvent = (
    context: PiSessionContext,
    event: AgentSessionEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      const base = {
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...rawEvent("pi.rpc.event", event.type, event),
      };

      switch (event.type) {
        case "agent_start": {
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: { state: "running" },
          });
          return;
        }

        case "turn_start": {
          if (!context.turnState) {
            yield* openTurn(context);
          }
          return;
        }

        case "message_update": {
          if (!context.turnState) return;
          const text = extractAssistantTextDelta(event);
          if (text !== null) {
            yield* offerRuntimeEvent({
              ...base,
              turnId: context.turnState.turnId,
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: text },
            });
            return;
          }
          const reasoning = extractReasoningTextDelta(event);
          if (reasoning !== null) {
            yield* offerRuntimeEvent({
              ...base,
              turnId: context.turnState.turnId,
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta: reasoning },
            });
          }
          return;
        }

        case "tool_execution_start": {
          if (!context.turnState) return;
          const itemId = RuntimeItemId.make(event.toolCallId);
          const itemType = classifyPiToolItemType(event.toolName);
          const detail = summarizePiToolArgs(event.args);
          const argsObj =
            event.args && typeof event.args === "object"
              ? (event.args as Record<string, unknown>)
              : undefined;
          context.turnState.items.push({
            id: itemId,
            type: itemType,
            toolName: event.toolName,
            args: event.args,
          });
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId,
            type: "item.started",
            payload: {
              itemType,
              title: event.toolName,
              ...(detail ? { detail } : {}),
              ...(argsObj ? { data: { toolName: event.toolName, input: argsObj } } : {}),
            },
          });
          return;
        }

        case "tool_execution_update": {
          if (!context.turnState) return;
          const partial = (event as { partialResult?: unknown }).partialResult;
          if (partial === undefined) return;
          const itemId = RuntimeItemId.make(event.toolCallId);
          const itemType = classifyPiToolItemType(event.toolName);
          const delta = typeof partial === "string" ? partial : String(partial);
          if (delta.length === 0) return;
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId,
            type: "content.delta",
            payload: {
              streamKind:
                itemType === "command_execution" ? "command_output" : "file_change_output",
              delta,
            },
          });
          return;
        }

        case "tool_execution_end": {
          if (!context.turnState) return;
          const itemId = RuntimeItemId.make(event.toolCallId);
          const itemType = classifyPiToolItemType(event.toolName);
          const storedItem = context.turnState.items.find((item) => item.id === itemId);
          const detail = summarizePiToolArgs(storedItem?.args);
          const argsObj =
            storedItem?.args && typeof storedItem.args === "object"
              ? (storedItem.args as Record<string, unknown>)
              : undefined;
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId,
            type: "item.completed",
            payload: {
              itemType,
              title: event.toolName,
              status: event.isError ? "failed" : "completed",
              ...(detail ? { detail } : {}),
              ...(argsObj ? { data: { toolName: event.toolName, input: argsObj } } : {}),
            },
          });
          return;
        }

        case "turn_end": {
          // agent_end drives completion, not turn_end (pi runs many internal turns per prompt)
          return;
        }

        case "agent_end": {
          // willRetry means pi will auto-retry (another agent_start/end cycle) —
          // finalize only on the terminal end, since a retry isn't a user interrupt
          if (event.willRetry) return;
          if (context.turnState) {
            yield* completeTurn(context, "completed");
          }
          return;
        }

        case "compaction_start": {
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: { state: "waiting", reason: "compaction" },
          });
          return;
        }

        case "compaction_end": {
          yield* offerRuntimeEvent({
            ...base,
            type: "thread.state.changed",
            payload: { state: "compacted" },
          });
          return;
        }

        default:
          return;
      }
    });

  const handleExtensionUIRequest = (
    context: PiSessionContext,
    request: RpcExtensionUIRequest,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // fire-and-forget UI side-effects — Pi does not await a response
      if (
        request.method === "notify" ||
        request.method === "setStatus" ||
        request.method === "setWidget" ||
        request.method === "setTitle" ||
        request.method === "set_editor_text"
      ) {
        return;
      }

      const stamp = yield* makeEventStamp();
      const requestId = ApprovalRequestId.make(yield* nextUuid);
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const turnId = context.turnState?.turnId;

      if (request.method === "confirm") {
        const requestType = classifyPiApprovalRequestType(request.title);
        const detail =
          request.message.length > 0 ? `${request.title}\n${request.message}` : request.title;
        context.pendingApprovals.set(requestId, { piId: request.id, requestType });
        yield* offerRuntimeEvent({
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(turnId ? { turnId } : {}),
          requestId: runtimeRequestId,
          type: "request.opened",
          payload: { requestType, detail: detail.slice(0, 2000), args: request },
          ...rawEvent("pi.rpc.extension-ui", request.method, request),
        });
        return;
      }

      const questionId = String(requestId);
      let question: UserInputQuestion;
      let numberedOptions: ReadonlyArray<string> | undefined;

      if (request.method === "select") {
        question = {
          id: questionId,
          header: request.title.slice(0, 12) || "Select",
          question: request.title,
          options: request.options.map((label) => ({ label, description: label })),
          multiSelect: false,
        };
      } else {
        const title = "title" in request ? request.title : "";
        const parsed = request.method === "input" ? parseNumberedList(title) : null;
        if (parsed) {
          numberedOptions = parsed.items;
          question = {
            id: questionId,
            header: parsed.title.slice(0, 12) || "Select",
            question: parsed.title,
            options: parsed.items.map((item) => ({ label: item, description: item })),
            multiSelect: true,
          };
        } else {
          question = {
            id: questionId,
            header: title.slice(0, 12) || "Input",
            question: title || "Input",
            options: [],
            multiSelect: false,
          };
        }
      }

      context.pendingUserInputs.set(requestId, {
        piId: request.id,
        questionId,
        method: request.method,
        ...(numberedOptions ? { numberedOptions } : {}),
      });

      yield* offerRuntimeEvent({
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(turnId ? { turnId } : {}),
        requestId: runtimeRequestId,
        type: "user-input.requested",
        payload: { questions: [question] },
        ...rawEvent("pi.rpc.extension-ui", request.method, request),
      });
    });

  const handleMessage = (
    context: PiSessionContext,
    message: PiStdoutMessage,
  ): Effect.Effect<void> => {
    switch (message._tag) {
      case "event":
        return handlePiEvent(context, message.event);
      case "extension-ui":
        return handleExtensionUIRequest(context, message.request);
      case "response":
        return Effect.void;
    }
  };

  // settle+clear pending extension-UI requests so Pi is never left blocked
  const cancelPendingExtensionRequests = (context: PiSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const [, pending] of context.pendingApprovals) {
        yield* Effect.ignore(
          context.transport.writeExtensionResponse({
            type: "extension_ui_response",
            id: pending.piId,
            confirmed: false,
          }),
        );
      }
      context.pendingApprovals.clear();
      for (const [, pending] of context.pendingUserInputs) {
        yield* Effect.ignore(
          context.transport.writeExtensionResponse({
            type: "extension_ui_response",
            id: pending.piId,
            cancelled: true,
          }),
        );
      }
      context.pendingUserInputs.clear();
    });

  const stopSessionInternal = (
    context: PiSessionContext,
    opts?: {
      readonly emitExitEvent?: boolean;
      readonly exitKind?: "graceful" | "error";
      readonly reason?: string;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;

      if (context.turnState) {
        yield* completeTurn(context, "interrupted", "Session stopped.");
      }

      yield* cancelPendingExtensionRequests(context);

      if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);

      yield* Effect.ignore(Scope.close(context.sessionScope, Exit.void));

      const updatedAt = yield* nowIso;
      const { activeTurnId: _activeTurnId, ...closedSession } = context.session;
      context.session = { ...closedSession, status: "closed", updatedAt };
      sessions.delete(context.session.threadId);

      if (opts?.emitExitEvent !== false) {
        const exitKind = opts?.exitKind ?? "graceful";
        const reason =
          opts?.reason ??
          (exitKind === "error" ? "Pi process exited unexpectedly." : "Session stopped");
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          ...stamp,
          type: "session.exited",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          payload: {
            reason,
            exitKind,
            ...(exitKind === "error" ? { recoverable: false } : {}),
          },
        });
      }
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(context);
  };

  // resolve attachments before mutating turn state so a bad one fails cleanly
  const resolvePromptImages = (
    attachments: ProviderSendTurnInput["attachments"],
  ): Effect.Effect<ReadonlyArray<PiImageContent>, ProviderAdapterError> =>
    Effect.forEach(attachments ?? [], (attachment) =>
      Effect.gen(function* () {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: `Failed to read attachment '${attachment.id}'.`,
                cause,
              }),
          ),
        );
        return piImageContentFromBytes({ mimeType: attachment.mimeType, bytes });
      }),
    );

  // switch only on change; fail closed (prompt not sent) on a bad slug or rejection
  const maybeSwitchPiModel = (
    context: PiSessionContext,
    requestedModel: string | undefined,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const plan = planPiModelSwitch(context.currentModel, requestedModel);
      if (plan.kind === "noop") return;
      if (plan.kind === "invalid") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Invalid Pi model slug '${plan.slug}'; expected 'provider/id'.`,
        });
      }
      const response = yield* context.transport.request(
        { type: "set_model", provider: plan.provider, modelId: plan.modelId },
        `pi-set-model-${yield* nextUuid}`,
        PI_MODEL_OPTIONS_TIMEOUT_MS,
      );
      if (!piResponseSucceeded(response, "set_model")) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: `Pi rejected model switch to '${plan.slug}'.`,
        });
      }
      context.currentModel = plan.slug;
      context.session = { ...context.session, model: plan.slug };
      // a model switch can reset the thinking level — force re-apply next turn
      context.appliedThinkingLevel = undefined;
    });

  const applyThinkingLevel = (
    context: PiSessionContext,
    modelSelection: ModelSelection | null | undefined,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const level = resolvePiThinkingLevel(modelSelection);
      if (level === undefined || level === context.appliedThinkingLevel) return;
      const response = yield* context.transport.request(
        { type: "set_thinking_level", level },
        `pi-set-thinking-${yield* nextUuid}`,
        PI_MODEL_OPTIONS_TIMEOUT_MS,
      );
      if (piResponseSucceeded(response, "set_thinking_level")) {
        context.appliedThinkingLevel = level;
      } else {
        yield* Effect.logWarning("pi.thinking.set-failed", {
          threadId: context.session.threadId,
          level,
        });
      }
    });

  const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(function* (input) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const existing = sessions.get(input.threadId);
    if (existing) {
      yield* stopSessionInternal(existing, { emitExitEvent: false }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pi.session.replace.stop-failed", { threadId: input.threadId, cause }),
        ),
      );
    }

    const startedAt = yield* nowIso;
    const threadId = input.threadId;
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;
    const resumeState = readPiResumeState(input.resumeCursor);
    const cwd = input.cwd ?? serverConfig.cwd;
    const thinkingLevel = resolvePiThinkingLevel(modelSelection);

    const spawnArgs: string[] = ["--mode", "rpc"];
    if (resumeState) spawnArgs.push("--session", resumeState.sessionFile);
    if (modelSelection?.model) spawnArgs.push("--model", modelSelection.model);
    if (thinkingLevel) spawnArgs.push("--thinking", thinkingLevel);

    // gate driven by runtimeMode; if required, must be provably active or we fail closed
    const approvalGate = approvalGateForRuntimeMode(input.runtimeMode);
    let processEnv = baseEnvironment;
    let verifyApprovalGate = false;
    if (approvalGate.gate) {
      if (!approvalExtensionAvailable || !approvalExtensionPath) {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail:
            "Tool approval is required for this runtime mode but the bundled approval gate is unavailable; refusing to start an ungated Pi session.",
        });
      }
      spawnArgs.push("--extension", approvalExtensionPath);
      processEnv = { ...baseEnvironment, T3_PI_APPROVAL_MODE: approvalGate.mode };
      verifyApprovalGate = true;
    }

    const sessionScope = yield* Scope.make();

    const makeTransport = options?.makeTransport ?? makePiRpcTransport;
    const transport = yield* makeTransport({
      binaryPath: piSettings.binaryPath || "pi",
      args: spawnArgs,
      cwd,
      env: processEnv,
      onExit: Effect.suspend(() => {
        const live = sessions.get(threadId);
        if (live && !live.stopped && live.session.status !== "closed") {
          return stopSessionInternal(live, { emitExitEvent: true, exitKind: "error" });
        }
        return Effect.void;
      }),
    }).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to start Pi RPC process."),
            cause,
          }),
      ),
      Effect.onError(() => Effect.ignore(Scope.close(sessionScope, Exit.void))),
    );

    const session: ProviderSession = {
      threadId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    const context: PiSessionContext = {
      session,
      sessionScope,
      transport,
      notificationFiber: undefined,
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      turnState: undefined,
      turns: [],
      stopped: false,
      currentModel: modelSelection?.model,
      appliedThinkingLevel: thinkingLevel,
    };
    sessions.set(threadId, context);

    const notificationFiber = yield* Stream.fromQueue(transport.messages).pipe(
      Stream.mapEffect((message) => handleMessage(context, message)),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.logError("Failed to process Pi runtime message.", { cause }),
      ),
      Effect.forkIn(sessionScope),
    );
    context.notificationFiber = notificationFiber;

    const stateResponse = yield* transport.request(
      { type: "get_state" },
      `pi-get-state-${yield* nextUuid}`,
      PI_STATE_TIMEOUT_MS,
    );
    const sessionFile = extractSessionFile(stateResponse);
    if (sessionFile !== undefined) {
      context.session = { ...context.session, resumeCursor: { sessionFile } };
    }

    // fail closed unless the gate extension registered its sentinel command
    if (verifyApprovalGate) {
      const commandsResponse = yield* transport.request(
        { type: "get_commands" },
        `pi-get-commands-${yield* nextUuid}`,
        PI_COMMANDS_TIMEOUT_MS,
      );
      if (!piResponseHasCommand(commandsResponse, PI_APPROVAL_SENTINEL_COMMAND)) {
        yield* stopSessionInternal(context, { emitExitEvent: false });
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail:
            "Tool approval is enabled but the approval gate failed to load; refusing to run an ungated Pi session.",
        });
      }
    }

    const startedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      ...startedStamp,
      type: "session.started",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      payload: {},
    });

    // session file is the provider-native thread id — publish for provider_thread_id parity
    if (sessionFile !== undefined) {
      const threadStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...threadStartedStamp,
        type: "thread.started",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId,
        payload: { providerThreadId: sessionFile },
      });
    }

    const configuredStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      ...configuredStamp,
      type: "session.configured",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      payload: {
        config: {
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        },
      },
    });

    const readyStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      ...readyStamp,
      type: "session.state.changed",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      payload: { state: "ready" },
    });

    return { ...context.session };
  });

  const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);

    const requestedModel =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection.model : undefined;
    const promptText = typeof input.input === "string" ? input.input : "";
    // resolve before mutating turn state so a bad attachment fails cleanly
    const images = yield* resolvePromptImages(input.attachments);

    if (promptText.length === 0 && images.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi turns require non-empty text or at least one attachment.",
      });
    }

    // a message mid-turn steers the running turn; otherwise it opens a fresh one
    const isMidTurn = context.turnState !== undefined;

    // only on a fresh turn — changing options mid-stream would race the active turn
    if (!isMidTurn) {
      yield* maybeSwitchPiModel(context, requestedModel);
      yield* applyThinkingLevel(context, input.modelSelection);
    }

    if (!context.turnState) {
      yield* openTurn(context);
    }

    const turnId = context.turnState!.turnId;

    yield* context.transport
      .writeCommand(buildPiTurnCommand({ isMidTurn, message: promptText, images }))
      .pipe(
        Effect.catchCause(() => completeTurn(context, "failed", "Failed to send message to Pi.")),
      );

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* Effect.ignore(context.transport.writeCommand({ type: "abort" }));
      // settle bridged requests so Pi isn't left blocked (matches Cursor)
      yield* cancelPendingExtensionRequests(context);
    },
  );

  const respondToRequest: PiAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision: ProviderApprovalDecision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Unknown pending approval request: ${requestId}.`,
        });
      }
      context.pendingApprovals.delete(requestId);

      const response: RpcExtensionUIResponse = buildPiApprovalResponse(pending.piId, decision);
      yield* context.transport.writeExtensionResponse(response);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        type: "request.resolved",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType: pending.requestType, decision },
      });
    },
  );

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn("respondToUserInput")(
    function* (threadId, requestId, answers: ProviderUserInputAnswers) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `Unknown pending user-input request: ${requestId}.`,
        });
      }
      context.pendingUserInputs.delete(requestId);

      const response: RpcExtensionUIResponse = buildPiUserInputResponse(pending, answers);

      yield* context.transport.writeExtensionResponse(response);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        type: "user-input.resolved",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers },
      });
    },
  );

  const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
    const context = yield* requireSession(threadId);
    return {
      threadId,
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    };
  });

  const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);

      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      // forking mid-stream is undefined — abort/finalize any live turn first
      if (context.turnState) {
        yield* Effect.ignore(context.transport.writeCommand({ type: "abort" }));
        yield* completeTurn(context, "interrupted", "Turn interrupted for rollback.");
      }

      const forkResponse = yield* context.transport.request(
        { type: "get_fork_messages" },
        `pi-fork-messages-${yield* nextUuid}`,
        PI_MESSAGES_TIMEOUT_MS,
      );
      const userMessages = extractForkMessages(forkResponse);
      const target = resolveForkTargetEntryId(userMessages, numTurns);

      if (target === null) {
        // no known Pi history to fork against; just trim the local skeleton
        context.turns.splice(Math.max(0, context.turns.length - numTurns));
        return yield* readThread(threadId);
      }

      // fork branches before the target message; new_session resets past the first
      const rollbackResponse =
        target.kind === "fork"
          ? yield* context.transport.request(
              { type: "fork", entryId: target.entryId },
              `pi-fork-${yield* nextUuid}`,
              PI_FORK_TIMEOUT_MS,
            )
          : yield* context.transport.request(
              { type: "new_session" },
              `pi-new-session-${yield* nextUuid}`,
              PI_FORK_TIMEOUT_MS,
            );
      if (!piForkSucceeded(rollbackResponse)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: target.kind === "fork" ? "fork" : "new_session",
          detail: "Pi rejected or cancelled the rollback.",
        });
      }

      // CRITICAL: fork/new_session rebinds to a new session file — refresh the
      // resume cursor or a later reconnect resumes the stale pre-rollback branch
      const stateResponse = yield* context.transport.request(
        { type: "get_state" },
        `pi-get-state-${yield* nextUuid}`,
        PI_STATE_TIMEOUT_MS,
      );
      const sessionFile = extractSessionFile(stateResponse);
      const updatedAt = yield* nowIso;
      context.session = {
        ...context.session,
        status: "ready",
        updatedAt,
        ...(sessionFile !== undefined ? { resumeCursor: { sessionFile } } : {}),
      };

      context.turns.splice(Math.max(0, context.turns.length - numTurns));

      return yield* readThread(threadId);
    },
  );

  const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(function* (threadId) {
    const context = yield* requireSession(threadId);
    yield* stopSessionInternal(context, { emitExitEvent: true });
  });

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) => stopSessionInternal(context, { emitExitEvent: true }),
      {
        discard: true,
      },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) => stopSessionInternal(context, { emitExitEvent: false }),
      {
        discard: true,
      },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" as const },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies PiAdapterShape;
});
