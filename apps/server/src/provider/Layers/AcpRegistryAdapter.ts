import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  TurnId,
  type AcpRegistrySettings,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnCompletedPayload,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  acpClientExecuteDisposition,
  acpMcpToolApprovalElicitationDisposition,
  acpPermissionDisposition,
  makeAcpClientPolicyGrants,
  type AcpRuntimePolicy,
} from "../acp/AcpClientPolicy.ts";
import {
  makeAcpClientTerminals,
  resolveEmbeddedTerminalContent,
  type AcpClientTerminals,
} from "../acp/AcpClientTerminals.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  normalizeAcpRegistryCommands,
  normalizeAcpRegistryLiveConfiguration,
  normalizeAcpRegistryWebUrl,
} from "../acp/AcpRegistryProbe.ts";
import { AcpRegistryRuntimeCoordinator } from "../acp/AcpRegistryRuntimeCoordinator.ts";
import { AcpRegistryCatalog } from "../acp/AcpRegistrySupport.ts";
import { parsePermissionRequest, type AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { ACP_SESSION_MODE_OPTION_ID } from "../acp/AcpSessionConfig.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { acpT3McpServers, serveAcpMcpOverAcp } from "../acp/AcpT3Mcp.ts";
import type { AcpRegistryAdapterShape } from "../Services/AcpRegistryAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("acpRegistry");
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);
const isAcpError = Schema.is(EffectAcpErrors.AcpError);
const CANCELLED = { outcome: { outcome: "cancelled" } } as const;

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type NativePermission = EffectAcpSchema.RequestPermissionRequest;
type NativePermissionResponse = EffectAcpSchema.RequestPermissionResponse;
type NativeElicitation = EffectAcpSchema.CreateElicitationRequest;
type NativeElicitationResponse = EffectAcpSchema.CreateElicitationResponse;

export interface AcpRegistryAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  /** The instance environment merged over the host environment, as chat and sign-in use it. */
  readonly environment: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
}

/** An approval shown in the thread. The user may answer only with an offered choice. */
interface PendingApproval {
  readonly options: ReadonlyArray<ProviderApprovalOption>;
  readonly response: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingQuestion {
  readonly response: Deferred.Deferred<ProviderUserInputAnswers | undefined>;
}

/** Mode and plan-sensitive config values to restore when the thread leaves plan mode. */
interface BuildConfiguration {
  readonly modeId: string | undefined;
  readonly configOptions: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly nativeSessionId: string;
  readonly harness: string;
  readonly supportsImages: boolean;
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly questions: Map<ApprovalRequestId, PendingQuestion>;
  /** URL sign-ins waiting on the provider card. Completing one answers the agent with cancel. */
  readonly urlAuthentications: Set<Deferred.Deferred<void>>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly grants: ReturnType<typeof makeAcpClientPolicyGrants>;
  session: ProviderSession;
  buildConfiguration: BuildConfiguration | undefined;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  generation: number;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
}

function selectOptionId(
  request: NativePermission,
  kinds: ReadonlyArray<EffectAcpSchema.PermissionOption["kind"]>,
): string | undefined {
  for (const kind of kinds) {
    const optionId = request.options.find((option) => option.kind === kind)?.optionId.trim();
    if (optionId) return optionId;
  }
  return undefined;
}

function permissionResponse(optionId: string | undefined): NativePermissionResponse {
  return optionId === undefined ? CANCELLED : { outcome: { outcome: "selected", optionId } };
}

/** The choices shown to the user are the ones the agent offered. */
function acpRegistryApprovalOptions(
  request: NativePermission,
): ReadonlyArray<ProviderApprovalOption> {
  const offered = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind && option.optionId.trim());
  return [
    ...(offered("allow_once") ? [{ decision: "accept" as const, label: "Allow once" }] : []),
    ...(offered("allow_always")
      ? [{ decision: "acceptForSession" as const, label: "Allow for this thread" }]
      : []),
    ...(offered("reject_once") || offered("reject_always")
      ? [{ decision: "decline" as const, label: "Deny" }]
      : []),
    { decision: "cancel", label: "Cancel" },
  ];
}

function optionIdForDecision(request: NativePermission, decision: ProviderApprovalDecision) {
  switch (decision) {
    case "accept":
      return selectOptionId(request, ["allow_once"]);
    case "acceptForSession":
      return selectOptionId(request, ["allow_always"]);
    case "decline":
      return selectOptionId(request, ["reject_once", "reject_always"]);
    case "cancel":
      return undefined;
  }
}

