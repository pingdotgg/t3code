import {
  ApprovalRequestId,
  EventId,
  type OhMyPiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { makeOhMyPiAcpRuntime } from "../acp/OhMyPiAcpSupport.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { OH_MY_PI_MANAGED_MODEL } from "./OhMyPiProvider.ts";

const PROVIDER = ProviderDriverKind.make("ohMyPi");
const RESUME_VERSION = 1 as const;

type PendingApproval = Deferred.Deferred<ProviderApprovalDecision>;

type SessionContext = {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly scope: Scope.Closeable;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  stopped: boolean;
};

export interface OhMyPiAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

function parseResumeCursor(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as { schemaVersion?: unknown; sessionId?: unknown };
  if (candidate.schemaVersion !== RESUME_VERSION) return undefined;
  return typeof candidate.sessionId === "string" && candidate.sessionId.trim()
    ? candidate.sessionId.trim()
    : undefined;
}

function permissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return request.options.find((option) => option.kind === kind)?.optionId.trim() || undefined;
}

function autoApproveOptionId(request: EffectAcpSchema.RequestPermissionRequest): string | undefined {
  return permissionOptionId(request, "acceptForSession") ?? permissionOptionId(request, "accept");
}

export function makeOhMyPiAdapter(
  settings: OhMyPiSettings,
  options?: OhMyPiAdapterOptions,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig
  | Scope.Scope
> {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("ohMyPi");
    const sessions = new Map<ThreadId, SessionContext>();
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextId = crypto.randomUUIDv4.pipe(
      Effect.orDie,
    );
    const stamp = () =>
      Effect.all({
        eventId: Effect.map(nextId, EventId.make),
        createdAt: nowIso,
      });
    const publish = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

    const requireSession = (threadId: ThreadId) => {
      const session = sessions.get(threadId);
      return session && !session.stopped
        ? Effect.succeed(session)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const settleApprovals = (ctx: SessionContext) =>
      Effect.forEach(
        Array.from(ctx.pendingApprovals.values()),
        (pending) => Deferred.succeed(pending, "cancel").pipe(Effect.ignore),
        { discard: true },
      );

    const stopInternal = (ctx: SessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settleApprovals(ctx);
        if (ctx.notificationFiber) yield* Fiber.interrupt(ctx.notificationFiber);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* publish({
          type: "session.exited",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const cwd = input.cwd?.trim();
        if (!cwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) yield* stopInternal(existing);

        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const resumeSessionId = parseResumeCursor(input.resumeCursor);
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const acp = yield* makeOhMyPiAcpRuntime({
          ohMyPiSettings: settings,
          ...(options?.environment ? { environment: options.environment } : {}),
          childProcessSpawner,
          cwd,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          ...(mcpSession
            ? {
                mcpServers: [
                  {
                    type: "http" as const,
                    name: "t3-code",
                    url: mcpSession.endpoint,
                    headers: [
                      { name: "Authorization", value: mcpSession.authorizationHeader },
                    ],
                  },
                ],
              }
            : {}),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
          ),
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        yield* acp.handleRequestPermission((params) =>
          Effect.gen(function* () {
            if (input.runtimeMode === "full-access") {
              const optionId = autoApproveOptionId(params);
              if (optionId) {
                return { outcome: { outcome: "selected" as const, optionId } };
              }
            }

            const permissionRequest = parsePermissionRequest(params);
            const requestId = ApprovalRequestId.make(yield* nextId);
            const runtimeRequestId = RuntimeRequestId.make(requestId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(requestId, decision);
            const activeTurnId = sessions.get(input.threadId)?.activeTurnId;
            yield* publish(
              makeAcpRequestOpenedEvent({
                stamp: yield* stamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: activeTurnId,
                requestId: runtimeRequestId,
                permissionRequest,
                detail: permissionRequest.detail ?? "Oh My Pi requests permission.",
                args: params,
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: params,
              }),
            );
            const resolved = yield* Deferred.await(decision);
            pendingApprovals.delete(requestId);
            yield* publish(
              makeAcpRequestResolvedEvent({
                stamp: yield* stamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: activeTurnId,
                requestId: runtimeRequestId,
                permissionRequest,
                decision: resolved,
              }),
            );
            const optionId = resolved === "cancel" ? undefined : permissionOptionId(params, resolved);
            return {
              outcome: optionId
                ? { outcome: "selected" as const, optionId }
                : ({ outcome: "cancelled" } as const),
            };
          }).pipe(
            Effect.mapError((cause) => ({
              _tag: "AcpTransportError" as const,
              message: cause instanceof Error ? cause.message : String(cause),
              detail: "Failed to process Oh My Pi permission request.",
              cause,
            }) as never),
          ),
        );

        const started = yield* acp.start().pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
          ),
        );
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          model: OH_MY_PI_MANAGED_MODEL,
          threadId: input.threadId,
          resumeCursor: { schemaVersion: RESUME_VERSION, sessionId: started.sessionId },
          createdAt,
          updatedAt: createdAt,
        };
        const ctx: SessionContext = {
          threadId: input.threadId,
          acpSessionId: started.sessionId,
          acp,
          scope: sessionScope,
          pendingApprovals,
          turns: [],
          session,
          activeTurnId: undefined,
          notificationFiber: undefined,
          stopped: false,
        };
        sessions.set(input.threadId, ctx);

        const notificationFiber = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) =>
            Effect.gen(function* () {
              if (event._tag === "EventStreamBarrier") {
                yield* Deferred.succeed(event.acknowledge, undefined);
                return;
              }
              if (event._tag === "ModeChanged") return;
              const turnId = ctx.activeTurnId;
              if (!turnId) return;
              const eventStamp = yield* stamp();
              switch (event._tag) {
                case "AssistantItemStarted":
                  yield* publish(
                    makeAcpAssistantItemEvent({
                      stamp: eventStamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      itemId: event.itemId,
                      lifecycle: "item.started",
                    }),
                  );
                  return;
                case "AssistantItemCompleted":
                  yield* publish(
                    makeAcpAssistantItemEvent({
                      stamp: eventStamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      itemId: event.itemId,
                      lifecycle: "item.completed",
                    }),
                  );
                  return;
                case "PlanUpdated":
                  yield* publish(
                    makeAcpPlanUpdatedEvent({
                      stamp: eventStamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      payload: event.payload,
                      source: "acp.jsonrpc",
                      method: "session/update",
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ToolCallUpdated":
                  yield* publish(
                    makeAcpToolCallEvent({
                      stamp: eventStamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ContentDelta":
                  yield* publish(
                    makeAcpContentDeltaEvent({
                      stamp: eventStamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
              }
            }),
          ),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logError("Failed to process Oh My Pi ACP notification.", { cause }),
          ),
          Effect.forkChild,
        );
        ctx.notificationFiber = notificationFiber;
        transferred = true;

        yield* publish({
          type: "session.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* publish({
          type: "session.state.changed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Oh My Pi ACP session ready" },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });
        return session;
      }).pipe(Effect.scoped);

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const text = input.input?.trim();
        const attachments = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
          Effect.gen(function* () {
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!path) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(path).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            return {
              type: "image" as const,
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            } satisfies EffectAcpSchema.ContentBlock;
          }),
        );
        const prompt: Array<EffectAcpSchema.ContentBlock> = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...attachments,
        ];
        if (prompt.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or an attachment.",
          });
        }

        const turnId = ctx.activeTurnId ?? TurnId.make(yield* nextId);
        const isSteer = ctx.activeTurnId !== undefined;
        ctx.activeTurnId = turnId;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        if (!isSteer) {
          yield* publish({
            type: "turn.started",
            ...(yield* stamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { model: OH_MY_PI_MANAGED_MODEL },
          });
        }

        const result = yield* ctx.acp.prompt({ prompt }).pipe(
          Effect.tap(() => ctx.acp.drainEvents),
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
        );
        ctx.turns.push({ id: turnId, items: [{ prompt, result }] });
        if (ctx.activeTurnId === turnId) {
          const updatedAt = yield* nowIso;
          const { activeTurnId: _activeTurnId, ...ready } = ctx.session;
          ctx.activeTurnId = undefined;
          ctx.session = { ...ready, status: "ready", updatedAt };
          yield* publish({
            type: "turn.completed",
            ...(yield* stamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              state: result.stopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: result.stopReason ?? null,
            },
          });
        }
        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const active = ctx.activeTurnId;
        if (turnId !== undefined && active !== undefined && turnId !== active) return;
        yield* settleApprovals(ctx);
        yield* ctx.acp.cancel.pipe(
          Effect.mapError((error) => mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error)),
          Effect.ignore,
        );
        if (active) {
          const updatedAt = yield* nowIso;
          const { activeTurnId: _activeTurnId, ...ready } = ctx.session;
          ctx.activeTurnId = undefined;
          ctx.session = { ...ready, status: "ready", updatedAt };
          yield* publish({
            type: "turn.completed",
            ...(yield* stamp()),
            provider: PROVIDER,
            threadId,
            turnId: active,
            payload: { state: "cancelled", stopReason: "cancelled" },
          });
        }
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail: `OMP ACP elicitation '${requestId}' is not exposed through this minimal provider integration.`,
        });
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
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
          detail: "Oh My Pi ACP does not expose provider-side rollback through T3.",
        });
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.flatMap(requireSession(threadId), stopInternal);
    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });
    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(events))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
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
      streamEvents: Stream.fromPubSub(events),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
