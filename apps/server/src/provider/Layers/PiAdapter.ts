import {
  EventId,
  type PiSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");

type PiModule = typeof import("@earendil-works/pi-coding-agent");
type PiSession = InstanceType<PiModule["AgentSession"]>;
type PiModelRegistry = ReturnType<PiModule["ModelRegistry"]["create"]>;
type PiModel = ReturnType<PiModelRegistry["getAll"]>[number];
type PiEvent = Parameters<Parameters<PiSession["subscribe"]>[0]>[0];

interface PiResumeCursor {
  readonly sessionFile?: string;
  readonly sessionId?: string;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly piSession: PiSession;
  readonly modelRegistry: PiModelRegistry;
  unsubscribe: () => void;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
}

export interface PiAdapterOptions {
  readonly instanceId?: ProviderSession["providerInstanceId"];
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function parseResumeCursor(raw: unknown): PiResumeCursor | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const sessionFile =
    "sessionFile" in raw && typeof raw.sessionFile === "string" && raw.sessionFile.trim()
      ? raw.sessionFile.trim()
      : undefined;
  const sessionId =
    "sessionId" in raw && typeof raw.sessionId === "string" && raw.sessionId.trim()
      ? raw.sessionId.trim()
      : undefined;
  return sessionFile || sessionId
    ? {
        ...(sessionFile ? { sessionFile } : {}),
        ...(sessionId ? { sessionId } : {}),
      }
    : undefined;
}

function resolvePath(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? expandHomePath(trimmed) : undefined;
}

function getPiModelSlug(model: Pick<PiModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function resolvePiModel(registry: PiModelRegistry, slug: string | undefined): PiModel | undefined {
  const availableModels = registry.getAvailable();
  if (!slug?.trim()) return undefined;
  const trimmed = slug.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    const provider = trimmed.slice(0, slashIndex);
    const modelId = trimmed.slice(slashIndex + 1);
    return availableModels.find(
      (model: PiModel) => model.provider === provider && model.id === modelId,
    );
  }
  return availableModels.find(
    (model: PiModel) => model.id === trimmed || getPiModelSlug(model) === trimmed,
  );
}

function resolveDefaultPiModel(registry: PiModelRegistry): PiModel | undefined {
  return registry.getAvailable()[0];
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) return "command_execution";
  if (normalized.includes("edit") || normalized.includes("write")) return "file_change";
  if (normalized.includes("find") || normalized.includes("grep") || normalized.includes("ls")) {
    return "dynamic_tool_call";
  }
  return "dynamic_tool_call";
}

