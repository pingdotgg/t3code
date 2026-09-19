import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeAcpContentDeltaEvent, makeAcpToolCallEvent } from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest, type AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const ResumeCursor = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && (value as { schemaVersion?: unknown }).schemaVersion === 1
    ? typeof (value as { sessionId?: unknown }).sessionId === "string"
      ? (value as { sessionId: string }).sessionId
      : undefined
    : undefined;

export interface OmpAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly childProcessSpawner: import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner["Service"];
}

export function ompPermissionOptionId(
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
  decision: ProviderApprovalDecision,
): string | undefined {
  if (decision === "cancel") return undefined;
  const hint = decision === "acceptForSession" ? "always" : decision === "accept" ? "once" : "reject";
  return options.find((option) => option.optionId.toLowerCase().includes(hint))?.optionId;
}

export function ompModelsFromConfig(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<{ readonly slug: string; readonly name: string }> {
  const model = options.find((option) => option.id === "model" || option.category === "model");
  if (model?.type !== "select") return [];
  return model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options)).map((entry) => ({
    slug: entry.value,
    name: entry.name,
  }));
}

interface PendingPermission {
  readonly request: EffectAcpSchema.RequestPermissionRequest;
  readonly response: Deferred.Deferred<EffectAcpSchema.RequestPermissionResponse>;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly scope: Scope.Closeable;
  readonly sessionId: string;
  readonly session: ProviderSession;
  readonly permissions: Map<ApprovalRequestId, PendingPermission>;
  activeTurnId?: TurnId;
  prompt?: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
}

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

const error = (threadId: ThreadId, method: string, cause: unknown) =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Pure mapping used by the adapter and by fixture tests for omp's ACP frames. */
export function mapOmpSessionUpdate(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly update: EffectAcpSchema.SessionNotification["update"];
  readonly eventId: EventId;
  readonly createdAt: string;
}): ProviderRuntimeEvent | undefined {
  const update = input.update;
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
    return makeAcpContentDeltaEvent({
      stamp: { eventId: input.eventId, createdAt: input.createdAt },
      provider: PROVIDER,
      threadId: input.threadId,
      turnId: input.turnId,
      text: update.content.text,
      rawPayload: update,
    });
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const toolCall: AcpToolCallState = {
      toolCallId: update.toolCallId,
      ...(update.kind != null ? { kind: update.kind } : {}),
      ...(update.title != null ? { title: update.title } : {}),
      ...(update.status != null
        ? { status: update.status === "in_progress" ? "inProgress" : update.status }
        : {}),
      data: update.rawInput && typeof update.rawInput === "object" ? update.rawInput as Record<string, unknown> : {},
    };
    return makeAcpToolCallEvent({
      stamp: { eventId: input.eventId, createdAt: input.createdAt },
      provider: PROVIDER,
      threadId: input.threadId,
      turnId: input.turnId,
      toolCall,
      rawPayload: update,
    });
  }
  if (update.sessionUpdate === "usage_update") {
    return {
      type: "thread.token-usage.updated",
      eventId: input.eventId,
      createdAt: input.createdAt,
      provider: PROVIDER,
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      payload: { usage: { usedTokens: Math.max(0, update.used), maxTokens: Math.max(1, update.size) } },
      raw: { source: "acp.jsonrpc", method: "session/update", payload: update },
    };
  }
  return undefined;
}