/** An MCP tool approval answers one elicitation, so it has no per-session choice. */
const MCP_TOOL_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "decline", label: "Deny" },
  { decision: "cancel", label: "Cancel" },
];

function mcpToolApprovalResponse(decision: ProviderApprovalDecision): NativeElicitationResponse {
  switch (decision) {
    case "accept":
    case "acceptForSession":
    case "acceptAlways":
      return { action: "accept", content: {} };
    case "decline":
      return { action: "decline" };
    case "cancel":
      return { action: "cancel" };
  }
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Maps a form elicitation's flat schema onto T3 user-input questions. */
function acpRegistryElicitationQuestions(request: {
  readonly message: string;
  readonly requestedSchema: unknown;
}): ReadonlyArray<UserInputQuestion> {
  const properties = unknownRecord(unknownRecord(request.requestedSchema)?.properties) ?? {};
  return Object.entries(properties).map(([id, property], index) => {
    const record = unknownRecord(property);
    const enumValues = Array.isArray(record?.enum)
      ? record.enum.filter((value): value is string => typeof value === "string")
      : [];
    const options =
      enumValues.length > 0
        ? enumValues.map((value) => ({ label: value, description: value }))
        : record?.type === "boolean"
          ? [
              { label: "true", description: "Yes" },
              { label: "false", description: "No" },
            ]
          : [];
    return {
      id,
      header: nonEmptyText(record?.title, `Question ${index + 1}`),
      question: nonEmptyText(record?.description, nonEmptyText(request.message, "Answer")),
      options,
      ...(options.length === 0 ? { allowCustomAnswer: true } : {}),
      multiSelect: false,
    };
  });
}

/** The JSON schema type of each requested form field, keyed by field name. */
function elicitationFieldTypes(requestedSchema: unknown): ReadonlyMap<string, unknown> {
  const properties = unknownRecord(unknownRecord(requestedSchema)?.properties) ?? {};
  return new Map(
    Object.entries(properties).map(([key, property]) => [key, unknownRecord(property)?.type]),
  );
}

/** Answers arrive as picked labels or typed text; the agent's schema decides the value type. */
function elicitationContent(
  answers: ProviderUserInputAnswers,
  fieldTypes: ReadonlyMap<string, unknown>,
): Record<string, EffectAcpSchema.ElicitationContentValue> {
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!fieldTypes.has(key)) continue;
    const type = fieldTypes.get(key);
    if (type === "boolean" && (value === "true" || value === "false")) {
      content[key] = value === "true";
    } else if (
      (type === "number" || type === "integer") &&
      typeof value === "string" &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    ) {
      content[key] = Number(value);
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      content[key] = value;
    } else if (Array.isArray(value)) {
      content[key] = value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return content;
}

function selectChoices(option: EffectAcpSchema.SessionConfigOption): ReadonlyArray<string> {
  return option.type === "select"
    ? option.options.flatMap((entry) =>
        "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
      )
    : [];
}

// Per-agent exception ported from V2's AcpRegistryAdapterV2: Devin names its
// tools in metadata. Do not add more agent branches to this adapter. An agent
// that needs its own behavior gets a dedicated driver.
function normalizeDevinToolCall(tool: AcpToolCallState): AcpToolCallState {
  const name = unknownRecord(tool.data.meta)?.["cognition.ai/inferenceToolName"];
  return typeof name === "string" && (!tool.title || tool.title === "Tool")
    ? { ...tool, title: name }
    : tool;
}

/**
 * Runs any ACP Registry agent on the V1 orchestrator through the plain ACP
 * spec: one agent process per thread, T3 MCP through `AcpT3Mcp`, and the
 * thread's runtime mode answering permission requests.
 */
export const makeAcpRegistryAdapter = Effect.fn("makeAcpRegistryAdapter")(function* (
  options: AcpRegistryAdapterOptions,
) {
  const catalog = yield* AcpRegistryCatalog;
  const coordinator = yield* Effect.serviceOption(AcpRegistryRuntimeCoordinator);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
  const selfInvocation = yield* resolveSelfInvocation();
  const { instanceId, settings } = options;
  // Per-agent exception ported from V2 (see normalizeDevinToolCall): Devin
  // runs commands through client terminals and has no ask mode over ACP to
  // fall back on. Every other registry agent runs its own tools.
  const isDevin = settings.agentId === "devin";
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create an ACP event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: nowIso,
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const policyFor = (context: SessionContext): AcpRuntimePolicy => ({
    runtimeMode: context.session.runtimeMode,
    cwd: context.cwd,
  });

  const mapError = (threadId: ThreadId, method: string, cause: EffectAcpErrors.AcpError) =>
    cause._tag === "AcpRequestError" && cause.code === -32000
      ? new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `${settings.agentId || "The ACP agent"} requires sign-in. Sign in from provider settings, then try again.`,
          cause,
        })
      : mapAcpToAdapterError(PROVIDER, threadId, method, cause);

  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
      );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const cancelRequests = Effect.fn("AcpRegistryAdapter.cancelRequests")(function* (
    context: SessionContext,
  ) {
    for (const pending of context.approvals.values()) {
      yield* Deferred.succeed(pending.response, "cancel");
    }
    for (const pending of context.questions.values()) {
      yield* Deferred.succeed(pending.response, undefined);
    }
    for (const cancelled of context.urlAuthentications) {
      yield* Deferred.succeed(cancelled, undefined);
    }
  });

  const stopContext = (context: SessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.closed) return;
          context.stopped = true;
          yield* Effect.gen(function* () {
            yield* cancelRequests(context);
            if (context.promptFiber && !context.disconnected) {
              yield* Effect.ignore(context.runtime.cancel);
            }
          }).pipe(Effect.ensuring(Scope.close(context.scope, Exit.void)));
          context.closed = true;
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected ? { reason: "The ACP agent process stopped." } : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  const handlePermission = Effect.fn("AcpRegistryAdapter.handlePermission")(function* (
    context: SessionContext,
    request: NativePermission,
  ): Effect.fn.Return<NativePermissionResponse, ProviderAdapterError> {
    if (context.stopped || request.sessionId !== context.nativeSessionId) return CANCELLED;
    const disposition = acpPermissionDisposition(policyFor(context), request);
    if (disposition === "allow") {
      // Prefer a one-time grant, so a later switch to Supervised still asks.
      return permissionResponse(selectOptionId(request, ["allow_once", "allow_always"]));
    }
    if (disposition === "deny") {
      return permissionResponse(selectOptionId(request, ["reject_once", "reject_always"]));
    }
    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const approvalOptions = acpRegistryApprovalOptions(request);
    const response = yield* Deferred.make<ProviderApprovalDecision>();
    context.approvals.set(requestId, { options: approvalOptions, response });
    const parsed = parsePermissionRequest(request);
    const toolCall =
      parsed.toolCall && isDevin ? normalizeDevinToolCall(parsed.toolCall) : parsed.toolCall;
    const permissionRequest = {
      ...parsed,
      ...(toolCall ? { toolCall } : {}),
      detail:
        toolCall?.command ??
        toolCall?.detail ??
        toolCall?.title ??
        "The agent requests permission.",
    };
    return yield* Effect.gen(function* () {
      yield* emit(
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          approvalOptions,
          detail: permissionRequest.detail,
          args: request,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: request,
        }),
      );
      const decision = yield* Deferred.await(response);
      if (decision === "accept" || decision === "acceptForSession") {
        context.grants.recordApproval({
          kind: permissionRequest.kind === "execute" ? "command" : "file-change",
          scope: decision === "acceptForSession" ? "session" : "turn",
          turnKey: String(turnId),
        });
      }
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          decision,
        }),
      );
      return permissionResponse(optionIdForDecision(request, decision));
    }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
  });

  const handleElicitation = Effect.fn("AcpRegistryAdapter.handleElicitation")(function* (
    context: SessionContext,
    request: NativeElicitation,
    transportRequestId: string,
  ): Effect.fn.Return<NativeElicitationResponse, ProviderAdapterError> {
    if (context.stopped) return { action: "cancel" };
    const mcpDisposition = acpMcpToolApprovalElicitationDisposition(
      policyFor(context),
      request,
      transportRequestId,
    );
    if (mcpDisposition === "allow") return { action: "accept", content: {} };
    if (mcpDisposition === "deny") return { action: "decline" };
    if (mcpDisposition === "ask") {
      // A tool approval is a yes or no, whatever form fields the agent attaches.
      const requestId = ApprovalRequestId.make(yield* randomId);
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const turnId = context.activeTurnId;
      const response = yield* Deferred.make<ProviderApprovalDecision>();
      context.approvals.set(requestId, { options: MCP_TOOL_APPROVAL_OPTIONS, response });
      return yield* Effect.gen(function* () {
        yield* emit({
          type: "request.opened",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: {
            requestType: "mcp_elicitation_approval",
            detail: nonEmptyText(request.message, "The agent asks to run an MCP tool."),
            options: MCP_TOOL_APPROVAL_OPTIONS,
            args: request,
          },
          raw: { source: "acp.jsonrpc", method: "elicitation/create", payload: request },
        });
        const decision = yield* Deferred.await(response);
        yield* emit({
          type: "request.resolved",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: { requestType: "mcp_elicitation_approval", decision },
        });
        return mcpToolApprovalResponse(decision);
      }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
    }
    if (
      request.mode === "url" &&
      "url" in request &&
      typeof request.url === "string" &&
      "elicitationId" in request &&
      typeof request.elicitationId === "string"
    ) {
      const url = normalizeAcpRegistryWebUrl(request.url);
      const elicitationId = request.elicitationId.trim();
      if (url === undefined || !elicitationId || Option.isNone(coordinator)) {
        return { action: "decline" };
      }
      // ACP expects cancel for requests still open when the turn is cancelled.
      const cancelled = yield* Deferred.make<void>();
      context.urlAuthentications.add(cancelled);
      return yield* Effect.raceFirst(
        coordinator.value
          .requestUrlAuthentication(instanceId, {
            elicitationId: elicitationId.slice(0, 256),
            url,
            message: request.message.trim().slice(0, 1_024),
          })
          .pipe(
            Effect.map((accepted): NativeElicitationResponse => ({
              action: accepted ? "accept" : "decline",
            })),
          ),
        Deferred.await(cancelled).pipe(Effect.as<NativeElicitationResponse>({ action: "cancel" })),
      ).pipe(Effect.ensuring(Effect.sync(() => context.urlAuthentications.delete(cancelled))));
    }
    // Modes beyond form and url decline rather than guess at their meaning.
    if (request.mode !== "form" || !("requestedSchema" in request)) return { action: "decline" };
    const questions = acpRegistryElicitationQuestions({
      message: request.message,
      requestedSchema: request.requestedSchema,
    });
    if (questions.length === 0) return { action: "decline" };
    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const fieldTypes = elicitationFieldTypes(request.requestedSchema);
    const response = yield* Deferred.make<ProviderUserInputAnswers | undefined>();
    context.questions.set(requestId, { response });
    return yield* Effect.gen(function* () {
      yield* emit({
        type: "user-input.requested",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        turnId,
        requestId: runtimeRequestId,
        payload: { questions },
        raw: { source: "acp.jsonrpc", method: "elicitation/create", payload: request },
      });
      const answers = yield* Deferred.await(response);
      // A cancelled question still resolves, so the thread stops offering it.
      yield* emit({
        type: "user-input.resolved",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: context.threadId,
        turnId,
        requestId: runtimeRequestId,
        payload: { answers: answers ?? {} },
      });
      if (answers === undefined) return { action: "cancel" } as const;
      return { action: "accept", content: elicitationContent(answers, fieldTypes) } as const;
    }).pipe(Effect.ensuring(Effect.sync(() => context.questions.delete(requestId))));
  });

  const handleEvent = Effect.fn("AcpRegistryAdapter.handleEvent")(function* (
    context: SessionContext,
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
  ) {
    if (event._tag === "EventStreamBarrier") {
      yield* Deferred.succeed(event.acknowledge, undefined);
      return;
    }
    if (context.stopped) return;
    switch (event._tag) {
      case "AvailableCommandsUpdated":
        if (Option.isSome(coordinator)) {
          yield* coordinator.value.publishAvailableCommands(
            instanceId,
            normalizeAcpRegistryCommands(event.availableCommands),
          );
        }
        return;
      case "ModeChanged":
      case "ConfigOptionsUpdated":
        yield* publishConfiguration(context.runtime);
        return;
      case "ConnectionTerminated":
        context.stopped = true;
        context.disconnected = true;
        yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
        return;
      case "AssistantItemStarted":
      case "AssistantItemCompleted":
        yield* emit(
          makeAcpAssistantItemEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
        return;
      case "ThoughtDelta":
      case "ContentDelta":
        yield* emit(
          makeAcpContentDeltaEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
            ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" } : {}),
            text: event.text,
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "PlanUpdated":
        yield* emit(
          makeAcpPlanUpdatedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "ToolCallUpdated":
        yield* emit(
          makeAcpToolCallEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            toolCall: isDevin ? normalizeDevinToolCall(event.toolCall) : event.toolCall,
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "UsageUpdated":
        yield* emit({
          type: "thread.token-usage.updated",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          payload: { usage: event.usage },
        });
        return;
      case "SessionInfoUpdated":
      case "UnknownUpdate":
        return;
    }
  });

  /** Publishes the agent's live models, options, and modes for the provider snapshot. */
  const publishConfiguration = (runtime: Runtime) =>
    Option.isNone(coordinator)
      ? Effect.void
      : Effect.all([runtime.getConfigOptions, runtime.getModeState]).pipe(
          Effect.flatMap(([configOptions, modeState]) =>
            coordinator.value.publishLiveConfiguration(
              instanceId,
              normalizeAcpRegistryLiveConfiguration(configOptions, modeState),
            ),
          ),
        );

  /**
   * Applies the thread's model, stored agent options, and plan mode. Values
   * the live session no longer offers are skipped so a stale pick cannot
   * block the turn; the agent's default applies instead.
   */
  const configureSession = Effect.fn("AcpRegistryAdapter.configureSession")(function* (
    context: Pick<SessionContext, "runtime" | "buildConfiguration">,
    modelSelection: ModelSelection | undefined,
    interactionMode: ProviderInteractionMode,
  ) {
    const runtime = context.runtime;
    const model = modelSelection?.model;
    if (model && model !== "default" && model !== "auto") {
      // Custom model ids the agent does not list are still sent; the agent decides.
      const modelOption = (yield* runtime.getConfigOptions).find(
        (option) => option.category === "model",
      );
      if (modelOption?.type === "select" && modelOption.currentValue !== model) {
        yield* runtime.setModel(model);
      }
    }
    const selections = modelSelection?.options ?? [];
    const configOptions = yield* runtime.getConfigOptions;
    const nativeModeOption = configOptions.some(
      (option) => option.id === ACP_SESSION_MODE_OPTION_ID,
    );
    for (const selection of selections) {
      if (selection.id === ACP_SESSION_MODE_OPTION_ID && !nativeModeOption) {
        const modeState = yield* runtime.getModeState;
        if (
          typeof selection.value === "string" &&
          modeState?.availableModes.some((mode) => mode.id === selection.value) === true &&
          modeState.currentModeId !== selection.value
        ) {
          yield* runtime.setMode(selection.value);
        }
        continue;
      }
      const option = configOptions.find((candidate) => candidate.id === selection.id);
      if (option === undefined) continue;
      if (
        option.type === "select" &&
        (typeof selection.value !== "string" || !selectChoices(option).includes(selection.value))
      ) {
        continue;
      }
      yield* runtime.setConfigOption(selection.id, selection.value).pipe(
        Effect.catchTags({
          AcpRequestError: (error) =>
            Effect.logWarning("ACP agent rejected a configuration option value", {
              optionId: selection.id,
              detail: error.message,
            }),
        }),
      );
    }

    const modeState = yield* runtime.getModeState;
    const planSensitive = (yield* runtime.getConfigOptions).filter(
      (option) =>
        option.type === "select" &&
        (option.category === "mode" || option.category === "collaboration_mode"),
    );
    if (interactionMode === "plan") {
      context.buildConfiguration ??= {
        modeId: modeState?.currentModeId,
        configOptions: planSensitive.flatMap((option) =>
          option.type === "select" ? [{ id: option.id, value: option.currentValue }] : [],
        ),
      };
      const planMode = modeState?.availableModes.find(
        (mode) => mode.id === "plan" || mode.id === "architect",
      );
      if (planMode && modeState?.currentModeId !== planMode.id) {
        yield* runtime.setMode(planMode.id);
      }
      for (const option of planSensitive) {
        const planValue = selectChoices(option).find(
          (choice) => choice === "plan" || choice === "architect",
        );
        if (option.type === "select" && planValue && option.currentValue !== planValue) {
          yield* runtime.setConfigOption(option.id, planValue);
        }
      }
    } else if (context.buildConfiguration) {
      const saved = context.buildConfiguration;
      context.buildConfiguration = undefined;
      if (
        saved.modeId !== undefined &&
        modeState?.currentModeId !== saved.modeId &&
        modeState?.availableModes.some((mode) => mode.id === saved.modeId) === true
      ) {
        yield* runtime.setMode(saved.modeId);
      }
      for (const value of saved.configOptions) {
        const option = planSensitive.find((candidate) => candidate.id === value.id);
        if (
          option?.type === "select" &&
          option.currentValue !== value.value &&
          selectChoices(option).includes(value.value)
        ) {
          yield* runtime.setConfigOption(option.id, value.value);
        }
      }
    }
    yield* publishConfiguration(runtime);
  });

  const makeRuntime = Effect.fn("AcpRegistryAdapter.makeRuntime")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly resumeSessionId: string | undefined;
    readonly clientTerminals: AcpClientTerminals | undefined;
  }) {
    const clientTerminals = input.clientTerminals;
    const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
    const resolved = yield* catalog.resolve(settings, input.cwd, options.environment).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/start",
            detail: cause.detail,
            cause,
          }),
      ),
    );
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          ...resolved.spawn,
          env: McpProviderSession.withAgentDeviceEnvironment(resolved.spawn.env ?? {}, mcp),
        },
        cwd: input.cwd,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: clientTerminals !== undefined,
          elicitation: { form: {}, ...(Option.isSome(coordinator) ? { url: {} } : {}) },
        },
        // Client terminal output reaches the thread through the tool call
        // that embeds the terminal.
        ...(clientTerminals
          ? {
              transformSessionUpdate: (notification: EffectAcpSchema.SessionNotification) =>
                resolveEmbeddedTerminalContent(notification, clientTerminals.readOutputSnapshot),
            }
          : {}),
        clientInfo: { name: "t3-code", version: "0.0.0" },
        ...(settings.authMethodId ? { authMethodId: settings.authMethodId } : {}),
        ...(mcp ? acpT3McpServers(mcp, selfInvocation) : {}),
        ...makeNativeLoggers({
          nativeEventLogger: options.nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
        }),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(Crypto.Crypto, crypto),
          ),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
    if (mcp) {
      yield* serveAcpMcpOverAcp(runtime, mcp).pipe(Effect.provideService(Crypto.Crypto, crypto));
    }
    return { runtime, harness: resolved.agent.name };
  });

  const startSession: AcpRegistryAdapterShape["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Enable this ACP agent in provider settings before starting a thread.",
          });
        }
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined && input.providerInstanceId !== instanceId) ||
          (input.modelSelection !== undefined && input.modelSelection.instanceId !== instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The ACP provider instance does not match the requested session.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        const cursor = decodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved ACP session is invalid. Start a new thread.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const cwd = path.resolve(input.cwd);
        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() => {
          if (transferred) return Effect.void;
          sessions.delete(input.threadId);
          return Scope.close(sessionScope, Exit.void);
        });

        const handlers: {
          context: SessionContext | undefined;
        } = { context: undefined };
        const grants = makeAcpClientPolicyGrants();
        const clientTerminals = isDevin
          ? yield* makeAcpClientTerminals({
              spawner,
              defaultCwd: cwd,
              environment: options.environment,
              shellCommands: true,
            })
          : undefined;
        if (clientTerminals) {
          yield* Scope.addFinalizer(sessionScope, clientTerminals.disposeAll);
        }

        const startup = Effect.gen(function* () {
          const { runtime, harness } = yield* makeRuntime({
            threadId: input.threadId,
            cwd,
            resumeSessionId: Option.isSome(cursor) ? cursor.value.sessionId : undefined,
            clientTerminals,
          });
          yield* runtime.handleRequestPermission((request) =>
            handlers.context
              ? handlePermission(handlers.context, request).pipe(
                  Effect.mapError((cause) =>
                    EffectAcpErrors.AcpRequestError.internalError(
                      "Could not process an ACP permission request.",
                      undefined,
                      { cause },
                    ),
                  ),
                )
              : Effect.succeed(CANCELLED),
          );
          yield* runtime.handleElicitation((request, requestContext) =>
            handlers.context
              ? handleElicitation(handlers.context, request, requestContext.requestId).pipe(
                  Effect.mapError((cause) =>
                    EffectAcpErrors.AcpRequestError.internalError(
                      "Could not process an ACP elicitation.",
                      undefined,
                      { cause },
                    ),
                  ),
                )
              : Effect.succeed({ action: "cancel" } as const),
          );
          if (clientTerminals) {
            yield* runtime.handleCreateTerminal((request) => {
              const context = handlers.context;
              const disposition = context
                ? acpClientExecuteDisposition(policyFor(context))
                : ("deny" as const);
              return disposition === "allow" ||
                (disposition === "ask" &&
                  context?.grants.allowsExecute(String(context.activeTurnId)) === true)
                ? clientTerminals.create(request)
                : Effect.fail(
                    EffectAcpErrors.AcpRequestError.internalError(
                      disposition === "ask"
                        ? "The active T3 runtime policy requires approval for terminal/create. Request permission with session/request_permission before retrying."
                        : "The active T3 runtime policy does not allow terminal/create.",
                    ),
                  );
            });
            yield* runtime.handleTerminalOutput(clientTerminals.output);
            yield* runtime.handleTerminalWaitForExit(clientTerminals.waitForExit);
            yield* runtime.handleTerminalKill(clientTerminals.kill);
            yield* runtime.handleTerminalRelease(clientTerminals.release);
          }
          const started = yield* runtime.start();
          return { runtime, harness, started };
        });
        const { runtime, harness, started } = yield* (
          Option.isSome(coordinator)
            ? coordinator.value.withForegroundStartup(settings.agentId, startup)
            : startup
        ).pipe(Effect.provideService(Scope.Scope, sessionScope));

        const capabilities = started.initializeResult.agentCapabilities;
        const canResume =
          capabilities?.loadSession === true || capabilities?.sessionCapabilities?.resume != null;
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          cwd,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          // Only agents that can load or resume a session get a cursor, so a
          // restart never asks an agent to reopen a session it cannot.
          ...(canResume
            ? { resumeCursor: { schemaVersion: 1, sessionId: started.sessionId } }
            : {}),
          createdAt,
          updatedAt: createdAt,
        };
        const context: SessionContext = {
          threadId: input.threadId,
          cwd,
          nativeSessionId: started.sessionId,
          harness,
          supportsImages: capabilities?.promptCapabilities?.image === true,
          scope: sessionScope,
          runtime,
          promptLock: yield* Semaphore.make(1),
          stopLock: yield* Semaphore.make(1),
          approvals: new Map(),
          questions: new Map(),
          urlAuthentications: new Set(),
          turns: [],
          grants,
          session,
          buildConfiguration: undefined,
          activeTurnId: undefined,
          promptFiber: undefined,
          generation: 0,
          stopped: false,
          closed: false,
          disconnected: false,
        };
        handlers.context = context;
        sessions.set(input.threadId, context);
        yield* configureSession(context, input.modelSelection, "default");
        yield* Stream.runForEach(runtime.getEvents(), (event) => handleEvent(context, event)).pipe(
          Effect.catchCause(() => Effect.logError("Could not process an ACP runtime event.")),
          Effect.forkIn(sessionScope),
        );
        yield* emit({
          type: "session.started",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* emit({
          type: "session.state.changed",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "ACP session ready" },
        });
        yield* emit({
          type: "thread.started",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });
        yield* runtime.drainEvents;
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        transferred = true;
        return session;
      }).pipe(
        Effect.mapError((cause) =>
          isAcpError(cause) ? mapError(input.threadId, "session/start", cause) : cause,
        ),
        Effect.scoped,
      ),
    );

  const buildPrompt = Effect.fn("AcpRegistryAdapter.buildPrompt")(function* (
    context: SessionContext,
    input: Parameters<AcpRegistryAdapterShape["sendTurn"]>[0],
    model: string | undefined,
  ) {
    const prompt: Array<EffectAcpSchema.ContentBlock> = [];
    const text = input.input?.trim();
    if (text) prompt.push({ type: "text", text });
    // ProviderService already put every attachment's path in the text, so an
    // agent without image support still reaches the file through its tools.
    if (context.supportsImages) {
      for (const attachment of input.attachments ?? []) {
        if (attachment.type !== "image") continue;
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Could not read attachment '${attachment.name}'.`,
                cause,
              }),
          ),
        );
        prompt.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
      }
    }
    if (prompt.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Turn requires non-empty text or attachments.",
      });
    }
    prompt.push({
      type: "text",
      text: buildRuntimeInstructions({ harness: context.harness, model }),
    });
    return prompt;
  });

  const sendTurn: AcpRegistryAdapterShape["sendTurn"] = Effect.fn("AcpRegistryAdapter.sendTurn")(
    function* (input) {
      const context = yield* requireSession(input.threadId);
      if (input.modelSelection && input.modelSelection.instanceId !== instanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "The selected model belongs to another provider instance.",
        });
      }
      const model = input.modelSelection?.model ?? context.session.model;
      const prompt = yield* buildPrompt(context, input, model);
      let intent: TurnIntent | undefined;
      // The caller holds promptLock while it changes or settles the active turn.
      const finishTurn = (turn: TurnIntent, payload: TurnCompletedPayload) =>
        Effect.gen(function* () {
          if (turn.settled || context.stopped || context.generation !== turn.generation) return;
          turn.settled = true;
          context.activeTurnId = undefined;
          context.promptFiber = undefined;
          context.session = {
            ...context.session,
            status: payload.state === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
            ...(payload.errorMessage
              ? { lastError: payload.errorMessage }
              : { lastError: undefined }),
          };
          yield* emit({
            type: "turn.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: turn.turnId,
            payload,
          });
        }).pipe(Effect.uninterruptible);

      return yield* Effect.gen(function* () {
        const launch = yield* context.promptLock.withPermit(
          Effect.gen(function* () {
            yield* requireSession(input.threadId);
            const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
            const steering = context.activeTurnId !== undefined;
            const turn: TurnIntent = { turnId, generation: ++context.generation, settled: false };
            intent = turn;
            context.activeTurnId = turnId;
            if (!steering) {
              yield* emit({
                type: "turn.started",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: model ? { model } : {},
              });
            }
            if (context.promptFiber) {
              yield* cancelRequests(context);
              yield* context.runtime.cancel;
              yield* Fiber.await(context.promptFiber);
            }
            yield* configureSession(
              context,
              input.modelSelection,
              input.interactionMode ?? "default",
            );
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              ...(model ? { model } : {}),
              updatedAt: yield* nowIso,
            };
            const dispatched = yield* Deferred.make<void>();
            const fiber = yield* context.runtime
              .prompt({ prompt }, { dispatched })
              .pipe(Effect.forkIn(context.scope));
            context.promptFiber = fiber;
            // Fiber.join can skip a scope-close waiter when the child is
            // interrupted. Unwrap the Exit after Fiber.await returns.
            yield* Effect.raceFirst(
              Deferred.await(dispatched),
              Fiber.await(fiber).pipe(
                Effect.flatMap((exit) => exit),
                Effect.asVoid,
              ),
            );
            return { turn, fiber };
          }),
        );
        const result = yield* Fiber.await(launch.fiber).pipe(Effect.flatMap((exit) => exit));
        yield* context.runtime.drainEvents;
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const record = context.turns.find((turn) => turn.id === launch.turn.turnId);
        if (record) record.items.push(result);
        else context.turns.push({ id: launch.turn.turnId, items: [result] });
        yield* context.promptLock.withPermit(
          finishTurn(launch.turn, {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason,
          }),
        );
        return {
          threadId: input.threadId,
          turnId: launch.turn.turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isAcpError(cause) ? mapError(input.threadId, "session/prompt", cause) : cause,
        ),
        Effect.tapError((cause) =>
          Effect.suspend(() =>
            intent
              ? context.promptLock.withPermit(
                  finishTurn(intent, { state: "failed", errorMessage: cause.message }),
                )
              : Effect.void,
          ),
        ),
        Effect.onInterrupt(() =>
          context.promptLock.withPermit(
            Effect.gen(function* () {
              const turn = intent;
              if (
                !turn ||
                turn.settled ||
                context.stopped ||
                context.generation !== turn.generation
              )
                return;
              const promptFiber = context.promptFiber;
              yield* cancelRequests(context);
              yield* Effect.ignore(context.runtime.cancel);
              if (promptFiber) yield* Fiber.interrupt(promptFiber);
              yield* finishTurn(turn, { state: "cancelled", stopReason: "cancelled" });
            }),
          ),
        ),
      );
    },
  );

  const interruptTurn: AcpRegistryAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* context.promptLock
        .withPermit(
          Effect.gen(function* () {
            yield* cancelRequests(context);
            yield* context.runtime.cancel;
          }),
        )
        .pipe(Effect.mapError((cause) => mapError(threadId, "session/cancel", cause)));
    });

  const respondToRequest: AcpRegistryAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.approvals.get(requestId);
      if (!pending) {
        // The reactor closes the approval when the detail names it as unknown.
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      if (!pending.options.some((option) => option.decision === decision)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue:
            "The agent did not offer this permission choice. Select one of the offered choices.",
        });
      }
      yield* Deferred.succeed(pending.response, decision);
    });

  const respondToUserInput: AcpRegistryAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.questions.get(requestId);
      if (!pending) {
        // The reactor closes the question when the detail names it as unknown.
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "elicitation/create",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      yield* Deferred.succeed(pending.response, answers);
    });

  const stopSession: AcpRegistryAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
  const stopAll: AcpRegistryAdapterShape["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logError("Could not stop an ACP session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "ACP agents do not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies AcpRegistryAdapterShape;
});