function eventDetail(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if ("errorMessage" in value && typeof value.errorMessage === "string") return value.errorMessage;
  if ("message" in value && typeof value.message === "string") return value.message;
  return undefined;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options?: PiAdapterOptions,
) {
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(Effect.orDie);
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiSessionContext>();
  const boundInstanceId = options?.instanceId;
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) => Queue.offer(runtimeEventQueue, event);

  const stamp = Effect.fn("stamp")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: string | undefined;
    readonly requestId?: string | undefined;
    readonly raw?: unknown;
  }) {
    return {
      eventId: EventId.make(yield* randomUUIDv4),
      provider: PROVIDER,
      ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
      threadId: input.threadId,
      createdAt: yield* nowIso,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
      ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
      ...(input.raw !== undefined
        ? { raw: { source: "pi.sdk.event" as const, payload: input.raw } }
        : {}),
    };
  });

  const mapPiEvent = Effect.fn("mapPiEvent")(function* (context: PiSessionContext, event: PiEvent) {
    const turnId = context.activeTurnId;
    switch (event.type) {
      case "agent_start":
        context.session = { ...context.session, status: "running", updatedAt: yield* nowIso };
        yield* offerRuntimeEvent({
          ...(yield* stamp({ threadId: context.session.threadId, turnId, raw: event })),
          type: "session.state.changed",
          payload: { state: "running", reason: "Pi agent started" },
        });
        break;

      case "message_update": {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") {
          const delta = "delta" in assistantEvent ? assistantEvent.delta : "";
          if (typeof delta === "string" && delta.length > 0) {
            yield* offerRuntimeEvent({
              ...(yield* stamp({ threadId: context.session.threadId, turnId, raw: event })),
              type: "content.delta",
              payload: {
                streamKind:
                  assistantEvent.type === "thinking_delta" ? "reasoning_text" : "assistant_text",
                delta,
              },
            });
          }
        }
        break;
      }

      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        const status =
          event.type === "tool_execution_end"
            ? event.isError
              ? "failed"
              : "completed"
            : "inProgress";
        yield* offerRuntimeEvent({
          ...(yield* stamp({
            threadId: context.session.threadId,
            turnId,
            itemId: event.toolCallId,
            raw: event,
          })),
          type: event.type === "tool_execution_end" ? "item.completed" : "item.updated",
          payload: {
            itemType: toToolLifecycleItemType(event.toolName),
            status,
            title: event.toolName,
            detail: eventDetail(
              event.type === "tool_execution_update" ? event.partialResult : event,
            ),
            data: event,
          },
        });
        break;
      }

      case "agent_end":
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };
        if (turnId) {
          yield* offerRuntimeEvent({
            ...(yield* stamp({ threadId: context.session.threadId, turnId, raw: event })),
            type: "turn.completed",
            payload: { state: "completed", stopReason: null },
          });
        }
        yield* offerRuntimeEvent({
          ...(yield* stamp({ threadId: context.session.threadId, raw: event })),
          type: "session.state.changed",
          payload: { state: "ready", reason: "Pi agent idle" },
        });
        context.activeTurnId = undefined;
        break;

      case "compaction_start":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "queue_update":
      case "session_info_changed":
      case "thinking_level_changed":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_end":
        break;
    }
  });

  const loadPi = () =>
    Effect.tryPromise({
      try: () => import("@earendil-works/pi-coding-agent"),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sdk.import",
          detail: String(cause),
          cause,
        }),
    });

  const requireSession = (threadId: ThreadId) =>
    Effect.sync(() => sessions.get(threadId)).pipe(
      Effect.flatMap((context) =>
        context
          ? Effect.succeed(context)
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId })),
      ),
    );

  type PiAdapterError =
    | ProviderAdapterRequestError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError;

  const startSession: ProviderAdapterShape<PiAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      const existing = sessions.get(input.threadId);
      if (existing) return existing.session;

      const pi = yield* loadPi();
      const cwd = input.cwd ?? serverConfig.cwd;
      const agentDir = resolvePath(piSettings.agentDir);
      const sessionDir = resolvePath(piSettings.sessionDir);
      const resumeCursor = parseResumeCursor(input.resumeCursor);
      const authStorage = pi.AuthStorage.create(agentDir ? `${agentDir}/auth.json` : undefined);
      const modelRegistry = pi.ModelRegistry.create(
        authStorage,
        agentDir ? `${agentDir}/models.json` : undefined,
      );
      const selectedModel =
        resolvePiModel(modelRegistry, input.modelSelection?.model) ??
        resolveDefaultPiModel(modelRegistry);
      const sessionManager = pi.SessionManager.create(cwd, sessionDir);
      if (resumeCursor?.sessionFile) {
        sessionManager.setSessionFile(resumeCursor.sessionFile);
      }
      const settingsManager = pi.SettingsManager.create(cwd, agentDir);

      const result = yield* Effect.tryPromise({
        try: () =>
          pi.createAgentSession({
            cwd,
            ...(agentDir ? { agentDir } : {}),
            authStorage,
            modelRegistry,
            sessionManager,
            settingsManager,
            ...(selectedModel ? { model: selectedModel } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "createAgentSession",
            detail: String(cause),
            cause,
          }),
      });

      const createdAt = yield* nowIso;
      const providerSession: ProviderSession = {
        provider: PROVIDER,
        ...(boundInstanceId ? { providerInstanceId: boundInstanceId } : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        model: result.session.model
          ? getPiModelSlug(result.session.model)
          : input.modelSelection?.model,
        threadId: input.threadId,
        resumeCursor: {
          sessionFile: result.session.sessionFile,
          sessionId: result.session.sessionId,
        },
        createdAt,
        updatedAt: createdAt,
      };

      const context: PiSessionContext = {
        session: providerSession,
        piSession: result.session,
        modelRegistry,
        unsubscribe: () => {},
        turns: [],
        activeTurnId: undefined,
      };
      const unsubscribe = result.session.subscribe((event) => {
        void runPromise(mapPiEvent(context, event));
      });
      context.unsubscribe = unsubscribe;
      sessions.set(input.threadId, context);

      yield* offerRuntimeEvent({
        ...(yield* stamp({ threadId: input.threadId })),
        type: "session.started",
        payload: {
          message: "Pi session started",
          resume: { providerThreadId: result.session.sessionId },
        },
      });
      yield* offerRuntimeEvent({
        ...(yield* stamp({ threadId: input.threadId })),
        type: "session.state.changed",
        payload: { state: "ready", reason: "Pi SDK session ready" },
      });

      return providerSession;
    });

  const sendTurn: ProviderAdapterShape<PiAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      const message = input.input?.trim() ?? "";
      if (!message && (!input.attachments || input.attachments.length === 0)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }

      const selectedModel = resolvePiModel(context.modelRegistry, input.modelSelection?.model);
      if (selectedModel) {
        yield* Effect.tryPromise({
          try: () => context.piSession.setModel(selectedModel),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.setModel",
              detail: String(cause),
              cause,
            }),
        });
      }
      const thinkingLevel = getModelSelectionStringOptionValue(
        input.modelSelection,
        "thinkingLevel",
      );
      if (
        thinkingLevel === "minimal" ||
        thinkingLevel === "low" ||
        thinkingLevel === "medium" ||
        thinkingLevel === "high" ||
        thinkingLevel === "xhigh"
      ) {
        context.piSession.setThinkingLevel(thinkingLevel);
      }

      const turnId = TurnId.make(yield* randomUUIDv4);
      context.activeTurnId = turnId;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        model: context.piSession.model
          ? getPiModelSlug(context.piSession.model)
          : context.session.model,
        updatedAt: yield* nowIso,
      };
      context.turns.push({ id: turnId, items: [] });

      yield* offerRuntimeEvent({
        ...(yield* stamp({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: context.session.model ? { model: context.session.model } : {},
      });

      const images = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) => {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) return Effect.succeed(null);
          return Effect.tryPromise({
            try: async () => {
              const bytes = await Bun.file(attachmentPath).arrayBuffer();
              return {
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              };
            },
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "attachment.read",
                detail: String(cause),
                cause,
              }),
          });
        },
        { concurrency: "unbounded" },
      ).pipe(Effect.map((values) => values.filter((value) => value !== null)));

      yield* Effect.tryPromise({
        try: () => context.piSession.prompt(message, { images }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.prompt",
            detail: String(cause),
            cause,
          }),
      });

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: context.session.resumeCursor,
      } satisfies ProviderTurnStartResult;
    });

  const stopSessionInternal = Effect.fn("stopPiSessionInternal")(function* (
    context: PiSessionContext,
  ) {
    sessions.delete(context.session.threadId);
    context.unsubscribe();
    context.piSession.dispose();
    context.session = { ...context.session, status: "closed", updatedAt: yield* nowIso };
    yield* offerRuntimeEvent({
      ...(yield* stamp({ threadId: context.session.threadId })),
      type: "session.exited",
      payload: { exitKind: "graceful" },
    });
  });

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => context.piSession.abort(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.abort",
                detail: String(cause),
                cause,
              }),
          }),
        ),
      ),
    respondToRequest: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: "Pi approval requests are not wired into T3 Code yet.",
        }),
      ),
    respondToUserInput: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: "Pi user-input requests are not wired into T3 Code yet.",
        }),
      ),
    stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal)),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      requireSession(threadId).pipe(
        Effect.map((context) => ({
          threadId,
          turns: context.turns,
        })),
      ),
    rollbackThread: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Pi rollback is not wired into T3 Code yet.",
            }),
          ),
        ),
      ),
    stopAll: () =>
      Effect.forEach([...sessions.values()], stopSessionInternal, { discard: true }).pipe(
        Effect.asVoid,
      ),
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies ProviderAdapterShape<PiAdapterError>;
});
