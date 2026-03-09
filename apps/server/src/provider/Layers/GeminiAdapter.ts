import { randomUUID } from "node:crypto";

import {
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ChatAttachment,
  EventId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getDefaultModel, normalizeModelSlug } from "@t3tools/shared/model";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { GeminiCliManager } from "../../geminiCliManager.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";

const PROVIDER = "gemini" as const;

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(`gemini_${randomUUID()}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function itemIdFromRaw(value: unknown): RuntimeItemId | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? RuntimeItemId.makeUnsafe(value)
    : undefined;
}

function mapGeminiPlanStatus(value: unknown): "pending" | "inProgress" | "completed" {
  switch (value) {
    case "completed":
      return "completed";
    case "in_progress":
      return "inProgress";
    default:
      return "pending";
  }
}

function mapGeminiToolLifecycleStatus(
  value: unknown,
): "inProgress" | "completed" | "failed" | undefined {
  switch (value) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
      return "inProgress";
    default:
      return undefined;
  }
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function buildGeminiPromptAttachment(input: {
  readonly attachment: ChatAttachment;
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<
  { readonly type: "image"; readonly data: string; readonly mimeType: string },
  ProviderAdapterError
> {
  return Effect.gen(function* () {
    const attachmentPath = resolveAttachmentPath({
      stateDir: input.stateDir,
      attachment: input.attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "sendTurn",
        detail: `Invalid attachment id '${input.attachment.id}'.`,
      });
    }

    const bytes = yield* input.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: toMessage(cause, "Failed to read Gemini attachment"),
            cause: cause instanceof Error ? cause : undefined,
          }),
      ),
    );

    return {
      type: "image" as const,
      data: Buffer.from(bytes).toString("base64"),
      mimeType: input.attachment.mimeType,
    };
  });
}

function mapGeminiEventToCanonical(rawEvent: Record<string, unknown>): ProviderRuntimeEvent | null {
  const method = rawEvent.method;
  const threadId = rawEvent.threadId;
  const turnId = rawEvent.turnId;

  if (typeof method !== "string" || typeof threadId !== "string") {
    return null;
  }

  const base: Omit<ProviderRuntimeEvent, "type" | "payload"> = {
    eventId: makeEventId(),
    provider: PROVIDER,
    threadId: ThreadId.makeUnsafe(threadId),
    createdAt: nowIso(),
    ...(typeof turnId === "string" && turnId.length > 0
      ? { turnId: TurnId.makeUnsafe(turnId) }
      : {}),
  };

  switch (method) {
    case "session/started":
      return {
        ...base,
        type: "session.started",
        payload: {},
      };

    case "session/connecting":
      return {
        ...base,
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(typeof rawEvent.message === "string" ? { reason: rawEvent.message } : {}),
        },
      };

    case "session/ready":
      return {
        ...base,
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(typeof rawEvent.message === "string" ? { reason: rawEvent.message } : {}),
        },
      };

    case "session/configured":
      return {
        ...base,
        type: "session.configured",
        payload: {
          config: {
            resumeCursor: rawEvent.resumeCursor,
          },
        },
      };

    case "turn/started":
      return {
        ...base,
        type: "turn.started",
        payload: typeof rawEvent.model === "string" ? { model: rawEvent.model } : {},
      };

    case "turn/ended":
      if (typeof rawEvent.exitCode !== "number" || rawEvent.exitCode === 0) {
        return null;
      }
      return {
        ...base,
        type: "turn.completed",
        payload: {
          state:
            typeof rawEvent.exitCode === "number" && rawEvent.exitCode !== 0 ? "failed" : "completed",
          ...(typeof rawEvent.stderr === "string" && rawEvent.stderr.trim().length > 0
            ? { errorMessage: rawEvent.stderr.trim() }
            : {}),
        },
      };

    case "turn/error":
      return {
        ...base,
        type: "runtime.error",
        payload: {
          message:
            typeof rawEvent.message === "string" && rawEvent.message.trim().length > 0
              ? rawEvent.message.trim()
              : "Gemini CLI error",
          class: "provider_error",
          detail: rawEvent,
        },
      };

    case "gemini/init":
      return {
        ...base,
        type: "session.configured",
        payload: {
          config: {
            ...(typeof rawEvent.session_id === "string"
              ? { resumeCursor: { sessionId: rawEvent.session_id } }
              : {}),
            ...(typeof rawEvent.model === "string" ? { model: rawEvent.model } : {}),
          },
        },
      };

    case "gemini/message": {
      const role = rawEvent.role;
      const content = rawEvent.content;

      if (role !== "assistant" || typeof content !== "string" || content.length === 0) {
        return null;
      }

      return {
        ...base,
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: content,
        },
      };
    }

    case "gemini/thought": {
      const content = rawEvent.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        return null;
      }
      return {
        ...base,
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(`gemini-thought:${turnId ?? threadId}`),
          description: content.trim(),
        },
      };
    }

    case "gemini/plan": {
      const entries = Array.isArray(rawEvent.entries) ? rawEvent.entries : [];
      return {
        ...base,
        type: "turn.plan.updated",
        payload: {
          plan: entries
            .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
            .filter((entry): entry is Record<string, unknown> => entry !== null)
            .map((entry) => ({
              step:
                typeof entry.content === "string" && entry.content.trim().length > 0
                  ? entry.content.trim()
                  : "Gemini plan step",
              status: mapGeminiPlanStatus(entry.status),
            })),
        },
      };
    }

    case "gemini/tool_use": {
      const itemId = itemIdFromRaw(rawEvent.tool_id);
      return {
        ...base,
        ...(itemId ? { itemId } : {}),
        type: "item.started",
        payload: {
          itemType: "dynamic_tool_call",
          status: "inProgress",
          ...(typeof rawEvent.tool_name === "string" ? { title: rawEvent.tool_name } : {}),
          ...(rawEvent.parameters !== undefined
            ? { detail: JSON.stringify(rawEvent.parameters) }
            : {}),
          data: rawEvent,
        },
      };
    }

    case "gemini/tool_update": {
      const itemId = itemIdFromRaw(rawEvent.tool_id);
      const detail =
        (typeof rawEvent.output === "string" && rawEvent.output.trim().length > 0
          ? rawEvent.output.trim()
          : stringFromUnknown(rawEvent.rawOutput)) ?? stringFromUnknown(rawEvent.rawInput);

      return {
        ...base,
        ...(itemId ? { itemId } : {}),
        type: "item.updated",
        payload: {
          itemType: "dynamic_tool_call",
          ...(mapGeminiToolLifecycleStatus(rawEvent.status)
            ? { status: mapGeminiToolLifecycleStatus(rawEvent.status) }
            : {}),
          ...(typeof rawEvent.tool_name === "string" ? { title: rawEvent.tool_name } : {}),
          ...(detail ? { detail } : {}),
          data: rawEvent,
        },
      };
    }

    case "gemini/tool_result": {
      const itemId = itemIdFromRaw(rawEvent.tool_id);
      const status = rawEvent.status === "failed" || rawEvent.status === "error" ? "failed" : "completed";
      const detail =
        typeof rawEvent.output === "string" && rawEvent.output.trim().length > 0
          ? rawEvent.output
          : typeof rawEvent.error === "object" && rawEvent.error !== null
            ? JSON.stringify(rawEvent.error)
            : undefined;

      return {
        ...base,
        ...(itemId ? { itemId } : {}),
        type: "item.completed",
        payload: {
          itemType: "dynamic_tool_call",
          status,
          ...(typeof rawEvent.tool_name === "string" ? { title: rawEvent.tool_name } : {}),
          ...(detail ? { detail } : {}),
          data: rawEvent,
        },
      };
    }

    case "gemini/session_info": {
      if (typeof rawEvent.title !== "string" || rawEvent.title.trim().length === 0) {
        return null;
      }
      return {
        ...base,
        type: "thread.metadata.updated",
        payload: {
          name: rawEvent.title.trim(),
        },
      };
    }

    case "gemini/error":
      if (rawEvent.severity === "warning") {
        return {
          ...base,
          type: "runtime.warning",
          payload: {
            message:
              typeof rawEvent.message === "string" ? rawEvent.message : "Gemini CLI warning",
            detail: rawEvent,
          },
        };
      }

      return {
        ...base,
        type: "runtime.error",
        payload: {
          message: typeof rawEvent.message === "string" ? rawEvent.message : "Gemini CLI error",
          class: "provider_error",
          detail: rawEvent,
        },
      };

    case "gemini/result": {
      const resultErrorMessage =
        typeof rawEvent.error === "object" &&
        rawEvent.error !== null &&
        typeof (rawEvent.error as { message?: unknown }).message === "string"
          ? (rawEvent.error as { message: string }).message
          : undefined;
      return {
        ...base,
        type: "turn.completed",
        payload: {
          state: rawEvent.status === "error" ? "failed" : "completed",
          ...(resultErrorMessage ? { errorMessage: resultErrorMessage } : {}),
          ...(rawEvent.stats !== undefined ? { usage: rawEvent.stats } : {}),
        },
      };
    }

    default:
      return null;
  }
}

const makeGeminiAdapter = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const manager = new GeminiCliManager();

    manager.on("event", (rawEvent: Record<string, unknown>) => {
      const canonical = mapGeminiEventToCanonical(rawEvent);
      if (!canonical) {
        return;
      }

      Effect.runSync(Queue.offer(eventQueue, canonical));
    });

    const adapter: GeminiAdapterShape = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "restart-session" },

      startSession: (input) =>
        Effect.try({
          try: () => {
            const cwd = input.cwd ?? process.cwd();
            const model = normalizeModelSlug(input.model, "gemini") ?? getDefaultModel("gemini");
            const resumeCursor =
              input.resumeCursor &&
              typeof input.resumeCursor === "object" &&
              !Array.isArray(input.resumeCursor) &&
              typeof (input.resumeCursor as { sessionId?: unknown }).sessionId === "string"
                ? {
                    sessionId: (input.resumeCursor as { sessionId: string }).sessionId,
                  }
                : undefined;

            const context = manager.startSession({
              threadId: String(input.threadId),
              model,
              cwd,
              ...(resumeCursor ? { resumeCursor } : {}),
            });
            const now = nowIso();

            return {
              provider: PROVIDER,
              status: "ready",
              runtimeMode: input.runtimeMode ?? "full-access",
              cwd,
              model: context.model,
              threadId: input.threadId,
              createdAt: now,
              updatedAt: now,
              ...(context.geminiSessionId
                ? { resumeCursor: { sessionId: context.geminiSessionId } }
                : resumeCursor
                  ? { resumeCursor }
                  : {}),
            } satisfies ProviderSession;
          },
          catch: (cause: unknown) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: toMessage(cause, "Failed to start Gemini session"),
              cause: cause instanceof Error ? cause : undefined,
            }),
        }) as Effect.Effect<ProviderSession, ProviderAdapterError>,

      sendTurn: (input) =>
        Effect.gen(function* () {
          const text = input.input;
          if (!text || typeof text !== "string" || text.trim().length === 0) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "Turn input must include text.",
            });
          }

          const promptAttachments = yield* Effect.forEach(
            input.attachments ?? [],
            (attachment) =>
              buildGeminiPromptAttachment({
                attachment,
                stateDir: serverConfig.stateDir,
                threadId: input.threadId,
                fileSystem,
              }),
            { concurrency: 1 },
          );

          const result = yield* Effect.try({
            try: () =>
              manager.sendTurn({
                threadId: String(input.threadId),
                text,
                prompt: [{ type: "text", text }, ...promptAttachments],
                ...(input.model ? { model: input.model } : {}),
                approvalMode: input.interactionMode === "plan" ? "plan" : "yolo",
              }),
            catch: (cause: unknown) => {
              const message = toMessage(cause, "Failed to send Gemini turn");
              if (message.includes("No Gemini session")) {
                return new ProviderAdapterSessionNotFoundError({
                  provider: PROVIDER,
                  threadId: String(input.threadId),
                  cause: cause instanceof Error ? cause : undefined,
                });
              }

              return new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: message,
                cause: cause instanceof Error ? cause : undefined,
              });
            },
          });

          return {
            turnId: TurnId.makeUnsafe(result.turnId),
            threadId: input.threadId,
            ...(result.resumeCursor ? { resumeCursor: result.resumeCursor } : {}),
          } satisfies ProviderTurnStartResult;
        }) as Effect.Effect<ProviderTurnStartResult, ProviderAdapterError>,

      interruptTurn: (threadId, _turnId) =>
        Effect.try({
          try: () => {
            manager.interruptTurn(String(threadId));
          },
          catch: (cause: unknown) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: String(threadId),
              detail: toMessage(cause, "Failed to interrupt turn"),
              cause: cause instanceof Error ? cause : undefined,
            }),
        }) as Effect.Effect<void, ProviderAdapterError>,

      respondToRequest: (_threadId, _requestId, _decision) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail:
              "Gemini CLI does not support mid-turn approval requests. Use --approval-mode=yolo.",
          }),
        ) as Effect.Effect<void, ProviderAdapterError>,

      respondToUserInput: (_threadId, _requestId, _answers) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail:
              "Gemini CLI does not support mid-turn user input requests in headless mode.",
          }),
        ) as Effect.Effect<void, ProviderAdapterError>,

      stopSession: (threadId) =>
        Effect.sync(() => {
          manager.stopSession(String(threadId));
        }),

      listSessions: () =>
        Effect.sync(() => {
          const now = nowIso();
          return manager.listSessions().map((context): ProviderSession => {
            const session: ProviderSession = {
              provider: PROVIDER,
              status: context.status === "stopped" ? "closed" : "ready",
              runtimeMode: "full-access",
              cwd: context.cwd,
              model: context.model,
              threadId: ThreadId.makeUnsafe(context.threadId),
              createdAt: now,
              updatedAt: now,
            };
            return context.geminiSessionId
              ? Object.assign({}, session, {
                  resumeCursor: { sessionId: context.geminiSessionId },
                })
              : session;
          });
        }),

      hasSession: (threadId) => Effect.sync(() => manager.hasSession(String(threadId))),

      readThread: (_threadId) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "readThread",
            detail: "Gemini CLI does not expose thread snapshots in headless mode.",
          }),
        ) as Effect.Effect<any, ProviderAdapterError>,

      rollbackThread: (_threadId, _numTurns) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: "Gemini CLI does not support thread rollback in headless mode.",
          }),
        ) as Effect.Effect<any, ProviderAdapterError>,

      stopAll: () =>
        Effect.sync(() => {
          manager.stopAll();
        }),

      streamEvents: Stream.fromQueue(eventQueue),
    };

    return adapter;
  });

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapter());

export function makeGeminiAdapterLive() {
  return Layer.effect(GeminiAdapter, makeGeminiAdapter());
}
