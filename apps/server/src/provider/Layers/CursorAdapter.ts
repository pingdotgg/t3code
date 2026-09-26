/**
 * CursorAdapter — Cursor sessions through the Cursor Agent SDK (`@cursor/sdk`).
 *
 * Each thread owns one local SDK agent. A turn is one SDK run, and the run's
 * `onDelta` updates become `ProviderRuntimeEvent`s. The SDK has no approval or
 * question callbacks, so runtime modes map to Cursor's sandbox and Auto-review.
 *
 * @module CursorAdapter
 */
import type {
  AgentOptions,
  InteractionUpdate,
  McpServerConfig,
  RunResult,
  SDKUserMessage,
  SettingSource,
  ToolCall,
} from "@cursor/sdk";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  EventId,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type RuntimeMode,
  type ThreadId,
  type ToolLifecycleItemType,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { CursorTransportFailure } from "../acp/CursorTransportFailure.ts";
import {
  CursorAgentSdkRunnerError,
  type CursorAgentSdkRun,
  type CursorAgentSdkRunnerShape,
  type CursorAgentSdkSession,
} from "../CursorAgentSdk.ts";
import { cursorSdkModelSelection } from "../cursorSdkModel.ts";
import {
  discoverCursorSkills,
  hasCursorSkillMention,
  rewriteCursorSkillMentions,
} from "../Drivers/CursorSkills.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { CURSOR_WINDOWS_SANDBOX_MESSAGE } from "./CursorProvider.ts";

const PROVIDER = ProviderDriverKind.make("cursor");
/** Version 1 cursors hold a Cursor CLI (ACP) session id. The SDK cannot resume those. */
const CURSOR_RESUME_VERSION = 2 as const;
const TOOL_OUTPUT_MAX_CHARS = 8_000;

/**
 * Every Cursor settings layer the Cursor CLI loads: project and user rules,
 * skills, hooks, and MCP servers, team and MDM admin policy, and account
 * plugins. The SDK loads none of them when `settingSources` is omitted.
 * Sandbox policy files are read either way, and hooks can only deny or ask
 * (which local SDK runs reject), so these layers do not loosen the sandbox or
 * approval mode T3 sets.
 */
const CURSOR_AGENT_SETTING_SOURCES = [
  "project",
  "user",
  "team",
  "mdm",
  "plugins",
] as const satisfies ReadonlyArray<SettingSource>;

export interface CursorAdapterLiveOptions {
  /** Opens SDK agents. The driver binds it to the instance credential. */
  readonly runner: CursorAgentSdkRunnerShape;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`cursor`).
   */
  readonly instanceId?: ProviderInstanceId;
}

interface CursorTurn {
  readonly turnId: TurnId;
  run: CursorAgentSdkRun | undefined;
  readonly completed: Deferred.Deferred<void>;
  /** Detects a reply that is only a Cursor transport error dump. */
  readonly assistantReply: CursorTransportFailure;
  assistantItemId: RuntimeItemId | undefined;
  reasoningItemId: RuntimeItemId | undefined;
  itemCount: number;
  sawAssistantText: boolean;
  /** Open tool calls by SDK call id, with the payload last sent for each. */
  readonly tools: Map<string, CursorToolPayload>;
  lastTodoFingerprint: string | undefined;
  interrupted: boolean;
  finalized: boolean;
}

interface CursorSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  modelSelection: ModelSelection;
  readonly scope: Scope.Closeable;
  readonly agent: CursorAgentSdkSession;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurn: CursorTurn | undefined;
  cursorSkillNames: ReadonlySet<string> | undefined;
  stopped: boolean;
}

type CursorToolPayload = ReturnType<typeof cursorToolPayload>;

type TurnOutcome =
  | { readonly state: "completed" | "cancelled" | "interrupted" }
  | {
      readonly state: "failed";
      readonly errorMessage: string;
      readonly errorClass: "provider_error" | "transport_error";
    };

function parseCursorResume(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const schemaVersion: unknown = Reflect.get(raw, "schemaVersion");
  const agentId: unknown = Reflect.get(raw, "agentId");
  return schemaVersion === CURSOR_RESUME_VERSION && typeof agentId === "string" && agentId.trim()
    ? agentId.trim()
    : undefined;
}

