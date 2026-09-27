/**
 * Adapter for MSP (Muse Session Protocol) coding agents.
 *
 * Mirrors {@link makeExternalAcpAdapter}: one `muse serve` host per T3 thread,
 * canonical `ProviderRuntimeEvent`s published on a shared PubSub, pending
 * approval/user-input maps bridged to `approval/decide` / `userInput/answer`
 * commands.
 */
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type CanonicalRequestType,
  type ProviderUserInputAnswers,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  makeMspSessionHost,
  MspError,
  type MspSessionHostService,
  type MspSpawnInput,
} from "../msp/MspSessionHost.ts";
import {
  canonicalAnswerToMsp,
  mspApprovalDetail,
  mspApprovalRequestType,
  mspChoiceIdForDecision,
  mspChoicesToOptions,
  mspDeltaToStreamKind,
  mspItemDetail,
  mspItemStatusToRuntime,
  mspItemTitle,
  mspItemToCanonicalType,
  mspQuestionsToCanonical,
  mspSessionStateToRuntime,
  mspTurnTerminalToRuntime,
  type MspApprovalChoice,
  type MspApprovalRequest,
  type MspItem,
  type MspSessionContextUsage,
  type MspSessionInfo,
  type MspSessionTokenUsage,
  type MspTurnCompleted,
  type MspUserInputRequest,
} from "../msp/MspRuntimeModel.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const RESUME_SCHEMA_VERSION = 1 as const;
const MSP_CLIENT_NAME = "t3_code";

interface PendingMspApproval {
  readonly mspApprovalId: string;
  readonly requirementId: { readonly approvalId: string; readonly sourceIndex: number };
  readonly choices: ReadonlyArray<MspApprovalChoice>;
  readonly requestType: CanonicalRequestType;
  readonly mspTurnId: string;
  readonly itemId: string;
}

interface PendingMspUserInput {
  readonly userInputId: string;
}

interface PendingMspTurn {
  readonly t3TurnId: TurnId;
  readonly completion: Deferred.Deferred<MspTurnCompleted, MspError>;
}

interface ExternalMspSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  host: MspSessionHostService;
  mspSessionId: string;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingMspApproval>;
  readonly approvalsByMspId: Map<string, ApprovalRequestId>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingMspUserInput>;
  readonly userInputsByMspId: Map<string, ApprovalRequestId>;
  readonly pendingTurns: Map<string, PendingMspTurn>;
  readonly items: Map<string, MspItem>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly mspToT3TurnId: Map<string, TurnId>;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  stopped: boolean;
}

