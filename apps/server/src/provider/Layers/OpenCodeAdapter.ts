import { randomUUID } from "node:crypto";

import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Queue, Stream } from "effect";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  connectToOpenCodeServer,
  createOpenCodeSdkClient,
  openCodeQuestionId,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";

const PROVIDER = "opencode" as const;

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  stopped: boolean;
  readonly eventsAbortController: AbortController;
}

export interface OpenCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isProviderAdapterRequestError(cause: unknown): cause is ProviderAdapterRequestError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "ProviderAdapterRequestError"
  );
}

function buildEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
> {
  return {
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: "opencode.sdk.event",
            payload: input.raw,
          },
        }
      : {}),
  };
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  if (session.stopped) {
    throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function suffixPrefixOverlap(text: string, delta: string): number {
  const maxLength = Math.min(text.length, delta.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(delta.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta));
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit,
  };
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

async function stopOpenCodeContext(context: OpenCodeSessionContext): Promise<void> {
  context.stopped = true;
  context.eventsAbortController.abort();
  try {
    await context.client.session
      .abort({ sessionID: context.openCodeSessionId })
      .catch(() => undefined);
  } catch {}
  context.server.close();
}

export function makeOpenCodeAdapterLive(_options?: OpenCodeAdapterLiveOptions) {
  return Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const services = yield* Effect.context<never>();
      const nativeEventLogger =
        _options?.nativeEventLogger ??
        (_options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(_options.nativeEventLogPath, {
              stream: "native",
            })
          : undefined);
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, OpenCodeSessionContext>();

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
      const emitPromise = (event: ProviderRuntimeEvent) =>
        emit(event).pipe(Effect.runPromiseWith(services));
      const writeNativeEventPromise = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) =>
        (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void).pipe(
          Effect.runPromiseWith(services),
        );
      const writeNativeEventBestEffort = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => writeNativeEventPromise(threadId, event).catch(() => undefined);

      const emitUnexpectedExit = (context: OpenCodeSessionContext, message: string) => {
        if (context.stopped) {
          return;
        }
        context.stopped = true;
        sessions.delete(context.session.threadId);
        context.server.close();
        const turnId = context.activeTurnId;
        void emitPromise({
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "runtime.error",
          payload: {
            message,
            class: "transport_error",
          },
        }).catch(() => undefined);
        void emitPromise({
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "session.exited",
          payload: {
            reason: message,
            recoverable: false,
            exitKind: "error",
          },
        }).catch(() => undefined);
      };

      /** Emit content.delta and item.completed events for an assistant text part. */
      const emitAssistantTextDelta = async (
        context: OpenCodeSessionContext,
        part: Part,
        turnId: TurnId | undefined,
        raw: unknown,
      ): Promise<void> => {
        const text = textFromPart(part);
        if (text === undefined) {
          return;
        }
        const previousText = context.emittedTextByPartId.get(part.id);
        const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
        context.emittedTextByPartId.set(part.id, latestText);
        if (latestText !== text) {
          context.partById.set(
            part.id,
            (part.type === "text" || part.type === "reasoning"
              ? { ...part, text: latestText }
              : part) satisfies Part,
          );
        }
        if (deltaToEmit.length > 0) {
          await emitPromise({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
              createdAt:
                part.type === "text" || part.type === "reasoning"
                  ? isoFromEpochMs(part.time?.start)
                  : undefined,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: resolveTextStreamKind(part),
              delta: deltaToEmit,
            },
          });
        }

        if (
          part.type === "text" &&
          part.time?.end !== undefined &&
          !context.completedAssistantPartIds.has(part.id)
        ) {
          context.completedAssistantPartIds.add(part.id);
          await emitPromise({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
              createdAt: isoFromEpochMs(part.time.end),
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(latestText.length > 0 ? { detail: latestText } : {}),
            },
          });
        }
      };

      const startEventPump = (context: OpenCodeSessionContext) => {
        void (async () => {
          try {
            const subscription = await context.client.event.subscribe(undefined, {
              signal: context.eventsAbortController.signal,
            });

            for await (const event of subscription.stream) {
              const payloadSessionId =
                "properties" in event
                  ? (event.properties as { sessionID?: unknown }).sessionID
                  : undefined;
              if (payloadSessionId !== context.openCodeSessionId) {
                continue;
              }

              const turnId = context.activeTurnId;
              await writeNativeEventBestEffort(context.session.threadId, {
                observedAt: nowIso(),
                event: {
                  provider: PROVIDER,
                  threadId: context.session.threadId,
                  providerThreadId: context.openCodeSessionId,
                  type: event.type,
                  ...(turnId ? { turnId } : {}),
                  payload: event,
                },
              });

              switch (event.type) {
                case "message.updated": {
                  context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
                  if (event.properties.info.role === "assistant") {
                    for (const part of context.partById.values()) {
                      if (part.messageID !== event.properties.info.id) {
                        continue;
                      }
                      await emitAssistantTextDelta(context, part, turnId, event);
                    }
                  }
                  break;
                }

                case "message.removed": {
                  context.messageRoleById.delete(event.properties.messageID);
                  break;
                }

                case "message.part.delta": {
                  const existingPart = context.partById.get(event.properties.partID);
                  if (!existingPart) {
                    break;
                  }
                  const role = messageRoleForPart(context, existingPart);
                  if (role !== "assistant") {
                    break;
                  }
                  const streamKind = resolveTextStreamKind(existingPart);
                  const delta = event.properties.delta;
                  if (delta.length === 0) {
                    break;
                  }
                  const previousText =
                    context.emittedTextByPartId.get(event.properties.partID) ??
                    textFromPart(existingPart) ??
                    "";
                  const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(
                    previousText,
                    delta,
                  );
                  if (deltaToEmit.length === 0) {
                    break;
                  }
                  context.emittedTextByPartId.set(event.properties.partID, nextText);
                  if (existingPart.type === "text" || existingPart.type === "reasoning") {
                    context.partById.set(event.properties.partID, {
                      ...existingPart,
                      text: nextText,
                    });
                  }
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      itemId: event.properties.partID,
                      raw: event,
                    }),
                    type: "content.delta",
                    payload: {
                      streamKind,
                      delta: deltaToEmit,
                    },
                  });
                  break;
                }

                case "message.part.updated": {
                  const part = event.properties.part;
                  context.partById.set(part.id, part);
                  const messageRole = messageRoleForPart(context, part);

                  if (messageRole === "assistant") {
                    await emitAssistantTextDelta(context, part, turnId, event);
                  }

                  if (part.type === "tool") {
                    const itemType = toToolLifecycleItemType(part.tool);
                    const title =
                      part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
                    const detail = detailFromToolPart(part);
                    const payload = {
                      itemType,
                      ...(part.state.status === "error"
                        ? { status: "failed" as const }
                        : part.state.status === "completed"
                          ? { status: "completed" as const }
                          : { status: "inProgress" as const }),
                      ...(title ? { title } : {}),
                      ...(detail ? { detail } : {}),
                      data: {
                        tool: part.tool,
                        state: part.state,
                      },
                    };
                    const runtimeEvent: ProviderRuntimeEvent = {
                      ...buildEventBase({
                        threadId: context.session.threadId,
                        turnId,
                        itemId: part.callID,
                        createdAt: toolStateCreatedAt(part),
                        raw: event,
                      }),
                      type:
                        part.state.status === "pending"
                          ? "item.started"
                          : part.state.status === "completed" || part.state.status === "error"
                            ? "item.completed"
                            : "item.updated",
                      payload,
                    };
                    appendTurnItem(context, turnId, part);
                    await emitPromise(runtimeEvent);
                  }
                  break;
                }

                case "permission.asked": {
                  context.pendingPermissions.set(event.properties.id, event.properties);
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.id,
                      raw: event,
                    }),
                    type: "request.opened",
                    payload: {
                      requestType: mapPermissionToRequestType(event.properties.permission),
                      detail:
                        event.properties.patterns.length > 0
                          ? event.properties.patterns.join("\n")
                          : event.properties.permission,
                      args: event.properties.metadata,
                    },
                  });
                  break;
                }

                case "permission.replied": {
                  context.pendingPermissions.delete(event.properties.requestID);
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.requestID,
                      raw: event,
                    }),
                    type: "request.resolved",
                    payload: {
                      requestType: "unknown",
                      decision: mapPermissionDecision(event.properties.reply),
                    },
                  });
                  break;
                }

                case "question.asked": {
                  context.pendingQuestions.set(event.properties.id, event.properties);
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.id,
                      raw: event,
                    }),
                    type: "user-input.requested",
                    payload: {
                      questions: normalizeQuestionRequest(event.properties),
                    },
                  });
                  break;
                }

                case "question.replied": {
                  const request = context.pendingQuestions.get(event.properties.requestID);
                  context.pendingQuestions.delete(event.properties.requestID);
                  const answers = Object.fromEntries(
                    (request?.questions ?? []).map((question, index) => [
                      openCodeQuestionId(index, question),
                      event.properties.answers[index]?.join(", ") ?? "",
                    ]),
                  );
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.requestID,
                      raw: event,
                    }),
                    type: "user-input.resolved",
                    payload: { answers },
                  });
                  break;
                }

                case "question.rejected": {
                  context.pendingQuestions.delete(event.properties.requestID);
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.requestID,
                      raw: event,
                    }),
                    type: "user-input.resolved",
                    payload: { answers: {} },
                  });
                  break;
                }

                case "session.status": {
                  if (event.properties.status.type === "busy") {
                    updateProviderSession(context, { status: "running", activeTurnId: turnId });
                  }

                  if (event.properties.status.type === "retry") {
                    await emitPromise({
                      ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                      type: "runtime.warning",
                      payload: {
                        message: event.properties.status.message,
                        detail: event.properties.status,
                      },
                    });
                    break;
                  }

                  if (event.properties.status.type === "idle" && turnId) {
                    context.activeTurnId = undefined;
                    updateProviderSession(
                      context,
                      { status: "ready" },
                      { clearActiveTurnId: true },
                    );
                    await emitPromise({
                      ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                      type: "turn.completed",
                      payload: {
                        state: "completed",
                      },
                    });
                  }
                  break;
                }

                case "session.error": {
                  const message = sessionErrorMessage(event.properties.error);
                  const activeTurnId = context.activeTurnId;
                  context.activeTurnId = undefined;
                  updateProviderSession(
                    context,
                    {
                      status: "error",
                      lastError: message,
                    },
                    { clearActiveTurnId: true },
                  );
                  if (activeTurnId) {
                    await emitPromise({
                      ...buildEventBase({
                        threadId: context.session.threadId,
                        turnId: activeTurnId,
                        raw: event,
                      }),
                      type: "turn.completed",
                      payload: {
                        state: "failed",
                        errorMessage: message,
                      },
                    });
                  }
                  await emitPromise({
                    ...buildEventBase({ threadId: context.session.threadId, raw: event }),
                    type: "runtime.error",
                    payload: {
                      message,
                      class: "provider_error",
                      detail: event.properties.error,
                    },
                  });
                  break;
                }

                default:
                  break;
              }
            }
          } catch (error) {
            if (context.eventsAbortController.signal.aborted || context.stopped) {
              return;
            }
            emitUnexpectedExit(
              context,
              error instanceof Error ? error.message : "OpenCode event stream failed.",
            );
          }
        })();

        context.server.process?.once("exit", (code, signal) => {
          if (context.stopped) {
            return;
          }
          emitUnexpectedExit(
            context,
            `OpenCode server exited unexpectedly (${signal ?? code ?? "unknown"}).`,
          );
        });
      };

      const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to read OpenCode settings.",
                  cause,
                }),
            ),
          );
          const binaryPath = settings.providers.opencode.binaryPath;
          const serverUrl = settings.providers.opencode.serverUrl;
          const serverPassword = settings.providers.opencode.serverPassword;
          const directory = input.cwd ?? serverConfig.cwd;
          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* Effect.tryPromise({
              try: () => stopOpenCodeContext(existing),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to stop existing OpenCode session.",
                  cause,
                }),
            });
            sessions.delete(input.threadId);
          }

          const started = yield* Effect.tryPromise({
            try: async () => {
              const server = await connectToOpenCodeServer({ binaryPath, serverUrl });
              const client = createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.external && serverPassword ? { serverPassword } : {}),
              });
              const openCodeSession = await client.session.create({
                title: `T3 Code ${input.threadId}`,
                permission: buildOpenCodePermissionRules(input.runtimeMode),
              });
              if (!openCodeSession.data) {
                throw new Error("OpenCode session.create returned no session payload.");
              }
              return { server, client, openCodeSession: openCodeSession.data };
            },
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail:
                  cause instanceof Error ? cause.message : "Failed to start OpenCode session.",
                cause,
              }),
          });

          // Guard against a concurrent startSession call that may have raced
          // and already inserted a session while we were awaiting async work.
          const raceWinner = sessions.get(input.threadId);
          if (raceWinner) {
            // Another call won the race – clean up the session we just created
            // (including the remote SDK session) and return the existing one.
            yield* Effect.tryPromise({
              try: () =>
                started.client.session
                  .abort({ sessionID: started.openCodeSession.id })
                  .catch(() => undefined),
              catch: () => undefined,
            }).pipe(Effect.ignore);
            started.server.close();
            return raceWinner.session;
          }

          const createdAt = nowIso();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: directory,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            createdAt,
            updatedAt: createdAt,
          };

          const context: OpenCodeSessionContext = {
            session,
            client: started.client,
            server: started.server,
            directory,
            openCodeSessionId: started.openCodeSession.id,
            pendingPermissions: new Map(),
            pendingQuestions: new Map(),
            partById: new Map(),
            emittedTextByPartId: new Map(),
            messageRoleById: new Map(),
            completedAssistantPartIds: new Set(),
            turns: [],
            activeTurnId: undefined,
            activeAgent: undefined,
            activeVariant: undefined,
            stopped: false,
            eventsAbortController: new AbortController(),
          };
          sessions.set(input.threadId, context);
          startEventPump(context);

          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "session.started",
            payload: {
              message: "OpenCode session started",
            },
          });
          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "thread.started",
            payload: {
              providerThreadId: started.openCodeSession.id,
            },
          });

          return session;
        },
      );

      const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureSessionContext(sessions, input.threadId);
        const turnId = TurnId.make(`opencode-turn-${randomUUID()}`);
        const modelSelection =
          input.modelSelection ??
          (context.session.model
            ? { provider: PROVIDER, model: context.session.model }
            : undefined);
        const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode model selection must use the 'provider/model' format.",
          });
        }

        const text = input.input?.trim();
        const fileParts = toOpenCodeFileParts({
          attachments: input.attachments,
          resolveAttachmentPath: (attachment) =>
            resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
        });
        if ((!text || text.length === 0) && fileParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode turns require text input or at least one attachment.",
          });
        }

        const agent =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.options?.agent
            : undefined;
        const variant =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.options?.variant
            : undefined;

        context.activeTurnId = turnId;
        context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
        context.activeVariant = variant;
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            model: modelSelection?.model ?? context.session.model,
          },
          { clearLastError: true },
        );

        yield* emit({
          ...buildEventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });

        const promptExit = yield* Effect.exit(
          Effect.tryPromise({
            try: async () => {
              await context.client.session.promptAsync({
                sessionID: context.openCodeSessionId,
                model: parsedModel,
                ...(context.activeAgent ? { agent: context.activeAgent } : {}),
                ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
              });
            },
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.promptAsync",
                detail: cause instanceof Error ? cause.message : "Failed to send OpenCode turn.",
                cause,
              }),
          }),
        );
        if (promptExit._tag === "Failure") {
          const failure = Cause.squash(promptExit.cause);
          const requestError = isProviderAdapterRequestError(failure)
            ? failure
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.promptAsync",
                detail:
                  failure instanceof Error ? failure.message : "Failed to send OpenCode turn.",
                cause: failure,
              });
          const failureMessage = requestError.detail;
          context.activeTurnId = undefined;
          context.activeAgent = undefined;
          context.activeVariant = undefined;
          updateProviderSession(
            context,
            {
              status: "ready",
              model: modelSelection?.model ?? context.session.model,
              lastError: failureMessage,
            },
            { clearActiveTurnId: true },
          );
          yield* emit({
            ...buildEventBase({ threadId: input.threadId, turnId }),
            type: "turn.aborted",
            payload: {
              reason: failureMessage,
            },
          });
          return yield* requestError;
        }

        return {
          threadId: input.threadId,
          turnId,
        };
      });

      const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, turnId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* Effect.tryPromise({
            try: () => context.client.session.abort({ sessionID: context.openCodeSessionId }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.abort",
                detail: cause instanceof Error ? cause.message : "Failed to abort OpenCode turn.",
                cause,
              }),
          });
          if (turnId ?? context.activeTurnId) {
            yield* emit({
              ...buildEventBase({ threadId, turnId: turnId ?? context.activeTurnId }),
              type: "turn.aborted",
              payload: {
                reason: "Interrupted by user.",
              },
            });
          }
        },
      );

      const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
        "respondToRequest",
      )(function* (threadId, requestId, decision) {
        const context = ensureSessionContext(sessions, threadId);
        if (!context.pendingPermissions.has(requestId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.reply",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }

        yield* Effect.tryPromise({
          try: () =>
            context.client.permission.reply({
              requestID: requestId,
              reply: toOpenCodePermissionReply(decision),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "permission.reply",
              detail:
                cause instanceof Error
                  ? cause.message
                  : "Failed to submit OpenCode permission reply.",
              cause,
            }),
        });
      });

      const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, requestId, answers) {
        const context = ensureSessionContext(sessions, threadId);
        const request = context.pendingQuestions.get(requestId);
        if (!request) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "question.reply",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        yield* Effect.tryPromise({
          try: () =>
            context.client.question.reply({
              requestID: requestId,
              answers: toOpenCodeQuestionAnswers(request, answers),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "question.reply",
              detail: cause instanceof Error ? cause.message : "Failed to submit OpenCode answers.",
              cause,
            }),
        });
      });

      const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* Effect.tryPromise({
            try: () => stopOpenCodeContext(context),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: cause instanceof Error ? cause.message : "Failed to stop OpenCode session.",
                cause,
              }),
          });
          sessions.delete(threadId);
          yield* emit({
            ...buildEventBase({ threadId }),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: false,
              exitKind: "graceful",
            },
          });
        },
      );

      const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          const messages = yield* Effect.tryPromise({
            try: () => context.client.session.messages({ sessionID: context.openCodeSessionId }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.messages",
                detail: cause instanceof Error ? cause.message : "Failed to read OpenCode thread.",
                cause,
              }),
          });

          const turns = (messages.data ?? [])
            .filter((entry) => entry.info.role === "assistant")
            .map((entry) => ({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            }));

          return {
            threadId,
            turns,
          };
        },
      );

      const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = ensureSessionContext(sessions, threadId);
          const messages = yield* Effect.tryPromise({
            try: () => context.client.session.messages({ sessionID: context.openCodeSessionId }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.messages",
                detail:
                  cause instanceof Error ? cause.message : "Failed to inspect OpenCode thread.",
                cause,
              }),
          });

          const assistantMessages = (messages.data ?? []).filter(
            (entry) => entry.info.role === "assistant",
          );
          const targetIndex = assistantMessages.length - numTurns - 1;
          const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
          yield* Effect.tryPromise({
            try: () =>
              context.client.session.revert({
                sessionID: context.openCodeSessionId,
                ...(target ? { messageID: target.info.id } : {}),
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.revert",
                detail: cause instanceof Error ? cause.message : "Failed to revert OpenCode turn.",
                cause,
              }),
          });

          return yield* readThread(threadId);
        },
      );

      const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
        Effect.tryPromise({
          try: async () => {
            const contexts = [...sessions.values()];
            sessions.clear();
            const results = await Promise.allSettled(
              contexts.map((context) => stopOpenCodeContext(context)),
            );
            const errors = results
              .filter((result): result is PromiseRejectedResult => result.status === "rejected")
              .map((result) => result.reason);
            if (errors.length === 1) {
              throw errors[0];
            }
            if (errors.length > 1) {
              throw new AggregateError(
                errors,
                `Failed to stop ${errors.length} OpenCode sessions.`,
              );
            }
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: "*",
              detail: cause instanceof Error ? cause.message : "Failed to stop OpenCode sessions.",
              cause,
            }),
        });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        stopAll,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } satisfies OpenCodeAdapterShape;
    }),
  );
}

export const OpenCodeAdapterLive = makeOpenCodeAdapterLive();