/** Full access turns the sandbox off. Supervised and Auto modes use Cursor's Auto-review. */
function cursorRuntimeAgentPolicy(runtimeMode: RuntimeMode) {
  return {
    autoReview: runtimeMode === "approval-required" || runtimeMode === "auto",
    sandboxEnabled: runtimeMode !== "full-access",
  };
}

function cursorMcpServers(threadId: ThreadId): Record<string, McpServerConfig> | undefined {
  const session = McpProviderSession.readMcpProviderSession(threadId);
  if (session === undefined) {
    return undefined;
  }
  return {
    "t3-code": {
      type: "http",
      url: session.endpoint,
      headers: {
        Authorization: session.authorizationHeader,
      },
    },
  };
}

function makeCursorAgentOptions(input: {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly threadId: ThreadId;
}): AgentOptions {
  const policy = cursorRuntimeAgentPolicy(input.runtimeMode);
  const mcpServers = cursorMcpServers(input.threadId);
  return {
    model: cursorSdkModelSelection(input.modelSelection),
    name: `T3 Code ${input.threadId}`,
    mode: "agent",
    local: {
      cwd: input.cwd,
      autoReview: policy.autoReview,
      settingSources: [...CURSOR_AGENT_SETTING_SOURCES],
      sandboxOptions: { enabled: policy.sandboxEnabled },
      enableAgentRetries: true,
    },
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

function cursorToolFailed(toolCall: ToolCall): boolean {
  if (toolCall.result?.status === "error") {
    return true;
  }
  return toolCall.type === "mcp" && toolCall.result?.status === "success"
    ? toolCall.result.value.isError
    : false;
}

function cursorToolName(toolCall: Extract<ToolCall, { readonly type: "mcp" }>): string {
  const provider = toolCall.args.providerIdentifier ?? "mcp";
  const tool = toolCall.args.toolName ?? "unknown";
  return `mcp__${provider}__${tool}`;
}

function cursorToolSearchPattern(toolCall: ToolCall): string | undefined {
  switch (toolCall.type) {
    case "glob":
      return toolCall.args.globPattern;
    case "grep":
      return toolCall.args.pattern;
    case "semSearch":
      return toolCall.args.query;
    case "ls":
      return toolCall.args.path;
    case "readLints":
      return toolCall.args.paths.join(", ");
    default:
      return undefined;
  }
}

/** Keep the tail: it holds the exit status and the most recent output. */
function boundToolOutput(text: string): string {
  return text.length <= TOOL_OUTPUT_MAX_CHARS
    ? text
    : `[Earlier output truncated]\n\n${text.slice(text.length - TOOL_OUTPUT_MAX_CHARS)}`;
}

/**
 * Tool rows use the same data keys as the other V1 adapters (`kind`,
 * `command`, `rawInput`, `rawOutput`), so clients label and group them
 * without Cursor-specific code. Large payloads such as file contents stay out.
 */
function cursorToolPresentation(toolCall: ToolCall): {
  readonly itemType: ToolLifecycleItemType;
  readonly title: string;
  readonly detail: string | undefined;
  readonly data: Record<string, unknown>;
} {
  switch (toolCall.type) {
    case "shell":
      return {
        itemType: "command_execution",
        title: "Ran command",
        detail: toolCall.args.command,
        data: {
          kind: "execute",
          command: toolCall.args.command,
          rawInput: toolCall.args,
          ...(toolCall.result?.status === "success"
            ? {
                rawOutput: {
                  exitCode: toolCall.result.value.exitCode,
                  stdout: boundToolOutput(toolCall.result.value.stdout),
                  stderr: boundToolOutput(toolCall.result.value.stderr),
                },
              }
            : {}),
        },
      };
    case "read":
      return {
        itemType: "dynamic_tool_call",
        title: "Read file",
        detail: toolCall.args.path,
        data: { kind: "read", rawInput: { path: toolCall.args.path } },
      };
    case "write":
    case "edit":
    case "delete":
    case "generateImage": {
      const path = toolCall.type === "generateImage" ? toolCall.args.filePath : toolCall.args.path;
      return {
        itemType: "file_change",
        title: "Changed files",
        detail: path,
        data: {
          kind: toolCall.type === "delete" ? "delete" : "edit",
          ...(path === undefined ? {} : { rawInput: { path } }),
        },
      };
    }
    case "glob":
    case "grep":
    case "ls":
    case "readLints":
    case "semSearch":
      return {
        itemType: "dynamic_tool_call",
        title: "Searched files",
        detail: cursorToolSearchPattern(toolCall),
        data: { kind: "search", rawInput: toolCall.args },
      };
    case "mcp": {
      const toolName = cursorToolName(toolCall);
      return {
        itemType: "mcp_tool_call",
        title: toolName,
        detail: undefined,
        data: { toolName, rawInput: toolCall.args.args ?? {} },
      };
    }
    case "task":
      return {
        itemType: "collab_agent_tool_call",
        title: toolCall.args.description.trim() || "Subagent",
        detail: toolCall.args.prompt,
        data: {
          rawInput: { description: toolCall.args.description, prompt: toolCall.args.prompt },
        },
      };
    default:
      return {
        itemType: "dynamic_tool_call",
        title: toolCall.type,
        detail: undefined,
        data: {},
      };
  }
}

function cursorToolPayload(callId: string, toolCall: ToolCall) {
  const { detail, data, ...presentation } = cursorToolPresentation(toolCall);
  const trimmedDetail = detail?.trim();
  return {
    ...presentation,
    ...(trimmedDetail ? { detail: trimmedDetail } : {}),
    data: { toolCallId: callId, ...data },
  };
}

function cursorTodoPlan(toolCall: Extract<ToolCall, { readonly type: "updateTodos" }>) {
  const todos =
    toolCall.result?.status === "success" ? toolCall.result.value.todos : toolCall.args.todos;
  return todos.flatMap((todo) => {
    const step = todo.content.trim();
    if (todo.status === "cancelled" || step.length === 0) return [];
    return [
      {
        step,
        status:
          todo.status === "inProgress"
            ? ("inProgress" as const)
            : todo.status === "completed"
              ? ("completed" as const)
              : ("pending" as const),
      },
    ];
  });
}

const isCursorAgentSdkRunnerError = Schema.is(CursorAgentSdkRunnerError);

/** The SDK wraps its own errors. Prefer the inner message so users see the real reason. */
function sdkFailureDetail(cause: unknown, fallback: string): string {
  const inner = isCursorAgentSdkRunnerError(cause) ? cause.cause : cause;
  const message = inner instanceof Error ? inner.message.trim() : "";
  return message || fallback;
}

export function makeCursorAdapter(options: CursorAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("cursor");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const platform = yield* HostProcessPlatform;

    const sessions = new Map<ThreadId, CursorSessionContext>();
    const threadLocks = new Map<ThreadId, Semaphore.Semaphore>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Cursor runtime identifier.",
            cause,
          }),
      ),
    );
    // Event ids must not fail inside SDK callbacks. A failure there would fail the run.
    const eventBase = (threadId: ThreadId, turnId?: TurnId) =>
      Effect.all({
        eventId: Effect.map(Effect.orDie(randomUUIDv4), EventId.make),
        createdAt: nowIso,
      }).pipe(
        Effect.map((stamp) => ({
          ...stamp,
          provider: PROVIDER,
          threadId,
          ...(turnId === undefined ? {} : { turnId }),
        })),
      );
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const existing = threadLocks.get(threadId);
        const semaphore = existing ?? Semaphore.makeUnsafe(1);
        if (!existing) threadLocks.set(threadId, semaphore);
        return semaphore.withPermit(effect);
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const completeAssistant = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      turn: CursorTurn,
    ) {
      if (turn.assistantItemId === undefined) return;
      yield* offerRuntimeEvent({
        type: "item.completed",
        ...(yield* eventBase(ctx.threadId, turn.turnId)),
        itemId: turn.assistantItemId,
        payload: { itemType: "assistant_message", status: "completed" },
      });
      turn.assistantItemId = undefined;
    });

    const completeReasoning = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      turn: CursorTurn,
    ) {
      if (turn.reasoningItemId === undefined) return;
      yield* offerRuntimeEvent({
        type: "item.completed",
        ...(yield* eventBase(ctx.threadId, turn.turnId)),
        itemId: turn.reasoningItemId,
        payload: { itemType: "reasoning", status: "completed" },
      });
      turn.reasoningItemId = undefined;
    });

    const appendAssistantText = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      turn: CursorTurn,
      text: string,
    ) {
      turn.sawAssistantText = true;
      if (turn.assistantItemId === undefined) {
        turn.itemCount += 1;
        turn.assistantItemId = RuntimeItemId.make(`${turn.turnId}:assistant:${turn.itemCount}`);
        yield* offerRuntimeEvent({
          type: "item.started",
          ...(yield* eventBase(ctx.threadId, turn.turnId)),
          itemId: turn.assistantItemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
      }
      yield* offerRuntimeEvent({
        type: "content.delta",
        ...(yield* eventBase(ctx.threadId, turn.turnId)),
        itemId: turn.assistantItemId,
        payload: { streamKind: "assistant_text", delta: text },
      });
    });

    const appendReasoningText = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      turn: CursorTurn,
      text: string,
    ) {
      if (turn.reasoningItemId === undefined) {
        turn.itemCount += 1;
        turn.reasoningItemId = RuntimeItemId.make(`${turn.turnId}:reasoning:${turn.itemCount}`);
      }
      yield* offerRuntimeEvent({
        type: "content.delta",
        ...(yield* eventBase(ctx.threadId, turn.turnId)),
        itemId: turn.reasoningItemId,
        payload: { streamKind: "reasoning_text", delta: text },
      });
    });

    const handleToolUpdate = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      turn: CursorTurn,
      update: Extract<
        InteractionUpdate,
        { readonly type: "tool-call-started" | "partial-tool-call" | "tool-call-completed" }
      >,
    ) {
      const completed = update.type === "tool-call-completed";
      const toolCall = update.toolCall;
      switch (toolCall.type) {
        case "createPlan": {
          const planMarkdown = toolCall.args.plan.trim();
          if (completed && planMarkdown.length > 0 && !cursorToolFailed(toolCall)) {
            yield* offerRuntimeEvent({
              type: "turn.proposed.completed",
              ...(yield* eventBase(ctx.threadId, turn.turnId)),
              payload: { planMarkdown },
            });
          }
          return;
        }
        case "updateTodos": {
          const plan = cursorTodoPlan(toolCall);
          const fingerprint = plan.map((step) => `${step.status}:${step.step}`).join("\n");
          if (fingerprint === turn.lastTodoFingerprint) return;
          turn.lastTodoFingerprint = fingerprint;
          yield* offerRuntimeEvent({
            type: "turn.plan.updated",
            ...(yield* eventBase(ctx.threadId, turn.turnId)),
            payload: { plan },
          });
          return;
        }
      }

      const payload = cursorToolPayload(update.callId, toolCall);
      const itemId = RuntimeItemId.make(update.callId);
      const open = turn.tools.get(update.callId);
      turn.tools.set(update.callId, payload);
      if (open === undefined) {
        yield* offerRuntimeEvent({
          type: "item.started",
          ...(yield* eventBase(ctx.threadId, turn.turnId)),
          itemId,
          payload: { ...payload, status: "inProgress" },
        });
      }
      if (completed) {
        turn.tools.delete(update.callId);
        yield* offerRuntimeEvent({
          type: "item.completed",
          ...(yield* eventBase(ctx.threadId, turn.turnId)),
          itemId,
          payload: { ...payload, status: cursorToolFailed(toolCall) ? "failed" : "completed" },
        });
        return;
      }
      // Partial updates stream arguments. Only a changed label is worth an event.
      if (open !== undefined && open.detail !== payload.detail) {
        yield* offerRuntimeEvent({
          type: "item.updated",
          ...(yield* eventBase(ctx.threadId, turn.turnId)),
          itemId,
          payload: { ...payload, status: "inProgress" },
        });
      }
    });

    const handleInteractionUpdate = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      turn: CursorTurn,
      update: InteractionUpdate,
    ) {
      if (turn.finalized) return;
      switch (update.type) {
        case "text-delta":
          if (update.text.length === 0) return;
          turn.assistantReply.push(update.text);
          yield* completeReasoning(ctx, turn);
          yield* appendAssistantText(ctx, turn, update.text);
          return;
        case "thinking-delta":
          if (update.text.length === 0) return;
          yield* completeAssistant(ctx, turn);
          yield* appendReasoningText(ctx, turn, update.text);
          return;
        case "thinking-completed":
          yield* completeReasoning(ctx, turn);
          return;
        case "tool-call-started":
        case "partial-tool-call":
        case "tool-call-completed":
          yield* completeAssistant(ctx, turn);
          yield* completeReasoning(ctx, turn);
          yield* handleToolUpdate(ctx, turn, update);
          return;
        case "step-completed":
        case "turn-ended":
          yield* completeAssistant(ctx, turn);
          yield* completeReasoning(ctx, turn);
          return;
        default:
          return;
      }
    });

    /** Ends the turn once. Later updates and a second finalize are ignored. */
    const finalizeTurn = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      turn: CursorTurn,
      outcome: TurnOutcome,
      result?: RunResult,
    ) {
      if (turn.finalized) return;
      turn.finalized = true;
      // The run stops sending updates now. Close tool rows it left open.
      for (const [callId, payload] of turn.tools) {
        yield* offerRuntimeEvent({
          type: "item.completed",
          ...(yield* eventBase(ctx.threadId, turn.turnId)),
          itemId: RuntimeItemId.make(callId),
          payload: { ...payload, status: "completed" },
        });
      }
      turn.tools.clear();
      yield* completeReasoning(ctx, turn);
      yield* completeAssistant(ctx, turn);
      if (outcome.state === "failed") {
        yield* offerRuntimeEvent({
          type: "runtime.error",
          ...(yield* eventBase(ctx.threadId, turn.turnId)),
          payload: { message: outcome.errorMessage, class: outcome.errorClass },
        });
      }
      yield* offerRuntimeEvent({
        type: "turn.completed",
        ...(yield* eventBase(ctx.threadId, turn.turnId)),
        payload: {
          state: outcome.state,
          ...(outcome.state === "failed" ? { errorMessage: outcome.errorMessage } : {}),
        },
      });
      ctx.turns.push({ id: turn.turnId, items: [result ?? outcome] });
      if (ctx.activeTurn === turn) {
        ctx.activeTurn = undefined;
        const { activeTurnId: _activeTurnId, ...session } = ctx.session;
        ctx.session = { ...session, updatedAt: yield* nowIso };
      }
      yield* Deferred.succeed(turn.completed, undefined);
    });

    const awaitRun = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      turn: CursorTurn,
      run: CursorAgentSdkRun,
    ) {
      const exit = yield* Effect.exit(run.wait);
      // A timed-out interrupt already ended this turn. A late final reply must
      // not open an assistant message that nothing completes.
      if (turn.finalized) return;
      if (Exit.isFailure(exit)) {
        if (turn.interrupted) {
          return yield* finalizeTurn(ctx, turn, { state: "interrupted" });
        }
        yield* Effect.logWarning("Cursor run failed.", {
          threadId: ctx.threadId,
          cause: exit.cause,
        });
        return yield* finalizeTurn(ctx, turn, {
          state: "failed",
          errorMessage: sdkFailureDetail(Cause.squash(exit.cause), "Cursor run failed."),
          errorClass: "transport_error",
        });
      }
      const result = exit.value;
      // Some runs report the reply only in the final result.
      const finalText = result.result?.trim();
      if (!turn.sawAssistantText && finalText) {
        turn.assistantReply.push(finalText);
        yield* appendAssistantText(ctx, turn, finalText);
      }
      const transportFailure = turn.assistantReply.failure;
      const outcome: TurnOutcome = turn.interrupted
        ? { state: "interrupted" }
        : transportFailure !== undefined
          ? { state: "failed", errorMessage: transportFailure, errorClass: "transport_error" }
          : result.status === "error"
            ? {
                state: "failed",
                errorMessage: result.error?.message.trim() || "Cursor run failed.",
                errorClass: "provider_error",
              }
            : { state: result.status === "cancelled" ? "cancelled" : "completed" };
      yield* finalizeTurn(ctx, turn, outcome, result);
    });

    const interruptTurnInternal = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      turn: CursorTurn,
    ) {
      turn.interrupted = true;
      if (turn.run !== undefined) {
        yield* turn.run.cancel.pipe(Effect.ignore({ log: true }));
      }
      const stopped = yield* Deferred.await(turn.completed).pipe(
        Effect.timeoutOption("10 seconds"),
      );
      if (Option.isNone(stopped)) {
        yield* Effect.logWarning("Cursor run did not stop after cancel.", {
          threadId: ctx.threadId,
        });
        yield* finalizeTurn(ctx, turn, { state: "interrupted" });
      }
    });

    const stopSessionInternal = Effect.fnUntraced(function* (ctx: CursorSessionContext) {
      if (ctx.stopped) return;
      ctx.stopped = true;
      const turn = ctx.activeTurn;
      if (turn !== undefined) {
        turn.interrupted = true;
        if (turn.run !== undefined) {
          yield* turn.run.cancel.pipe(Effect.ignore({ log: true }));
        }
        yield* finalizeTurn(ctx, turn, { state: "interrupted" });
      }
      // Closes the SDK agent and any run still being awaited.
      yield* Scope.close(ctx.scope, Exit.void);
      sessions.delete(ctx.threadId);
      yield* offerRuntimeEvent({
        type: "session.exited",
        ...(yield* eventBase(ctx.threadId)),
        payload: { exitKind: "graceful" },
      });
    });

    const buildUserMessage = Effect.fnUntraced(function* (
      ctx: CursorSessionContext,
      input: ProviderSendTurnInput,
      model: string,
    ) {
      // Cursor ingests images only. Other files reach the agent through the
      // path line ProviderService adds to the prompt.
      const images = yield* Effect.forEach(
        (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
        (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "run.start",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "run.start",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            return { data: Buffer.from(bytes).toString("base64"), mimeType: attachment.mimeType };
          }),
        { concurrency: 1 },
      );
      const rawText = input.input?.trim() ?? "";
      if (rawText === "/compress" && images.length === 0) {
        return rawText;
      }
      if (rawText.length === 0 && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }
      if (hasCursorSkillMention(rawText) && ctx.cursorSkillNames === undefined) {
        const skills = yield* discoverCursorSkills(ctx.session.cwd, options.environment).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        ctx.cursorSkillNames = new Set(
          skills
            .filter((skill) => skill.enabled && skill.userInvocable !== false)
            .map((skill) => skill.name),
        );
      }
      const prompt = ctx.cursorSkillNames
        ? rewriteCursorSkillMentions(rawText, ctx.cursorSkillNames)
        : rawText;
      const text = [prompt, buildRuntimeInstructions({ harness: "Cursor", model })]
        .filter((part) => part.length > 0)
        .join("\n\n");
      return images.length === 0 ? text : ({ text, images } satisfies SDKUserMessage);
    });

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          // The SDK would throw a generic error later. Fail with the fix instead.
          if (platform === "win32" && cursorRuntimeAgentPolicy(input.runtimeMode).sandboxEnabled) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: CURSOR_WINDOWS_SANDBOX_MESSAGE,
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const modelSelection: ModelSelection =
            input.modelSelection?.instanceId === boundInstanceId
              ? input.modelSelection
              : { instanceId: boundInstanceId, model: "auto" };
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          const openAgent = (agentId: string | undefined) =>
            options.runner.open({
              operation: agentId === undefined ? "create" : "resume",
              ...(agentId === undefined ? {} : { agentId }),
              options: makeCursorAgentOptions({
                modelSelection,
                runtimeMode: input.runtimeMode,
                cwd,
                threadId: input.threadId,
              }),
              threadId: input.threadId,
              providerSessionId: input.threadId,
            });
          const resumeAgentId = parseCursorResume(input.resumeCursor);
          const agent = yield* openAgent(resumeAgentId).pipe(
            // Cursor stores local agents per cwd. A thread that moved to
            // another cwd, or whose agent was deleted, cannot resume it and
            // would fail every restart. Start a new agent, like an old ACP cursor.
            Effect.catchIf(
              (error) =>
                resumeAgentId !== undefined &&
                error.cause instanceof Error &&
                error.cause.name === "AgentNotFoundError",
              () =>
                Effect.logWarning("Cursor agent not found. Starting a new agent.", {
                  threadId: input.threadId,
                  agentId: resumeAgentId,
                }).pipe(Effect.andThen(openAgent(undefined))),
            ),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.tap((agent) => Scope.addFinalizer(sessionScope, Effect.ignore(agent.close))),
            Effect.onError(() => Scope.close(sessionScope, Exit.void)),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: sdkFailureDetail(cause, "Could not open the Cursor agent."),
                  cause,
                }),
            ),
          );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection.model,
            threadId: input.threadId,
            resumeCursor: { schemaVersion: CURSOR_RESUME_VERSION, agentId: agent.agentId },
            createdAt: now,
            updatedAt: now,
          };
          sessions.set(input.threadId, {
            threadId: input.threadId,
            session,
            modelSelection,
            scope: sessionScope,
            agent,
            turns: [],
            activeTurn: undefined,
            cursorSkillNames: undefined,
            stopped: false,
          });

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* eventBase(input.threadId)),
            payload: {},
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* eventBase(input.threadId)),
            payload: { state: "ready", reason: "Cursor agent ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* eventBase(input.threadId)),
            payload: { providerThreadId: agent.agentId },
          });

          return session;
        }),
      );

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          // A Cursor run cannot take a new message. A steer interrupts the
          // active run and starts the message as the next turn.
          if (ctx.activeTurn !== undefined) {
            yield* interruptTurnInternal(ctx, ctx.activeTurn);
          }
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId
              ? input.modelSelection
              : ctx.modelSelection;
          const message = yield* buildUserMessage(ctx, input, modelSelection.model);
          const turnId = TurnId.make(yield* randomUUIDv4);
          const turn: CursorTurn = {
            turnId,
            run: undefined,
            completed: yield* Deferred.make<void>(),
            assistantReply: new CursorTransportFailure(),
            assistantItemId: undefined,
            reasoningItemId: undefined,
            itemCount: 0,
            sawAssistantText: false,
            tools: new Map(),
            lastTodoFingerprint: undefined,
            interrupted: false,
            finalized: false,
          };
          ctx.activeTurn = turn;
          ctx.modelSelection = modelSelection;
          ctx.session = {
            ...ctx.session,
            model: modelSelection.model,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };
          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* eventBase(ctx.threadId, turnId)),
            payload: { model: modelSelection.model },
          });

          const mcpServers = cursorMcpServers(ctx.threadId);
          const run = yield* ctx.agent
            .send({
              message,
              options: {
                model: cursorSdkModelSelection(modelSelection),
                mode: input.interactionMode === "plan" ? "plan" : "agent",
                ...(mcpServers === undefined ? {} : { mcpServers }),
              },
              onDelta: (update) => handleInteractionUpdate(ctx, turn, update),
            })
            .pipe(
              Effect.tapError((cause) =>
                finalizeTurn(ctx, turn, {
                  state: "failed",
                  errorMessage: sdkFailureDetail(cause, "Cursor could not start the run."),
                  errorClass: "provider_error",
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "run.start",
                    detail: sdkFailureDetail(cause, "Cursor could not start the run."),
                    cause,
                  }),
              ),
            );
          turn.run = run;
          if (turn.interrupted) {
            yield* run.cancel.pipe(Effect.ignore({ log: true }));
          }
          yield* awaitRun(ctx, turn, run).pipe(Effect.forkIn(ctx.scope));

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      );

    // A thread runs at most one Cursor turn, so interrupt whichever is active.
    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (ctx.activeTurn !== undefined) {
          yield* interruptTurnInternal(ctx, ctx.activeTurn);
        }
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: "Cursor does not send approval requests.",
        });
      });

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "Cursor does not ask structured questions.",
        });
      });

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Cursor agents do not support provider-side rollback.",
        });
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }).pipe(
        Effect.catchCause((cause) => Effect.logError("Failed to stop Cursor sessions.", { cause })),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      compaction: { type: "slash-command", command: "/compress" },
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
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies CursorAdapterShape;
  });
}