export interface ExternalMspAdapterOptions {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly spawn: (cwd: string, environment?: NodeJS.ProcessEnv) => MspSpawnInput;
  readonly defaultModel?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function parseResumeCursor(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return record.schemaVersion === RESUME_SCHEMA_VERSION && typeof record.sessionId === "string"
    ? record.sessionId.trim() || undefined
    : undefined;
}

function mspApprovalModeForRuntimeMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "full-access":
      return "allowAll";
    case "auto":
    case "auto-accept-edits":
      return "promptUnmatched";
    default:
      return "onRequest";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const isMspError = Schema.is(MspError);

export const makeExternalMspAdapter = Effect.fn("makeExternalMspAdapter")(function* (
  options: ExternalMspAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const sessions = new Map<ThreadId, ExternalMspSessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4;
  const uuid7 = crypto.randomUUIDv7;

  const nextStamp = () =>
    Effect.all({ eventId: uuid.pipe(Effect.map(EventId.make)), createdAt: now });
  const withLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(
      SynchronizedRef.modifyEffect(locks, (current) => {
        const currentLock = current.get(threadId);
        if (currentLock) return Effect.succeed([currentLock, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((created) => {
            const next = new Map(current);
            next.set(threadId, created);
            return [created, next] as const;
          }),
        );
      }),
      (lock) => lock.withPermit(effect),
    );
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
  const logNative = (threadId: ThreadId, event: unknown) =>
    options.nativeEventLogger ? options.nativeEventLogger.write(event, threadId) : Effect.void;
  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ExternalMspSessionContext, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session && !session.stopped
      ? Effect.succeed(session)
      : Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: options.provider, threadId }),
        );
  };
  const toAdapterError = (
    threadId: ThreadId,
    method: string,
    cause: unknown,
  ): ProviderAdapterError => {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      typeof cause._tag === "string" &&
      cause._tag.startsWith("ProviderAdapter")
    ) {
      return cause as ProviderAdapterError;
    }
    if (isMspError(cause)) {
      return new ProviderAdapterRequestError({
        provider: options.provider,
        method,
        detail: cause.detail,
        cause,
      });
    }
    return new ProviderAdapterProcessError({
      provider: options.provider,
      threadId,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  };
  const mapError =
    (threadId: ThreadId, method: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ProviderAdapterError, R> =>
      effect.pipe(Effect.mapError((cause) => toAdapterError(threadId, method, cause)));

  const t3TurnIdFor = (ctx: ExternalMspSessionContext, mspTurnId: string | null | undefined) =>
    (mspTurnId ? ctx.mspToT3TurnId.get(mspTurnId) : undefined) ?? ctx.activeTurnId;

  const handleItemEvent = (
    ctx: ExternalMspSessionContext,
    lifecycle: "item.started" | "item.updated" | "item.completed",
    params: unknown,
  ) =>
    Effect.gen(function* () {
      const item = asRecord(params).item as MspItem | undefined;
      if (!item?.itemId) return;
      ctx.items.set(item.itemId, item);
      const status = mspItemStatusToRuntime(item.status);
      const title = mspItemTitle(item);
      const detail = mspItemDetail(item);
      yield* publish({
        type: lifecycle,
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId: ctx.threadId,
        turnId: t3TurnIdFor(ctx, item.turnId),
        itemId: RuntimeItemId.make(item.itemId),
        payload: {
          itemType: mspItemToCanonicalType(item),
          status,
          ...(title ? { title } : {}),
          ...(detail ? { detail } : {}),
          data: item,
        },
        raw: { source: "msp.jsonrpc", method: `item/${lifecycle.split(".")[1]}`, payload: params },
      });
      if (lifecycle === "item.completed") {
        const t3TurnId = t3TurnIdFor(ctx, item.turnId);
        const turn = ctx.turns.find((entry) => entry.id === t3TurnId) ?? ctx.turns.at(-1);
        turn?.items.push(item);
      }
    });

  const handleApprovalRequest = (ctx: ExternalMspSessionContext, params: unknown) =>
    Effect.gen(function* () {
      const request = params as MspApprovalRequest;
      if (!request?.approvalId) return;
      const requestId = ApprovalRequestId.make(yield* uuid);
      ctx.pendingApprovals.set(requestId, {
        mspApprovalId: request.approvalId,
        requirementId: request.currentRequirementId,
        choices: request.availableChoices ?? [],
        requestType: mspApprovalRequestType(request.subject ?? { kind: "tool" }),
        mspTurnId: request.turnId,
        itemId: request.itemId,
      });
      ctx.approvalsByMspId.set(request.approvalId, requestId);
      const options_ = mspChoicesToOptions(request.availableChoices ?? []);
      yield* publish({
        type: "request.opened",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId: ctx.threadId,
        turnId: t3TurnIdFor(ctx, request.turnId),
        requestId: RuntimeRequestId.make(requestId),
        itemId: request.itemId ? RuntimeItemId.make(request.itemId) : undefined,
        payload: {
          requestType: mspApprovalRequestType(request.subject ?? { kind: "tool" }),
          detail: mspApprovalDetail(request),
          ...(options_.length > 0 ? { options: options_ } : {}),
          args: request,
        },
        raw: { source: "msp.jsonrpc", method: "approval/request", payload: params },
      });
    });

  const handleUserInputRequest = (ctx: ExternalMspSessionContext, params: unknown) =>
    Effect.gen(function* () {
      const request = params as MspUserInputRequest;
      if (!request?.userInputId) return;
      const requestId = ApprovalRequestId.make(yield* uuid);
      ctx.pendingUserInputs.set(requestId, { userInputId: request.userInputId });
      ctx.userInputsByMspId.set(request.userInputId, requestId);
      yield* publish({
        type: "user-input.requested",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId: ctx.threadId,
        turnId: t3TurnIdFor(ctx, request.turnId),
        requestId: RuntimeRequestId.make(requestId),
        payload: { questions: mspQuestionsToCanonical(request.questions ?? []) },
        raw: { source: "msp.jsonrpc", method: "userInput/request", payload: params },
      });
    });

  const handleNotification = (ctx: ExternalMspSessionContext, method: string, params: unknown) =>
    Effect.gen(function* () {
      switch (method) {
        case "item/started":
          return yield* handleItemEvent(ctx, "item.started", params);
        case "item/updated":
          return yield* handleItemEvent(ctx, "item.updated", params);
        case "item/completed":
          return yield* handleItemEvent(ctx, "item.completed", params);
        case "item/delta": {
          const record = asRecord(params);
          const itemId = typeof record.itemId === "string" ? record.itemId : undefined;
          const delta = typeof record.delta === "string" ? record.delta : "";
          if (!itemId || !delta) return;
          const item = ctx.items.get(itemId);
          yield* publish({
            type: "content.delta",
            ...(yield* nextStamp()),
            provider: options.provider,
            threadId: ctx.threadId,
            turnId: t3TurnIdFor(ctx, item?.turnId),
            itemId: RuntimeItemId.make(itemId),
            payload: {
              streamKind: mspDeltaToStreamKind(item, record.field as string | undefined),
              delta,
            },
            raw: { source: "msp.jsonrpc", method: "item/delta", payload: params },
          });
          return;
        }
        case "turn/started": {
          const record = asRecord(params);
          const mspTurnId = typeof record.turnId === "string" ? record.turnId : undefined;
          const t3TurnId = t3TurnIdFor(ctx, mspTurnId);
          if (t3TurnId) ctx.activeTurnId = t3TurnId;
          return;
        }
        case "turn/completed": {
          const completed = params as MspTurnCompleted;
          const pending = ctx.pendingTurns.get(completed.turnId);
          const t3TurnId = t3TurnIdFor(ctx, completed.turnId);
          if (t3TurnId && ctx.session.activeTurnId === t3TurnId) {
            ctx.session = { ...ctx.session, activeTurnId: undefined, updatedAt: yield* now };
          }
          if (pending) {
            ctx.pendingTurns.delete(completed.turnId);
            yield* Deferred.succeed(pending.completion, completed);
          }
          return;
        }
        case "approval/resolved": {
          const record = asRecord(params);
          const mspApprovalId =
            typeof record.approvalId === "string" ? record.approvalId : undefined;
          if (!mspApprovalId) return;
          const requestId = ctx.approvalsByMspId.get(mspApprovalId);
          if (!requestId) return;
          const pending = ctx.pendingApprovals.get(requestId);
          ctx.approvalsByMspId.delete(mspApprovalId);
          ctx.pendingApprovals.delete(requestId);
          const decision = typeof record.decision === "string" ? record.decision : "denied";
          yield* publish({
            type: "request.resolved",
            ...(yield* nextStamp()),
            provider: options.provider,
            threadId: ctx.threadId,
            turnId: t3TurnIdFor(ctx, pending?.mspTurnId),
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              requestType: pending?.requestType ?? "unknown",
              decision,
            },
            raw: { source: "msp.jsonrpc", method: "approval/resolved", payload: params },
          });
          return;
        }
        case "userInput/settled": {
          const record = asRecord(params);
          const userInputId =
            typeof record.userInputId === "string" ? record.userInputId : undefined;
          if (!userInputId) return;
          const requestId = ctx.userInputsByMspId.get(userInputId);
          if (!requestId) return;
          ctx.userInputsByMspId.delete(userInputId);
          ctx.pendingUserInputs.delete(requestId);
          yield* publish({
            type: "user-input.resolved",
            ...(yield* nextStamp()),
            provider: options.provider,
            threadId: ctx.threadId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: asRecord(record.answers) },
            raw: { source: "msp.jsonrpc", method: "userInput/settled", payload: params },
          });
          return;
        }
        case "session/statusChanged": {
          const record = asRecord(params);
          const status = typeof record.status === "string" ? record.status : "idle";
          yield* publish({
            type: "session.state.changed",
            ...(yield* nextStamp()),
            provider: options.provider,
            threadId: ctx.threadId,
            payload: { state: mspSessionStateToRuntime(status) },
            raw: { source: "msp.jsonrpc", method, payload: params },
          });
          return;
        }
        case "session/tokenUsage": {
          const usage = params as MspSessionTokenUsage;
          yield* publish({
            type: "thread.token-usage.updated",
            ...(yield* nextStamp()),
            provider: options.provider,
            threadId: ctx.threadId,
            turnId: t3TurnIdFor(ctx, usage.turnId),
            payload: {
              usage: {
                usedTokens: usage.cumulative.totalTokens,
                totalProcessedTokens: usage.cumulative.totalTokens,
                inputTokens: usage.cumulative.promptTokens,
                outputTokens: usage.cumulative.outputTokens,
                cachedInputTokens: usage.usage.cachedTokens,
                lastInputTokens: usage.promptTokens,
                lastOutputTokens: usage.usage.outputTokens,
                lastReasoningOutputTokens: usage.usage.reasoningTokens,
                ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
              },
            },
            raw: { source: "msp.jsonrpc", method, payload: params },
          });
          return;
        }
        case "session/contextUsage": {
          const usage = params as MspSessionContextUsage;
          yield* publish({
            type: "thread.token-usage.updated",
            ...(yield* nextStamp()),
            provider: options.provider,
            threadId: ctx.threadId,
            payload: {
              usage: {
                usedTokens: usage.usedTokens,
                ...(usage.windowTokens !== undefined ? { maxTokens: usage.windowTokens } : {}),
              },
            },
            raw: { source: "msp.jsonrpc", method, payload: params },
          });
          return;
        }
        case "session/modelChanged": {
          const record = asRecord(params);
          const modelId = typeof record.modelId === "string" ? record.modelId : undefined;
          if (modelId) {
            ctx.session = { ...ctx.session, model: modelId, updatedAt: yield* now };
          }
          return;
        }
        case "session/closed": {
          yield* publish({
            type: "session.exited",
            ...(yield* nextStamp()),
            provider: options.provider,
            threadId: ctx.threadId,
            payload: { exitKind: "graceful", reason: "MSP session closed by the host." },
            raw: { source: "msp.jsonrpc", method, payload: params },
          });
          return;
        }
        default:
          return;
      }
    });

  const startSession = (input: ProviderSessionStartInput) =>
    withLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== options.provider) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: `Expected provider '${options.provider}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopInternal(existing);
        const cwd = path.resolve(input.cwd.trim());
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred
            ? Effect.void
            : Effect.ignore(Scope.close(sessionScope, Exit.void)),
        );

        const ctx: ExternalMspSessionContext = {
          threadId: input.threadId,
          session: undefined as never,
          scope: sessionScope,
          host: undefined as never,
          mspSessionId: "",
          pendingApprovals: new Map(),
          approvalsByMspId: new Map(),
          pendingUserInputs: new Map(),
          userInputsByMspId: new Map(),
          pendingTurns: new Map(),
          items: new Map(),
          turns: [],
          mspToT3TurnId: new Map(),
          activeTurnId: undefined,
          promptsInFlight: 0,
          stopped: false,
        };

        const host = yield* makeMspSessionHost({
          spawn: options.spawn(cwd, options.environment),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Scope.Scope, sessionScope),
          mapError(input.threadId, "spawn"),
        );
        ctx.host = host;

        yield* Stream.runForEach(host.notifications, (notification) =>
          Effect.flatMap(logNative(input.threadId, notification), () =>
            handleNotification(ctx, notification.method, notification.params).pipe(Effect.ignore),
          ),
        ).pipe(Effect.forkIn(sessionScope));
        yield* Stream.runForEach(host.serverRequests, (request) =>
          Effect.flatMap(logNative(input.threadId, request), () =>
            (request.method === "approval/request"
              ? handleApprovalRequest(ctx, request.params)
              : handleUserInputRequest(ctx, request.params)
            ).pipe(Effect.ignore),
          ),
        ).pipe(Effect.forkIn(sessionScope));

        const initializeResult = yield* host
          .request("initialize", {
            clientInfo: { name: MSP_CLIENT_NAME, title: "T3 Code", version: "0.0.0" },
            capabilities: {
              userInputDialogs: true,
              requestedCapabilities: ["sessionMcp"],
            },
          })
          .pipe(mapError(input.threadId, "initialize"));
        yield* host.notify("initialized", {}).pipe(mapError(input.threadId, "initialized"));

        const grantedCapabilities = asRecord(initializeResult).grantedCapabilities;
        const sessionMcpGranted =
          Array.isArray(grantedCapabilities) && grantedCapabilities.includes("sessionMcp");

        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const resumeSessionId = parseResumeCursor(input.resumeCursor);
        const selectedModel = input.modelSelection?.model ?? options.defaultModel;
        const approvalMode = mspApprovalModeForRuntimeMode(input.runtimeMode);
        if (mcpSession && !sessionMcpGranted) {
          yield* publish({
            type: "runtime.warning",
            ...(yield* nextStamp()),
            provider: options.provider,
            threadId: input.threadId,
            payload: {
              message:
                "Muse did not grant the sessionMcp capability; the T3 Code MCP bridge is unavailable for this session.",
            },
          });
        }
        const sessionConfig =
          mcpSession && sessionMcpGranted
            ? {
                config: {
                  mcpServers: {
                    "t3-code": {
                      transport: "streamableHttp" as const,
                      url: mcpSession.endpoint,
                      headers: { Authorization: mcpSession.authorizationHeader },
                    },
                  },
                },
              }
            : {};

        let mspSession: MspSessionInfo;
        let historyItems: ReadonlyArray<MspItem> = [];
        if (resumeSessionId) {
          const resumed = yield* host
            .request("session/resume", {
              commandId: yield* uuid7,
              sessionId: resumeSessionId,
              ...sessionConfig,
            })
            .pipe(mapError(input.threadId, "session/resume"));
          const record = asRecord(resumed);
          mspSession = record.session as MspSessionInfo;
          const history = asRecord(record.history);
          if (Array.isArray(history.items)) {
            historyItems = history.items as ReadonlyArray<MspItem>;
          }
        } else {
          const started = yield* host
            .request("session/start", {
              commandId: yield* uuid7,
              workspaceRoot: cwd,
              ...(selectedModel ? { modelId: selectedModel } : {}),
              approvalMode,
              ...sessionConfig,
            })
            .pipe(mapError(input.threadId, "session/start"));
          mspSession = asRecord(started).session as MspSessionInfo;
        }
        if (!mspSession?.sessionId) {
          return yield* new ProviderAdapterProcessError({
            provider: options.provider,
            threadId: input.threadId,
            detail: "MSP session host returned no session.",
          });
        }
        ctx.mspSessionId = mspSession.sessionId;

        if (selectedModel && selectedModel !== mspSession.modelId) {
          yield* host
            .request("session/setModel", {
              commandId: yield* uuid7,
              sessionId: mspSession.sessionId,
              model: { modelId: selectedModel },
            })
            .pipe(Effect.catch(() => Effect.void));
        }

        // Rebuild in-memory turn snapshots from resumed history.
        for (const item of historyItems) {
          ctx.items.set(item.itemId, item);
          const mspTurnId = item.turnId ?? "unknown";
          const t3TurnId = ctx.mspToT3TurnId.get(mspTurnId) ?? TurnId.make(mspTurnId);
          ctx.mspToT3TurnId.set(mspTurnId, t3TurnId);
          let turn = ctx.turns.find((entry) => entry.id === t3TurnId);
          if (!turn) {
            turn = { id: t3TurnId, items: [] };
            ctx.turns.push(turn);
          }
          turn.items.push(item);
        }

        const timestamp = yield* now;
        ctx.session = {
          provider: options.provider,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(selectedModel
            ? { model: selectedModel }
            : mspSession.modelId
              ? { model: mspSession.modelId }
              : {}),
          threadId: input.threadId,
          resumeCursor: { schemaVersion: RESUME_SCHEMA_VERSION, sessionId: mspSession.sessionId },
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        sessions.set(input.threadId, ctx);
        sessionScopeTransferred = true;
        yield* publish({
          type: "session.started",
          ...(yield* nextStamp()),
          provider: options.provider,
          threadId: input.threadId,
          payload: { resume: initializeResult },
        });
        yield* publish({
          type: "session.state.changed",
          ...(yield* nextStamp()),
          provider: options.provider,
          threadId: input.threadId,
          payload: { state: "ready", reason: "MSP session ready" },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* nextStamp()),
          provider: options.provider,
          threadId: input.threadId,
          payload: { providerThreadId: mspSession.sessionId },
        });
        return ctx.session;
      }).pipe(Effect.scoped),
    );

  const settlePendingForTurn = (ctx: ExternalMspSessionContext, error: MspError) =>
    Effect.gen(function* () {
      for (const pending of ctx.pendingTurns.values()) {
        yield* Deferred.fail(pending.completion, error);
      }
      ctx.pendingTurns.clear();
    });

  const sendTurn = (input: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(input.threadId);
      if (!input.input?.trim() && !input.attachments?.length) {
        return yield* new ProviderAdapterValidationError({
          provider: options.provider,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }
      const selectedModel = input.modelSelection?.model;
      if (selectedModel && selectedModel !== ctx.session.model) {
        yield* ctx.host
          .request("session/setModel", {
            commandId: yield* uuid7,
            sessionId: ctx.mspSessionId,
            model: { modelId: selectedModel },
          })
          .pipe(mapError(input.threadId, "session/setModel"));
        ctx.session = { ...ctx.session, model: selectedModel, updatedAt: yield* now };
      }

      const parts: Array<Record<string, unknown>> = [];
      if (input.input?.trim()) parts.push({ type: "text", text: input.input.trim() });
      for (const attachment of input.attachments ?? []) {
        if (attachment.type !== "image") continue;
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) continue;
        const bytes = yield* fileSystem
          .readFile(attachmentPath)
          .pipe(mapError(input.threadId, "attachment/read"));
        parts.push({
          type: "image",
          base64Data: Buffer.from(bytes).toString("base64"),
          mediaType: attachment.mimeType,
        });
      }

      const commandId = yield* uuid7;
      const t3TurnId = TurnId.make(commandId);
      const completion = yield* Deferred.make<MspTurnCompleted, MspError>();
      ctx.activeTurnId = t3TurnId;
      ctx.promptsInFlight += 1;
      // Register before the request: for fresh turns MSP uses commandId as the
      // turnId, and a fast turn can complete before the ack is processed.
      ctx.mspToT3TurnId.set(commandId, t3TurnId);
      ctx.pendingTurns.set(commandId, { t3TurnId, completion });
      yield* publish({
        type: "turn.started",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId: input.threadId,
        turnId: t3TurnId,
        payload:
          (selectedModel ?? ctx.session.model) ? { model: selectedModel ?? ctx.session.model } : {},
      });
      const ack = yield* ctx.host
        .request("turn/start", {
          commandId,
          sessionId: ctx.mspSessionId,
          input: parts,
          ...(input.input?.trim() ? { displayText: input.input.trim() } : {}),
        })
        .pipe(mapError(input.threadId, "turn/start"));
      const mspTurnId =
        typeof asRecord(ack).turnId === "string" ? (asRecord(ack).turnId as string) : commandId;
      if (mspTurnId !== commandId) {
        // Steered/absorbed submits report a different carrier turn.
        ctx.pendingTurns.delete(commandId);
        ctx.mspToT3TurnId.set(mspTurnId, t3TurnId);
        ctx.pendingTurns.set(mspTurnId, { t3TurnId, completion });
      }
      ctx.session = { ...ctx.session, activeTurnId: t3TurnId, updatedAt: yield* now };
      ctx.turns.push({ id: t3TurnId, items: [] });

      const completed = yield* Deferred.await(completion).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
          }),
        ),
        mapError(input.threadId, "turn/completed"),
      );
      yield* publish({
        type: "turn.completed",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId: input.threadId,
        turnId: t3TurnId,
        payload: {
          state: mspTurnTerminalToRuntime(completed.terminal),
          stopReason: completed.reason ?? completed.terminal,
          ...(completed.usage ? { usage: completed.usage } : {}),
          ...(completed.error ? { errorMessage: completed.error.message } : {}),
        },
      });
      return { threadId: input.threadId, turnId: t3TurnId, resumeCursor: ctx.session.resumeCursor };
    });

  const interruptTurn = (threadId: ThreadId, _turnId?: TurnId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const mspTurnId = [...ctx.mspToT3TurnId.entries()].find(([, t3]) => t3 === _turnId)?.[0];
      yield* ctx.host
        .request("turn/interrupt", {
          commandId: yield* uuid7,
          sessionId: ctx.mspSessionId,
          ...(mspTurnId ? { turnId: mspTurnId } : {}),
          retract: true,
        })
        .pipe(mapError(threadId, "turn/interrupt"));
    });

  const respondToRequest = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: options.provider,
          method: "approval/decide",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      const choiceId = mspChoiceIdForDecision(pending.choices, decision);
      if (!choiceId) {
        return yield* new ProviderAdapterRequestError({
          provider: options.provider,
          method: "approval/decide",
          detail: `No MSP approval choice maps to decision '${decision}'.`,
        });
      }
      yield* ctx.host
        .request("approval/decide", {
          commandId: yield* uuid7,
          sessionId: ctx.mspSessionId,
          approvalId: pending.mspApprovalId,
          choiceId,
          requirementId: pending.requirementId,
        })
        .pipe(mapError(threadId, "approval/decide"));
      ctx.pendingApprovals.delete(requestId);
      ctx.approvalsByMspId.delete(pending.mspApprovalId);
      yield* publish({
        type: "request.resolved",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId,
        turnId: t3TurnIdFor(ctx, pending.mspTurnId),
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType: pending.requestType, decision },
      });
    });

  const respondToUserInput = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: options.provider,
          method: "userInput/answer",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      yield* ctx.host
        .request("userInput/answer", {
          commandId: yield* uuid7,
          sessionId: ctx.mspSessionId,
          userInputId: pending.userInputId,
          answers: Object.entries(answers).map(([questionId, value]) =>
            canonicalAnswerToMsp(questionId, value),
          ),
        })
        .pipe(mapError(threadId, "userInput/answer"));
      ctx.pendingUserInputs.delete(requestId);
      ctx.userInputsByMspId.delete(pending.userInputId);
      yield* publish({
        type: "user-input.resolved",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId,
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers },
      });
    });

  const readThread = (
    threadId: ThreadId,
  ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
    requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: ctx.turns })));

  const rollbackThread = (threadId: ThreadId, numTurns: number) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: options.provider,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
      return { threadId, turns: ctx.turns };
    });

  const stopInternal = (ctx: ExternalMspSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      yield* settlePendingForTurn(
        ctx,
        new MspError({ operation: "stop", detail: "MSP session stopped." }),
      );
      yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      sessions.delete(ctx.threadId);
      yield* publish({
        type: "session.exited",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId: ctx.threadId,
        payload: { exitKind: "graceful" },
      });
    });

  const stopSession = (threadId: ThreadId) =>
    withLock(threadId, requireSession(threadId).pipe(Effect.flatMap(stopInternal)));
  const listSessions = () =>
    Effect.succeed(Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
  const hasSession = (threadId: ThreadId) =>
    Effect.succeed(sessions.get(threadId)?.stopped === false);
  const stopAll = () => Effect.forEach(sessions.values(), stopInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.ignore(stopAll()).pipe(Effect.andThen(PubSub.shutdown(runtimeEvents))),
  );

  return {
    provider: options.provider,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) =>
      startSession(input).pipe(
        Effect.mapError((cause) => toAdapterError(input.threadId, "startSession", cause)),
      ),
    sendTurn: (input) =>
      sendTurn(input).pipe(
        Effect.mapError((cause) => toAdapterError(input.threadId, "sendTurn", cause)),
      ),
    interruptTurn: (threadId, turnId) =>
      interruptTurn(threadId, turnId).pipe(
        Effect.mapError((cause) => toAdapterError(threadId, "interruptTurn", cause)),
      ),
    respondToRequest: (threadId, requestId, decision) =>
      respondToRequest(threadId, requestId, decision).pipe(
        Effect.mapError((cause) => toAdapterError(threadId, "respondToRequest", cause)),
      ),
    respondToUserInput: (threadId, requestId, answers) =>
      respondToUserInput(threadId, requestId, answers).pipe(
        Effect.mapError((cause) => toAdapterError(threadId, "respondToUserInput", cause)),
      ),
    stopSession: (threadId) =>
      stopSession(threadId).pipe(
        Effect.mapError((cause) => toAdapterError(threadId, "stopSession", cause)),
      ),
    listSessions,
    hasSession,
    readThread: (threadId) =>
      readThread(threadId).pipe(
        Effect.mapError((cause) => toAdapterError(threadId, "readThread", cause)),
      ),
    rollbackThread: (threadId, numTurns) =>
      rollbackThread(threadId, numTurns).pipe(
        Effect.mapError((cause) => toAdapterError(threadId, "rollbackThread", cause)),
      ),
    stopAll: () =>
      stopAll().pipe(
        Effect.mapError((cause) => toAdapterError(ThreadId.make("all"), "stopAll", cause)),
      ),
    streamEvents: Stream.fromPubSub(runtimeEvents),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
