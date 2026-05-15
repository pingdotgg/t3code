import { randomUUID } from "node:crypto";
import {
  AutonomyLevel,
  type AskUserRequestParams,
  type AskUserResult,
  type Base64ImageSource,
  type ContentBlock,
  createSession,
  type CreateSessionOptions,
  DroidInteractionMode,
  DroidMessageType,
  type MessageOptions,
  ReasoningEffort,
  resumeSession,
  type ResumeSessionOptions,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type DroidMessage,
  type DroidSession,
  type RequestPermissionRequestParams,
  type TokenUsageUpdate,
} from "@factory/droid-sdk";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type CanonicalRequestType,
  type DroidSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("droid");

interface PendingPermission {
  readonly requestType: CanonicalRequestType;
  readonly resolve: (decision: ToolConfirmationOutcome) => void;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly droidQuestions: AskUserRequestParams["questions"];
  readonly resolve: (result: AskUserResult) => void;
}

interface DroidContext {
  session: ProviderSession;
  readonly droid: DroidSession;
  readonly pendingPermissions: Map<ApprovalRequestId, PendingPermission>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeAbort: AbortController | undefined;
  activeAssistantItems: Map<string, string>;
  activeCompletedAssistantItems: Set<string>;
  activeTokenUsage: TokenUsageUpdate | undefined;
}

export interface DroidAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly sdk?: {
    readonly createSession: (options?: CreateSessionOptions) => Promise<DroidSession>;
    readonly resumeSession: (
      sessionId: string,
      options?: ResumeSessionOptions,
    ) => Promise<DroidSession>;
  };
}

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
const eventId = () => EventId.make(randomUUID());
const SUPPORTED_DROID_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
type SupportedDroidImageMimeType = (typeof SUPPORTED_DROID_IMAGE_MIME_TYPES)[number];
const isSupportedDroidImageMimeType = (value: string): value is SupportedDroidImageMimeType =>
  (SUPPORTED_DROID_IMAGE_MIME_TYPES as ReadonlyArray<string>).includes(value);

function updateContextSession(context: DroidContext, patch: Partial<ProviderSession>) {
  context.session = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  };
}

function toModelId(model: string | undefined): string | undefined {
  return !model || model === "default" ? undefined : model;
}

function toReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  switch (value) {
    case "none":
      return ReasoningEffort.None;
    case "dynamic":
      return ReasoningEffort.Dynamic;
    case "off":
      return ReasoningEffort.Off;
    case "minimal":
      return ReasoningEffort.Minimal;
    case "low":
      return ReasoningEffort.Low;
    case "medium":
      return ReasoningEffort.Medium;
    case "high":
      return ReasoningEffort.High;
    case "xhigh":
      return ReasoningEffort.ExtraHigh;
    case "max":
      return ReasoningEffort.Max;
    default:
      return undefined;
  }
}

function toAutonomyLevel(input: ProviderSessionStartInput): AutonomyLevel {
  switch (input.runtimeMode) {
    case "approval-required":
      return AutonomyLevel.Off;
    case "auto-accept-edits":
      return AutonomyLevel.Low;
    case "medium-access":
      return AutonomyLevel.Medium;
    case "full-access":
      return AutonomyLevel.High;
  }
}

function contentBlockText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  return "";
}

function toRequestType(params: RequestPermissionRequestParams): CanonicalRequestType {
  const type = params.toolUses[0]?.confirmationType;
  switch (type) {
    case ToolConfirmationType.Execute:
      return "command_execution_approval";
    case ToolConfirmationType.Edit:
    case ToolConfirmationType.Create:
    case ToolConfirmationType.ApplyPatch:
      return "file_change_approval";
    case ToolConfirmationType.McpTool:
      return "dynamic_tool_call";
    case ToolConfirmationType.AskUser:
      return "tool_user_input";
    default:
      return "unknown";
  }
}

function toToolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("exec") ||
    normalized.includes("bash") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

function permissionDetail(params: RequestPermissionRequestParams): string {
  const first = params.toolUses[0];
  if (!first) return "Droid requested permission.";
  const details = first.details;
  switch (details.type) {
    case ToolConfirmationType.Execute:
      return details.fullCommand;
    case ToolConfirmationType.Edit:
    case ToolConfirmationType.Create:
    case ToolConfirmationType.ApplyPatch:
      return "filePath" in details ? details.filePath : "Droid requested a file change.";
    case ToolConfirmationType.McpTool:
      return details.toolName;
    default:
      return first.toolUse.name;
  }
}

