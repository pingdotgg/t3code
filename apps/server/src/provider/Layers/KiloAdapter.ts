import {
  EventId,
  type KiloSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import type {
  GlobalEvent,
  KiloClient,
  Part,
  PermissionRequest,
  QuestionRequest,
} from "@kilocode/sdk/v2";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  buildKiloPermissionRules,
  kiloQuestionId,
  KiloRuntime,
  KiloRuntimeError,
  kiloRuntimeErrorDetail,
  parseKiloModelSlug,
  runKiloSdk,
  toKiloFileParts,
  toKiloPermissionReply,
  toKiloQuestionAnswers,
  type KiloServerConnection,
} from "../kiloRuntime.ts";
import type { KiloAdapterShape } from "../Services/KiloAdapter.ts";

const PROVIDER = ProviderDriverKind.make("kilo");
const FIXED_AGENT = "code";
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type KiloEvent = GlobalEvent["payload"];

interface KiloTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface KiloSessionContext {
  session: ProviderSession;
  readonly client: KiloClient;
  readonly server: KiloServerConnection;
  readonly directory: string;
  readonly kiloSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly turns: Array<KiloTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly scope: Scope.Closeable;
}

export interface KiloAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

function ensureContext(sessions: ReadonlyMap<ThreadId, KiloSessionContext>, threadId: ThreadId) {
  const context = sessions.get(threadId);
  if (!context) throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  return context;
}

function textFromPart(part: Part): string | undefined {
  return part.type === "text" || part.type === "reasoning" ? part.text : undefined;
}

function mapToolType(tool: string): ToolLifecycleItemType {
  const value = tool.toLowerCase();
  if (value.includes("bash") || value.includes("shell") || value.includes("command"))
    return "command_execution";
  if (value.includes("write") || value.includes("edit") || value.includes("patch"))
    return "file_change";
  return "dynamic_tool_call";
}

function mapPermissionType(permission: string) {
  const value = permission.toLowerCase();
  if (value.includes("bash") || value.includes("shell") || value.includes("command"))
    return "command_execution_approval" as const;
  if (value.includes("read")) return "file_read_approval" as const;
  if (value.includes("write") || value.includes("edit")) return "file_change_approval" as const;
  return "unknown" as const;
}

function normalizeQuestions(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: kiloQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options ?? [],
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function sessionErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Kilo session failed.";
}