export const makeOmpAdapter = Effect.fn("makeOmpAdapter")(function* (options: OmpAdapterOptions) {
  const crypto = yield* Crypto.Crypto;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, SessionContext>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const id = crypto.randomUUIDv4.pipe(
    Effect.map(EventId.make),
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed to generate an omp runtime event identifier.",
          cause,
        }),
    ),
  );
  const requireSession = (threadId: ThreadId): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const stop = (context: SessionContext) =>
    Effect.gen(function* () {
      sessions.delete(context.threadId);
      if (context.prompt) yield* Effect.ignore(context.runtime.cancel);
      yield* Scope.close(context.scope, Exit.void);
    });

  const startSession: Adapter["startSession"] = (input) =>
    Effect.gen(function* () {
      if (!input.cwd?.trim()) {
        return yield* new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "The session requires a workspace directory." });
      }
      if (input.providerInstanceId && input.providerInstanceId !== options.instanceId) {
        return yield* new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "The omp provider instance does not match the requested session." });
      }
      const previous = sessions.get(input.threadId);
      if (previous) yield* stop(previous);
      const scope = yield* Scope.make("sequential");
      const resumeSessionId = ResumeCursor(input.resumeCursor);
      const spawn: AcpSessionRuntime.AcpSpawnInput = options.environment === undefined
        ? { command: options.binaryPath || "omp", args: ["acp"], cwd: input.cwd }
        : { command: options.binaryPath || "omp", args: ["acp"], cwd: input.cwd, env: options.environment };
      const runtime = yield* AcpSessionRuntime.make({
        spawn,
        cwd: input.cwd,
        clientInfo: { name: "t3-code", version: "0.0.0" },
        authMethodId: "agent",
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        resumeMethod: "load",
        cancelBehavior: "wait-for-prompt",
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.childProcessSpawner),
        );
      const pending = new Map<ApprovalRequestId, PendingPermission>();
      let context: SessionContext | undefined;
      yield* runtime.handleRequestPermission((request) => {
        if (!context) return Effect.succeed({ outcome: { outcome: "cancelled" } });
        const activeContext = context;
        return Effect.gen(function* () {
          const requestId = ApprovalRequestId.make(yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) => EffectAcpErrors.AcpRequestError.internalError(
              "Could not create an omp permission request id.",
              undefined,
              { cause },
            )),
          ));
          const response = yield* Deferred.make<EffectAcpSchema.RequestPermissionResponse>();
          pending.set(requestId, { request, response });
          const stamp = { eventId: yield* id, createdAt: yield* now };
          const parsed = parsePermissionRequest(request);
          yield* emit({
            type: "request.opened", ...stamp, provider: PROVIDER, threadId: input.threadId,
            ...(activeContext.activeTurnId ? { turnId: activeContext.activeTurnId } : {}),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: "dynamic_tool_call", detail: parsed.detail ?? "omp requests permission.", args: request },
            raw: { source: "acp.jsonrpc", method: "session/request_permission", payload: request },
          });
          return yield* Deferred.await(response).pipe(Effect.ensuring(Effect.sync(() => pending.delete(requestId))));
        });
      });
      const started = yield* runtime.start();
      const createdAt = yield* now;
      const session: ProviderSession = {
        provider: PROVIDER, providerInstanceId: options.instanceId, threadId: input.threadId,
        cwd: input.cwd, status: "ready", runtimeMode: input.runtimeMode, createdAt, updatedAt: createdAt,
        resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
        ...(started.modelConfigId ? { model: started.modelConfigId } : {}),
      };
      context = { threadId: input.threadId, runtime, scope, sessionId: started.sessionId, session, permissions: pending };
      sessions.set(input.threadId, context);
      yield* Stream.runForEach(runtime.getEvents(), (event) => {
        if (event._tag === "ContentDelta" || event._tag === "ToolCallUpdated" || event._tag === "UsageUpdated") {
          return Effect.gen(function* () {
            const update = event._tag === "ContentDelta"
              ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } }
              : event._tag === "UsageUpdated"
                ? { sessionUpdate: "usage_update", used: event.used, size: event.size }
              : {
                  sessionUpdate: "tool_call_update",
                  toolCallId: event.toolCall.toolCallId,
                  ...(event.toolCall.title != null ? { title: event.toolCall.title } : {}),
                  ...(event.toolCall.kind != null ? { kind: event.toolCall.kind } : {}),
                  ...(event.toolCall.status != null ? { status: event.toolCall.status } : {}),
                  rawInput: event.toolCall.data,
                };
              const mapped = mapOmpSessionUpdate({
                threadId: input.threadId,
                ...(context?.activeTurnId ? { turnId: context.activeTurnId } : {}),
                update: update as never,
                eventId: yield* id,
                createdAt: yield* now,
              });
            if (mapped) yield* emit(mapped);
          });
        }
        return Effect.void;
      }).pipe(Effect.forkIn(scope));
      return session;
    }).pipe(Effect.mapError((cause) => isProviderAdapterValidationError(cause) || isProviderAdapterSessionNotFoundError(cause) ? cause : error(input.threadId, "session/new", cause)));

  const sendTurn: Adapter["sendTurn"] = (input: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (!input.input?.trim()) return yield* new ProviderAdapterValidationError({ provider: PROVIDER, operation: "sendTurn", issue: "omp requires a non-empty prompt." });
      const turnId = TurnId.make(yield* crypto.randomUUIDv4);
      context.activeTurnId = turnId;
      const prompt = yield* context.runtime.prompt({ prompt: [{ type: "text", text: input.input }] }).pipe(Effect.forkIn(context.scope));
      context.prompt = prompt;
      return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
    }).pipe(Effect.mapError((cause) => isProviderAdapterValidationError(cause) ? cause : error(input.threadId, "session/prompt", cause)));

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.permissions.get(requestId);
      if (!pending) return yield* new ProviderAdapterRequestError({ provider: PROVIDER, method: "session/request_permission", detail: "This approval request is no longer pending." });
      const optionId = ompPermissionOptionId(pending.request.options, decision);
      const option = optionId ? { optionId } : undefined;
      yield* Deferred.succeed(pending.response, { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } });
    });
  const interruptTurn: Adapter["interruptTurn"] = (threadId) => requireSession(threadId).pipe(Effect.flatMap((context) => context.runtime.cancel), Effect.mapError((cause) => error(threadId, "session/cancel", cause)));
  const respondToUserInput: Adapter["respondToUserInput"] = () => Effect.fail(new ProviderAdapterValidationError({ provider: PROVIDER, operation: "respondToUserInput", issue: "omp does not expose structured user questions." }));
  const stopSession: Adapter["stopSession"] = (threadId) => requireSession(threadId).pipe(Effect.flatMap(stop));
  yield* Effect.addFinalizer(() => Effect.forEach([...sessions.values()], stop, { discard: true }).pipe(Effect.andThen(PubSub.shutdown(events))));
  return {
    provider: PROVIDER, capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession, sendTurn, interruptTurn, respondToRequest, respondToUserInput, stopSession,
    stopAll: () => Effect.forEach([...sessions.values()], stop, { discard: true }),
    listSessions: () => Effect.succeed([...sessions.values()].map(({ session }) => session)),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) => requireSession(threadId).pipe(Effect.map(() => ({ threadId, turns: [] }))),
    rollbackThread: () => Effect.fail(new ProviderAdapterValidationError({ provider: PROVIDER, operation: "rollbackThread", issue: "omp does not support conversation rewind." })),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