function normalizeAskUserQuestions(params: AskUserRequestParams): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question, index) => ({
    id: `question-${question.index ?? index}`,
    header: question.topic || `Question ${index + 1}`,
    question: question.question,
    options: question.options.map((option) => ({
      label: option,
      description: option,
    })),
  }));
}

function answerString(value: unknown): string {
  if (Array.isArray(value)) return value.map(answerString).join(", ");
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

function toAskUserResult(
  questions: AskUserRequestParams["questions"],
  answers: ProviderUserInputAnswers,
): AskUserResult {
  return {
    answers: questions.map((question, index) => ({
      index: question.index,
      question: question.question,
      answer: answerString(
        answers[`question-${question.index ?? index}`] ?? answers[question.question],
      ),
    })),
  };
}

function toOutcome(decision: ProviderApprovalDecision): ToolConfirmationOutcome {
  switch (decision) {
    case "accept":
      return ToolConfirmationOutcome.ProceedOnce;
    case "acceptForSession":
      return ToolConfirmationOutcome.ProceedAlways;
    case "decline":
    case "cancel":
      return ToolConfirmationOutcome.Cancel;
  }
}

function toTokenUsageSnapshot(usage: TokenUsageUpdate) {
  const inputTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const outputTokens = usage.outputTokens + usage.thinkingTokens;
  return {
    usedTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: usage.cacheReadTokens,
    outputTokens,
    reasoningOutputTokens: usage.thinkingTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: usage.cacheReadTokens,
    lastOutputTokens: outputTokens,
    lastReasoningOutputTokens: usage.thinkingTokens,
  };
}

export function makeDroidAdapter(settings: DroidSettings, options?: DroidAdapterOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const sdk = options?.sdk ?? { createSession, resumeSession };
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("droid");
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, DroidContext>();
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...options?.environment }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) =>
            Effect.tryPromise(() => {
              context.activeAbort?.abort();
              return context.droid.close();
            }).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        );
        yield* Queue.shutdown(runtimeEvents);
      }),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const emitNow = (event: ProviderRuntimeEvent) => runPromise(emit(event));
    const eventBase = (
      context: DroidContext,
      input?: {
        turnId?: TurnId;
        itemId?: string;
        requestId?: string;
        raw?: unknown;
      },
    ) => ({
      eventId: eventId(),
      provider: PROVIDER,
      providerInstanceId: instanceId,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      ...(input?.turnId ? { turnId: input.turnId } : {}),
      ...(input?.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
      ...(input?.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
      ...(input?.raw !== undefined
        ? { raw: { source: "droid.sdk.message" as const, payload: input.raw } }
        : {}),
    });
    const requireSession = Effect.fn("requireDroidSession")(function* (threadId: ThreadId) {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    });

    type DroidAdapterShape = ProviderAdapterShape<ProviderAdapterError>;
    const resolveImages = Effect.fn("resolveDroidImages")(function* (
      input: NonNullable<Parameters<DroidAdapterShape["sendTurn"]>[0]["attachments"]>,
    ) {
      return yield* Effect.forEach(
        input,
        (attachment) =>
          Effect.gen(function* () {
            if (!isSupportedDroidImageMimeType(attachment.mimeType)) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/start",
                detail: `Unsupported Droid image attachment type '${attachment.mimeType}'.`,
              });
            }
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/start",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "turn/start",
                    detail: `Failed to read attachment file: ${cause.message}.`,
                    cause,
                  }),
              ),
            );
            return {
              type: "base64",
              data: Buffer.from(bytes).toString("base64"),
              mediaType: attachment.mimeType,
            } satisfies Base64ImageSource;
          }),
        { concurrency: 1 },
      );
    });

    const startSession: DroidAdapterShape["startSession"] = Effect.fn("startDroidSession")(
      function* (input) {
        let contextRef: DroidContext | undefined;
        const permissionHandler = (params: RequestPermissionRequestParams) =>
          new Promise<ToolConfirmationOutcome>((resolve) => {
            const context = contextRef;
            if (!context) {
              resolve(ToolConfirmationOutcome.Cancel);
              return;
            }
            const requestId = ApprovalRequestId.make(`droid-${randomUUID()}`);
            const requestType = toRequestType(params);
            context.pendingPermissions.set(requestId, { requestType, resolve });
            void emitNow({
              ...eventBase(context, { requestId, raw: params }),
              raw: { source: "droid.sdk.permission", payload: params },
              type: "request.opened",
              payload: {
                requestType,
                detail: permissionDetail(params),
                args: params,
              },
            });
          });
        const askUserHandler = (params: AskUserRequestParams) =>
          new Promise<AskUserResult>((resolve) => {
            const context = contextRef;
            if (!context) {
              resolve({ cancelled: true, answers: [] });
              return;
            }
            const requestId = ApprovalRequestId.make(`droid-question-${randomUUID()}`);
            const questions = normalizeAskUserQuestions(params);
            context.pendingUserInputs.set(requestId, {
              questions,
              droidQuestions: params.questions,
              resolve,
            });
            void emitNow({
              ...eventBase(context, { requestId, raw: params }),
              raw: { source: "droid.sdk.permission", payload: params },
              type: "user-input.requested",
              payload: { questions },
            });
          });
        const modelSelection = input.modelSelection;
        const modelId = toModelId(modelSelection?.model);
        const sdkOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          execPath: settings.binaryPath,
          env,
          permissionHandler,
          askUserHandler,
        };
        const reasoningEffort = toReasoningEffort(
          getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"),
        );
        const droid = yield* Effect.tryPromise({
          try: () =>
            typeof input.resumeCursor === "string"
              ? sdk.resumeSession(input.resumeCursor, sdkOptions)
              : sdk.createSession({
                  ...sdkOptions,
                  ...(modelId ? { modelId } : {}),
                  autonomyLevel: toAutonomyLevel(input),
                  interactionMode: DroidInteractionMode.Auto,
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "createSession",
              detail: cause instanceof Error ? cause.message : "Failed to start Droid session.",
              cause,
            }),
        });
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          model: modelSelection?.model ?? "default",
          threadId: input.threadId,
          resumeCursor: droid.sessionId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        const context: DroidContext = {
          session,
          droid,
          pendingPermissions: new Map(),
          pendingUserInputs: new Map(),
          turns: [],
          activeAbort: undefined,
          activeAssistantItems: new Map(),
          activeCompletedAssistantItems: new Set(),
          activeTokenUsage: undefined,
        };
        contextRef = context;
        sessions.set(input.threadId, context);

        yield* emit({
          ...eventBase(context),
          type: "session.started",
          payload: { message: "Droid SDK session started" },
        });
        yield* emit({
          ...eventBase(context),
          type: "thread.started",
          payload: { providerThreadId: droid.sessionId },
        });
        return session;
      },
    );

    const handleMessage = async (context: DroidContext, turnId: TurnId, message: DroidMessage) => {
      const base = (itemId?: string) =>
        eventBase(context, { turnId, raw: message, ...(itemId ? { itemId } : {}) });
      switch (message.type) {
        case DroidMessageType.AssistantTextDelta:
        case DroidMessageType.ThinkingTextDelta: {
          const itemId = `${message.messageId}-${message.blockIndex}`;
          const streamKind: RuntimeContentStreamKind =
            message.type === DroidMessageType.AssistantTextDelta
              ? "assistant_text"
              : "reasoning_text";
          if (streamKind === "assistant_text") {
            context.activeAssistantItems.set(
              itemId,
              `${context.activeAssistantItems.get(itemId) ?? ""}${message.text}`,
            );
          }
          return emitNow({
            ...base(itemId),
            type: "content.delta",
            payload: { streamKind, delta: message.text },
          });
        }
        case DroidMessageType.CreateMessage: {
          if (message.role !== "assistant") {
            return;
          }
          for (const [index, block] of message.content.entries()) {
            const text = contentBlockText(block);
            if (text.length === 0) {
              continue;
            }
            const itemId = block.id ?? `${message.messageId}-${index}`;
            if (block.type === "text") {
              const previousText = context.activeAssistantItems.get(itemId) ?? "";
              const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text;
              if (delta.length > 0) {
                await emitNow({
                  ...base(itemId),
                  type: "content.delta",
                  payload: { streamKind: "assistant_text", delta },
                });
              }
              context.activeAssistantItems.set(itemId, text);
              continue;
            }
            if (block.type === "thinking") {
              await emitNow({
                ...base(itemId),
                type: "content.delta",
                payload: { streamKind: "reasoning_text", delta: text },
              });
            }
          }

          const firstTextIndex = message.content.findIndex((block) => block.type === "text");
          const firstTextBlock = message.content[firstTextIndex];
          const completedItemId =
            firstTextBlock?.id ??
            (firstTextIndex >= 0 ? `${message.messageId}-${firstTextIndex}` : message.messageId);
          if (!context.activeCompletedAssistantItems.has(completedItemId)) {
            context.activeCompletedAssistantItems.add(completedItemId);
            return emitNow({
              ...base(completedItemId),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                ...(firstTextBlock ? { detail: contentBlockText(firstTextBlock) } : {}),
              },
            });
          }
          return;
        }
        case DroidMessageType.ToolUse:
          return emitNow({
            ...base(message.toolUseId),
            type: "item.started",
            payload: {
              itemType: toToolItemType(message.toolName),
              status: "inProgress",
              title: message.toolName,
              data: message.toolInput,
            },
          });
        case DroidMessageType.ToolProgress:
          return emitNow({
            ...base(message.toolUseId),
            type: "item.updated",
            payload: {
              itemType: toToolItemType(message.toolName),
              status: "inProgress",
              title: message.toolName,
              detail: message.content,
              data: message.update,
            },
          });
        case DroidMessageType.ToolResult:
          return emitNow({
            ...base(message.toolUseId),
            type: "item.completed",
            payload: {
              itemType: toToolItemType(message.toolName),
              status: message.isError ? "failed" : "completed",
              title: message.toolName,
              detail:
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
            },
          });
        case DroidMessageType.WorkingStateChanged:
          return emitNow({
            ...base(),
            type: "session.state.changed",
            payload: {
              state:
                message.state === "idle"
                  ? "ready"
                  : message.state.includes("waiting")
                    ? "waiting"
                    : "running",
              detail: message,
            },
          });
        case DroidMessageType.TokenUsageUpdate:
          context.activeTokenUsage = message;
          return emitNow({
            ...base(),
            type: "thread.token-usage.updated",
            payload: { usage: toTokenUsageSnapshot(message) },
          });
        case DroidMessageType.SessionTitleUpdated:
          return emitNow({
            ...base(),
            type: "thread.metadata.updated",
            payload: { name: message.title },
          });
        case DroidMessageType.SettingsUpdated:
          return emitNow({
            ...base(),
            type: "session.configured",
            payload: { config: message.settings },
          });
        case DroidMessageType.McpStatusChanged:
          return emitNow({
            ...base(),
            type: "mcp.status.updated",
            payload: { status: message },
          });
        case DroidMessageType.McpAuthRequired:
          return emitNow({
            ...base(),
            type: "auth.status",
            payload: { isAuthenticating: true, output: [message.message] },
          });
        case DroidMessageType.McpAuthCompleted:
          return emitNow({
            ...base(),
            type: "mcp.oauth.completed",
            payload: {
              success: message.outcome === "success",
              name: message.serverName,
              ...(message.outcome === "success" ? {} : { error: message.message }),
            },
          });
        case DroidMessageType.Error:
          return emitNow({
            ...base(),
            type: "runtime.error",
            payload: { message: message.message, class: "provider_error" },
          });
        case DroidMessageType.TurnComplete:
          if (message.tokenUsage) context.activeTokenUsage = message.tokenUsage;
          return Promise.resolve();
        default:
          return Promise.resolve();
      }
    };

    const sendTurn: DroidAdapterShape["sendTurn"] = Effect.fn("sendDroidTurn")(function* (input) {
      const context = sessions.get(input.threadId);
      if (!context) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Unknown Droid thread: ${input.threadId}`,
        });
      }
      const text = input.input?.trim();
      const images = yield* resolveImages(input.attachments ?? []);
      if (!text && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Droid turns require text input or at least one attachment.",
        });
      }

      const turnId = TurnId.make(`droid-turn-${randomUUID()}`);
      const abort = new AbortController();
      context.activeAbort = abort;
      context.activeAssistantItems = new Map();
      context.activeCompletedAssistantItems = new Set();
      context.activeTokenUsage = undefined;
      context.turns.push({ id: turnId, items: [] });
      updateContextSession(context, {
        status: "running",
        activeTurnId: turnId,
        model: input.modelSelection?.model ?? context.session.model,
      });

      yield* emit({
        ...eventBase(context, { turnId }),
        type: "turn.started",
        payload: { model: context.session.model },
      });

      yield* Effect.promise(async () => {
        try {
          const modelId = toModelId(input.modelSelection?.model);
          const reasoningEffort = toReasoningEffort(
            getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort"),
          );
          if (input.interactionMode === "plan") {
            await context.droid.enterSpecMode({
              ...(modelId ? { specModeModelId: modelId } : {}),
              ...(reasoningEffort ? { specModeReasoningEffort: reasoningEffort } : {}),
            });
          }
          if (modelId || reasoningEffort) {
            await context.droid.updateSettings({
              ...(modelId ? { modelId } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
              ...(input.interactionMode === "plan" && modelId ? { specModeModelId: modelId } : {}),
              ...(input.interactionMode === "plan" && reasoningEffort
                ? { specModeReasoningEffort: reasoningEffort }
                : {}),
            });
          }
          const messageOptions: MessageOptions = {
            abortSignal: abort.signal,
            ...(images.length > 0 ? { images } : {}),
          };
          for await (const message of context.droid.stream(
            text || "Please respond to the attached image.",
            messageOptions,
          )) {
            await handleMessage(context, turnId, message);
          }
          for (const [itemId, detail] of context.activeAssistantItems) {
            if (context.activeCompletedAssistantItems.has(itemId)) {
              continue;
            }
            await emitNow({
              ...eventBase(context, { turnId, itemId }),
              type: "item.completed",
              payload: { itemType: "assistant_message", status: "completed", detail },
            });
          }
          updateContextSession(context, { status: "ready", activeTurnId: undefined });
          await emitNow({
            ...eventBase(context, { turnId }),
            type: "turn.completed",
            payload: {
              state: "completed",
              ...(context.activeTokenUsage ? { usage: context.activeTokenUsage } : {}),
            },
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "Droid turn failed.";
          updateContextSession(context, {
            status: "error",
            activeTurnId: undefined,
            lastError: message,
          });
          await emitNow({
            ...eventBase(context, { turnId }),
            type: "runtime.error",
            payload: { message, class: "provider_error" },
          });
          await emitNow({
            ...eventBase(context, { turnId }),
            type: "turn.completed",
            payload: { state: "failed", errorMessage: message },
          });
        }
      }).pipe(Effect.forkDetach);

      return { threadId: input.threadId, turnId, resumeCursor: context.droid.sessionId };
    });

    const stopSession = (threadId: ThreadId) =>
      Effect.promise(async () => {
        const context = sessions.get(threadId);
        if (!context) return;
        sessions.delete(threadId);
        context.activeAbort?.abort();
        await context.droid.close();
        await emitNow({
          ...eventBase(context),
          type: "session.exited",
          payload: { reason: "Session stopped", recoverable: false, exitKind: "graceful" },
        });
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        Effect.promise(async () => {
          const context = sessions.get(threadId);
          context?.activeAbort?.abort();
          await context?.droid.interrupt();
        }),
      respondToRequest: (threadId, requestId, decision) =>
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          const pending = context?.pendingPermissions.get(requestId);
          if (!context || !pending) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToRequest",
              detail: `Unknown pending Droid permission request: ${requestId}`,
            });
          }
          context.pendingPermissions.delete(requestId);
          pending.resolve(toOutcome(decision));
          yield* emit({
            ...eventBase(context, { requestId }),
            type: "request.resolved",
            payload: { requestType: pending.requestType, decision },
          });
        }),
      respondToUserInput: (threadId, requestId, answers) =>
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          const pending = context?.pendingUserInputs.get(requestId);
          if (!context || !pending) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToUserInput",
              detail: `Unknown pending Droid user-input request: ${requestId}`,
            });
          }
          context.pendingUserInputs.delete(requestId);
          pending.resolve(toAskUserResult(pending.droidQuestions, answers));
          yield* emit({
            ...eventBase(context, { requestId }),
            type: "user-input.resolved",
            payload: { answers },
          });
        }),
      stopSession,
      listSessions: () => Effect.succeed([...sessions.values()].map((context) => context.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          return { threadId, turns: context.turns };
        }),
      rollbackThread: (threadId, numTurns) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }
          const nextLength = Math.max(0, context.turns.length - numTurns);
          context.turns.splice(nextLength);
          return { threadId, turns: context.turns };
        }),
      stopAll: () =>
        Effect.forEach([...sessions.keys()], stopSession, {
          concurrency: "unbounded",
          discard: true,
        }),
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies DroidAdapterShape;
  });
}