export function makeKiloAdapter(settings: KiloSettings, options?: KiloAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("kilo");
    const serverConfig = yield* ServerConfig;
    const runtime = yield* KiloRuntime;
    const crypto = yield* Crypto.Crypto;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, KiloSessionContext>();
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Kilo runtime identifier.",
            cause,
          }),
      ),
    );
    const eventBase = (input: {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId;
      readonly itemId?: string;
      readonly requestId?: string;
      readonly raw?: unknown;
    }) =>
      Effect.all({ eventId: randomId.pipe(Effect.map(EventId.make)), createdAt: nowIso }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? { raw: { source: "kilo.sdk.event" as const, payload: input.raw } }
            : {}),
        })),
      );
    const emit = (event: ProviderRuntimeEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const updateSession = (
      context: KiloSessionContext,
      patch: Partial<ProviderSession>,
      clearActive = false,
    ) =>
      nowIso.pipe(
        Effect.map((updatedAt) => {
          context.session = {
            ...context.session,
            ...patch,
            ...(clearActive ? { activeTurnId: undefined } : {}),
            updatedAt,
          };
          return context.session;
        }),
      );

    const stopContext = Effect.fn("stopKiloContext")(function* (context: KiloSessionContext) {
      if (yield* Ref.getAndSet(context.stopped, true)) return false;
      yield* runKiloSdk("session.abort", () =>
        context.client.session.abort({ sessionID: context.kiloSessionId }, { throwOnError: true }),
      ).pipe(Effect.ignore);
      yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
      return true;
    });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...sessions.values()],
        (context) => Effect.ignoreCause(stopContext(context)),
        {
          concurrency: "unbounded",
          discard: true,
        },
      ).pipe(Effect.ensuring(Queue.shutdown(events))),
    );

    const emitText = Effect.fn("emitKiloText")(function* (
      context: KiloSessionContext,
      part: Part,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) return;
      const previous = context.emittedTextByPartId.get(part.id) ?? "";
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
      context.emittedTextByPartId.set(part.id, text);
      if (delta) {
        yield* emit({
          ...(yield* eventBase({
            threadId: context.session.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            itemId: part.id,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: part.type === "reasoning" ? "reasoning_text" : "assistant_text",
            delta,
          },
        });
      }
      if (
        part.type === "text" &&
        part.time?.end !== undefined &&
        !context.completedAssistantPartIds.has(part.id)
      ) {
        context.completedAssistantPartIds.add(part.id);
        yield* emit({
          ...(yield* eventBase({
            threadId: context.session.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            itemId: part.id,
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(text ? { detail: text } : {}),
          },
        });
      }
    });

    const handleEvent = Effect.fn("handleKiloEvent")(function* (
      context: KiloSessionContext,
      event: KiloEvent,
    ) {
      if (!("properties" in event) || !("sessionID" in event.properties)) return;
      if (event.properties.sessionID !== context.kiloSessionId) return;
      const turnId = context.activeTurnId;
      switch (event.type) {
        case "message.updated":
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          break;
        case "message.part.delta": {
          if (event.properties.field !== "text" || !event.properties.delta) break;
          const part = context.partById.get(event.properties.partID);
          if (!part || (part.type !== "text" && part.type !== "reasoning")) break;
          const previous = context.emittedTextByPartId.get(part.id) ?? "";
          context.emittedTextByPartId.set(part.id, previous + event.properties.delta);
          yield* emit({
            ...(yield* eventBase({
              threadId: context.session.threadId,
              ...(turnId ? { turnId } : {}),
              itemId: part.id,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind: part.type === "reasoning" ? "reasoning_text" : "assistant_text",
              delta: event.properties.delta,
            },
          });
          break;
        }
        case "message.part.updated": {
          const part = event.properties.part;
          context.partById.set(part.id, part);
          const role = context.messageRoleById.get(part.messageID);
          if (role === "assistant") yield* emitText(context, part, event);
          if (part.type === "tool") {
            const status =
              part.state.status === "error"
                ? "failed"
                : part.state.status === "completed"
                  ? "completed"
                  : "inProgress";
            yield* emit({
              ...(yield* eventBase({
                threadId: context.session.threadId,
                ...(turnId ? { turnId } : {}),
                itemId: part.callID,
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload: {
                itemType: mapToolType(part.tool),
                status,
                title:
                  part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool,
                data: { tool: part.tool, state: part.state },
              },
            });
          }
          break;
        }
        case "permission.asked":
          context.pendingPermissions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* eventBase({
              threadId: context.session.threadId,
              ...(turnId ? { turnId } : {}),
              requestId: event.properties.id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionType(event.properties.permission),
              detail: event.properties.patterns.join("\n") || event.properties.permission,
              args: event.properties.metadata,
            },
          });
          break;
        case "permission.replied":
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* eventBase({
              threadId: context.session.threadId,
              ...(turnId ? { turnId } : {}),
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: { requestType: "unknown", decision: event.properties.reply },
          });
          break;
        case "question.asked":
          context.pendingQuestions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* eventBase({
              threadId: context.session.threadId,
              ...(turnId ? { turnId } : {}),
              requestId: event.properties.id,
              raw: event,
            })),
            type: "user-input.requested",
            payload: { questions: normalizeQuestions(event.properties) },
          });
          break;
        case "question.replied":
        case "question.rejected": {
          const request = context.pendingQuestions.get(event.properties.requestID);
          context.pendingQuestions.delete(event.properties.requestID);
          const answers =
            event.type === "question.replied"
              ? Object.fromEntries(
                  (request?.questions ?? []).map((question, index) => [
                    kiloQuestionId(index, question),
                    event.properties.answers[index]?.join(", ") ?? "",
                  ]),
                )
              : {};
          yield* emit({
            ...(yield* eventBase({
              threadId: context.session.threadId,
              ...(turnId ? { turnId } : {}),
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers },
          });
          break;
        }
        case "todo.updated":
          yield* emit({
            ...(yield* eventBase({
              threadId: context.session.threadId,
              ...(turnId ? { turnId } : {}),
              raw: event,
            })),
            type: "turn.plan.updated",
            payload: {
              plan: event.properties.todos.map((todo) => ({
                step: todo.content,
                status:
                  todo.status === "completed"
                    ? "completed"
                    : todo.status === "in_progress"
                      ? "inProgress"
                      : "pending",
              })),
            },
          });
          break;
        case "session.status":
          if (event.properties.status.type === "busy") {
            yield* updateSession(context, { status: "running", activeTurnId: turnId });
          } else if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* eventBase({
                threadId: context.session.threadId,
                ...(turnId ? { turnId } : {}),
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: event.properties.status.message,
                detail: event.properties.status,
              },
            });
          } else if (turnId) {
            context.activeTurnId = undefined;
            yield* updateSession(context, { status: "ready" }, true);
            yield* emit({
              ...(yield* eventBase({ threadId: context.session.threadId, turnId, raw: event })),
              type: "turn.completed",
              payload: { state: "completed" },
            });
          }
          break;
        case "session.error": {
          const message = sessionErrorMessage(event.properties.error);
          context.activeTurnId = undefined;
          yield* updateSession(context, { status: "error", lastError: message }, true);
          yield* emit({
            ...(yield* eventBase({
              threadId: context.session.threadId,
              ...(turnId ? { turnId } : {}),
              raw: event,
            })),
            type: "runtime.error",
            payload: { message, class: "provider_error", detail: event.properties.error },
          });
          if (turnId) {
            yield* emit({
              ...(yield* eventBase({ threadId: context.session.threadId, turnId, raw: event })),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: message },
            });
          }
          break;
        }
        default:
          break;
      }
    });

    const startPump = Effect.fn("startKiloPump")(function* (context: KiloSessionContext) {
      const abort = new AbortController();
      yield* Scope.addFinalizer(
        context.scope,
        Effect.sync(() => abort.abort()),
      );
      yield* runKiloSdk("event.subscribe", () =>
        context.client.event.subscribe(undefined, { signal: abort.signal, throwOnError: true }),
      ).pipe(
        Effect.flatMap((subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new KiloRuntimeError({
                operation: "event.subscribe",
                detail: kiloRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleEvent(context, event))),
        ),
        Effect.catchCause((cause) =>
          abort.signal.aborted
            ? Effect.void
            : Effect.gen(function* () {
                const message = kiloRuntimeErrorDetail(Cause.squash(cause));
                const activeTurnId = context.activeTurnId;
                context.activeTurnId = undefined;
                yield* Ref.set(context.stopped, true);
                yield* updateSession(context, { status: "error", lastError: message }, true);
                sessions.delete(context.session.threadId);
                if (activeTurnId) {
                  yield* emit({
                    ...(yield* eventBase({
                      threadId: context.session.threadId,
                      turnId: activeTurnId,
                    })),
                    type: "turn.completed",
                    payload: { state: "failed", errorMessage: message },
                  });
                }
                yield* emit({
                  ...(yield* eventBase({ threadId: context.session.threadId })),
                  type: "runtime.error",
                  payload: { message, class: "transport_error" },
                });
                yield* emit({
                  ...(yield* eventBase({ threadId: context.session.threadId })),
                  type: "session.exited",
                  payload: {
                    reason: message,
                    recoverable: true,
                    exitKind: "error",
                  },
                });
                yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore, Effect.forkDetach);
              }),
        ),
        Effect.forkIn(context.scope),
      );
    });

    const startSession: KiloAdapterShape["startSession"] = Effect.fn("startKiloSession")(
      function* (input) {
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopContext(existing);
          sessions.delete(input.threadId);
        }
        const directory = input.cwd ?? serverConfig.cwd;
        const scope = yield* Scope.make();
        const started = yield* Effect.exit(
          Effect.gen(function* () {
            const server = yield* runtime.startServer({
              binaryPath: settings.binaryPath,
              ...(options?.environment ? { environment: options.environment } : {}),
            });
            const client = runtime.createClient({ baseUrl: server.url, directory });
            const model = parseKiloModelSlug(input.modelSelection?.model);
            const created = yield* runKiloSdk("session.create", () =>
              client.session.create(
                {
                  title: `T3 Code ${input.threadId}`,
                  agent: FIXED_AGENT,
                  ...(model ? { model: { id: model.modelID, providerID: model.providerID } } : {}),
                  permission: buildKiloPermissionRules(input.runtimeMode),
                  platform: "t3code",
                },
                { throwOnError: true },
              ),
            );
            if (!created.data) {
              return yield* new KiloRuntimeError({
                operation: "session.create",
                detail: "Kilo session.create returned no session payload.",
              });
            }
            return { server, client, session: created.data };
          }).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        if (Exit.isFailure(started)) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
          const cause = Cause.squash(started.cause);
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: kiloRuntimeErrorDetail(cause),
            cause,
          });
        }
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          createdAt,
          updatedAt: createdAt,
        };
        const context: KiloSessionContext = {
          session,
          client: started.value.client,
          server: started.value.server,
          directory,
          kiloSessionId: started.value.session.id,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          messageRoleById: new Map(),
          partById: new Map(),
          emittedTextByPartId: new Map(),
          completedAssistantPartIds: new Set(),
          turns: [],
          activeTurnId: undefined,
          stopped: yield* Ref.make(false),
          scope,
        };
        sessions.set(input.threadId, context);
        yield* startPump(context);
        yield* emit({
          ...(yield* eventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: { message: "Kilo session started" },
        });
        yield* emit({
          ...(yield* eventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: { providerThreadId: started.value.session.id },
        });
        return session;
      },
    );

    const sendTurn: KiloAdapterShape["sendTurn"] = Effect.fn("sendKiloTurn")(function* (input) {
      const context = ensureContext(sessions, input.threadId);
      const turnId = context.activeTurnId ?? TurnId.make(`kilo-turn-${yield* randomId}`);
      const selection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (!selection || selection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Kilo model selection must target instance '${boundInstanceId}'.`,
        });
      }
      const model = parseKiloModelSlug(selection.model);
      if (!model) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Kilo model selection must use the 'provider/model' format.",
        });
      }
      const text = input.input?.trim();
      const files = toKiloFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
      });
      if (!text && files.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Kilo turns require text input or at least one attachment.",
        });
      }
      const freshTurn = context.activeTurnId === undefined;
      context.activeTurnId = turnId;
      yield* updateSession(context, {
        status: "running",
        activeTurnId: turnId,
        model: selection.model,
      });
      if (freshTurn) {
        yield* emit({
          ...(yield* eventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: { model: selection.model },
        });
      }
      yield* runKiloSdk("session.promptAsync", () =>
        context.client.session.promptAsync(
          {
            sessionID: context.kiloSessionId,
            model,
            agent: input.interactionMode === "plan" ? "plan" : FIXED_AGENT,
            parts: [...(text ? [{ type: "text" as const, text }] : []), ...files],
          },
          { throwOnError: true },
        ),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: cause.operation,
              detail: cause.detail,
              cause,
            }),
        ),
      );
      return { threadId: input.threadId, turnId };
    });

    const interruptTurn: KiloAdapterShape["interruptTurn"] = (threadId) => {
      const context = ensureContext(sessions, threadId);
      return runKiloSdk("session.abort", () =>
        context.client.session.abort({ sessionID: context.kiloSessionId }, { throwOnError: true }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: cause.operation,
              detail: cause.detail,
              cause,
            }),
        ),
        Effect.asVoid,
      );
    };

    const respondToRequest: KiloAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) => {
      const context = ensureContext(sessions, threadId);
      if (!context.pendingPermissions.has(requestId)) {
        return Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.reply",
            detail: `Unknown pending permission request: ${requestId}`,
          }),
        );
      }
      return runKiloSdk("permission.reply", () =>
        context.client.permission.reply(
          { requestID: requestId, reply: toKiloPermissionReply(decision) },
          { throwOnError: true },
        ),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: cause.operation,
              detail: cause.detail,
              cause,
            }),
        ),
        Effect.asVoid,
      );
    };

    const respondToUserInput: KiloAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) => {
      const context = ensureContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "question.reply",
            detail: `Unknown pending question request: ${requestId}`,
          }),
        );
      }
      return runKiloSdk("question.reply", () =>
        context.client.question.reply(
          { requestID: requestId, answers: toKiloQuestionAnswers(request, answers) },
          { throwOnError: true },
        ),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: cause.operation,
              detail: cause.detail,
              cause,
            }),
        ),
        Effect.asVoid,
      );
    };

    const stopSession: KiloAdapterShape["stopSession"] = Effect.fn("stopKiloSession")(
      function* (threadId) {
        const context = ensureContext(sessions, threadId);
        const stopped = yield* stopContext(context);
        sessions.delete(threadId);
        if (stopped) {
          yield* emit({
            ...(yield* eventBase({ threadId })),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: false,
              exitKind: "graceful",
            },
          });
        }
      },
    );

    const readThread: KiloAdapterShape["readThread"] = Effect.fn("readKiloThread")(
      function* (threadId) {
        const context = ensureContext(sessions, threadId);
        const response = yield* runKiloSdk("session.messages", () =>
          context.client.session.messages(
            { sessionID: context.kiloSessionId },
            { throwOnError: true },
          ),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: cause.operation,
                detail: cause.detail,
                cause,
              }),
          ),
        );
        const turns: Array<KiloTurnSnapshot> = [];
        for (const entry of response.data ?? []) {
          if (entry.info.role !== "assistant") continue;
          turns.push({ id: TurnId.make(entry.info.id), items: [entry.info, ...entry.parts] });
        }
        return { threadId, turns };
      },
    );

    const rollbackThread: KiloAdapterShape["rollbackThread"] = Effect.fn("rollbackKiloThread")(
      function* (threadId, numTurns) {
        const context = ensureContext(sessions, threadId);
        const snapshot = yield* readThread(threadId);
        const target = snapshot.turns[snapshot.turns.length - numTurns - 1];
        yield* runKiloSdk("session.revert", () =>
          context.client.session.revert(
            { sessionID: context.kiloSessionId, ...(target ? { messageID: target.id } : {}) },
            { throwOnError: true },
          ),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: cause.operation,
                detail: cause.detail,
                cause,
              }),
          ),
        );
        return yield* readThread(threadId);
      },
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () => Effect.sync(() => [...sessions.values()].map((value) => value.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread,
      rollbackThread,
      stopAll: () =>
        Effect.forEach(
          [...sessions.values()],
          (context) => Effect.ignoreCause(stopContext(context)),
          {
            concurrency: "unbounded",
            discard: true,
          },
        ).pipe(Effect.tap(() => Effect.sync(() => sessions.clear()))),
      get streamEvents() {
        return Stream.fromQueue(events);
      },
    } satisfies KiloAdapterShape;
  });
}
