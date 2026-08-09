import {
  ApprovalRequestId,
  DEFAULT_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { buildCodexDeveloperInstructions } from "../CodexDeveloperInstructions.ts";
const decodeV2TurnStartResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartResponse);

const PROVIDER = ProviderDriverKind.make("codex");

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];

export function hasConfiguredMcpServer(appServerArgs: ReadonlyArray<string> | undefined): boolean {
  return appServerArgs?.some((argument) => argument.includes("mcp_servers.")) === true;
}

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});
const CodexUserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);
const isCodexUserInputAnswerObject = Schema.is(CodexUserInputAnswerObject);

// TODO: Verify `packages/effect-codex-app-server/scripts/generate.ts` so the generated
// `V2TurnStartParams` schema includes `collaborationMode` directly.
const CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);
const decodeCodexTurnSteerParams = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerParams);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexServiceTier = NonNullable<EffectCodexSchema.V2ThreadStartParams["serviceTier"]>;
type CodexThreadItem =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["turns"][number]["items"][number];

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly resumeCursor?: CodexResumeCursor;
  readonly appServerArgs?: ReadonlyArray<string>;
}

export interface CodexSessionRuntimeSendTurnInput {
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<CodexThreadItem>;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

export interface CodexSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, CodexSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<CodexSendTurnResult, CodexSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

export type CodexSessionRuntimeError =
  | CodexErrors.CodexAppServerError
  | CodexSessionRuntimePendingApprovalNotFoundError
  | CodexSessionRuntimePendingUserInputNotFoundError
  | CodexSessionRuntimeInvalidUserInputAnswersError
  | CodexSessionRuntimeThreadIdMissingError
  | CodexSessionRuntimeTurnSteerRejectedError;

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedErrorClass<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedErrorClass<CodexSessionRuntimeThreadIdMissingError>()(
  "CodexSessionRuntimeThreadIdMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex session is missing a provider thread id for ${this.threadId}`;
  }
}

/**
 * The one rejection the runtime may recover from on its own: the steer lost
 * a race with the end of the turn it named, so nothing was delivered and the
 * message can be re-issued as a fresh `turn/start`. Kept as its own literal
 * union so retryability is a type-level property rather than a convention —
 * {@link isRetryableCodexTurnSteerRejection} is the only place that decides.
 */
export const CodexTurnSteerRetryableReason = Schema.Literals([
  "stale-expected-turn-id",
  "turn-interrupting",
]);
export type CodexTurnSteerRetryableReason = typeof CodexTurnSteerRetryableReason.Type;

export const CodexTurnSteerTerminalReason = Schema.Literals([
  // Documented protocol outcome, not a fault: the running turn is a
  // `/review` or manual `/compact`, which never accepts same-turn steering.
  "active-turn-not-steerable",
  // The send asks for a model/effort/service tier/interaction mode the
  // running turn cannot adopt — steering would silently drop the switch.
  "turn-settings-changed",
  // The app-server answered with some other turn: the message may have
  // landed, so re-issuing it risks a double post.
  "turn-id-mismatch",
  // Refused while the runtime still sees the turn running: unclassified, and
  // re-issuing could double post.
  "rejected",
]);
export type CodexTurnSteerTerminalReason = typeof CodexTurnSteerTerminalReason.Type;

export const CodexTurnSteerRejectionReason = Schema.Union([
  CodexTurnSteerRetryableReason,
  CodexTurnSteerTerminalReason,
]);
export type CodexTurnSteerRejectionReason = typeof CodexTurnSteerRejectionReason.Type;

const isCodexTurnSteerRetryableReason = Schema.is(CodexTurnSteerRetryableReason);

export function isRetryableCodexTurnSteerRejection(
  reason: CodexTurnSteerRejectionReason,
): reason is CodexTurnSteerRetryableReason {
  return isCodexTurnSteerRetryableReason(reason);
}

export class CodexSessionRuntimeTurnSteerRejectedError extends Schema.TaggedErrorClass<CodexSessionRuntimeTurnSteerRejectedError>()(
  "CodexSessionRuntimeTurnSteerRejectedError",
  {
    threadId: Schema.String,
    expectedTurnId: Schema.String,
    reason: CodexTurnSteerRejectionReason,
    turnKind: Schema.optionalKey(Schema.String),
    changedSetting: Schema.optionalKey(Schema.String),
    steeredTurnId: Schema.optionalKey(Schema.String),
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  /**
   * A rejected steer never delivers the message, and it never means the
   * session is broken — the running turn keeps going. Callers use this to
   * keep the send out of the session-error path.
   */
  get retryable(): boolean {
    return isRetryableCodexTurnSteerRejection(this.reason);
  }

  override get message(): string {
    switch (this.reason) {
      case "active-turn-not-steerable":
        // `turnKind` is only rendered when the app-server actually named one;
        // a placeholder would read as a real turn kind to the user.
        return this.turnKind
          ? `Codex is running a ${this.turnKind} turn, which does not accept new messages until it finishes.`
          : "Codex is running a turn that does not accept new messages until it finishes.";
      case "turn-settings-changed":
        return `Codex cannot change ${this.changedSetting ?? "turn settings"} while a turn is running; send this message after the current turn finishes.`;
      case "turn-id-mismatch":
        return `Codex steered turn ${this.steeredTurnId ?? "an unnamed turn"} instead of the expected active turn ${this.expectedTurnId}.`;
      case "stale-expected-turn-id":
        return `Codex turn ${this.expectedTurnId} ended before the message reached it${
          this.detail ? `: ${this.detail}` : "."
        }`;
      case "turn-interrupting":
        return `Codex turn ${this.expectedTurnId} is stopping; the message was not sent.`;
      default:
        return `Codex rejected steering turn ${this.expectedTurnId}${
          this.detail ? `: ${this.detail}` : "."
        }`;
    }
  }
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: string;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ApprovalCorrelation {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

function makeCodexServerNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexServerNotification {
  return { method, params } as CodexServerNotification;
}

function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }
  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }
  return normalized;
}

function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return isCodexResumeCursorSchema(resumeCursor) ? resumeCursor.threadId : undefined;
}

function runtimeModeToThreadConfig(input: RuntimeMode): {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
  // Always explicit: omitting the field on resume keeps the thread's previous
  // reviewer, which would leave auto_review sticky after switching modes.
  readonly approvalsReviewer: EffectCodexSchema.V2ThreadStartParams__ApprovalsReviewer;
} {
  switch (input) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      };
  }
}

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
}): EffectCodexSchema.V2ThreadStartParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  return {
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    approvalsReviewer: config.approvalsReviewer,
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

function runtimeModeToTurnSandboxPolicy(
  input: RuntimeMode,
): EffectCodexSchema.V2TurnStartParams__SandboxPolicy {
  switch (input) {
    case "approval-required":
      return {
        type: "readOnly",
      };
    case "auto-accept-edits":
    case "auto":
      return {
        type: "workspaceWrite",
      };
    case "full-access":
    default:
      return {
        type: "dangerFullAccess",
      };
  }
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
}): EffectCodexSchema.V2TurnStartParams__CollaborationMode | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL;
  const reasoningEffort = input.effort ?? "medium";
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: buildCodexDeveloperInstructions(input.interactionMode, {
        model,
        reasoningEffort,
      }),
    },
  };
}

export function buildTurnStartParams(input: {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly interactionMode?: ProviderInteractionMode;
}): Effect.Effect<
  CodexTurnStartParamsWithCollaborationMode,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnStartParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });

  return decodeCodexTurnStartParamsWithCollaborationMode({
    threadId: input.threadId,
    input: turnInput,
    approvalPolicy: config.approvalPolicy,
    approvalsReviewer: config.approvalsReviewer,
    sandboxPolicy: runtimeModeToTurnSandboxPolicy(input.runtimeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }).pipe(
    Effect.mapError((cause) =>
      CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
        "decode-request-payload",
        cause,
        { method: "turn/start" },
      ),
    ),
  );
}

/**
 * Steering carries the message and nothing else: the wire contract has no
 * model, effort, sandbox or collaboration fields because the turn that is
 * already running keeps the settings it started with. `expectedTurnId` is a
 * precondition — the app-server fails the request when it is not the turn
 * currently active on the thread.
 */
export function buildTurnSteerParams(input: {
  readonly threadId: string;
  readonly expectedTurnId: TurnId;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
}): Effect.Effect<
  EffectCodexSchema.V2TurnSteerParams,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnSteerParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  return decodeCodexTurnSteerParams({
    threadId: input.threadId,
    expectedTurnId: input.expectedTurnId,
    input: turnInput,
  }).pipe(
    Effect.mapError((cause) =>
      CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
        "decode-request-payload",
        cause,
        { method: "turn/steer" },
      ),
    ),
  );
}

function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }
    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread")) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"];

type CodexThreadOpenMethod = "thread/start" | "thread/resume";

interface CodexThreadOpenClient {
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resumeThreadId: string | undefined;
}): Effect.Effect<CodexThreadOpenResponse, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;
  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
  });

  if (resumeThreadId === undefined) {
    return input.client.request("thread/start", startParams);
  }

  return input.client
    .request("thread/resume", {
      threadId: resumeThreadId,
      ...startParams,
    })
    .pipe(
      Effect.catchIf(isRecoverableThreadResumeError, (error) =>
        Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId: input.threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error,
        }).pipe(Effect.andThen(input.client.request("thread/start", startParams))),
      ),
    );
};

function readNotificationThreadId(notification: CodexServerNotification): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: TurnId.make(notification.params.turn.id),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "item/started":
    case "item/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.item.id),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.itemId),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

/**
 * Native collab child-agent tracking (multi-agent v2). Under v2 subagents are
 * full app-server threads: identity arrives on `thread/started` with
 * source.subAgent.thread_spawn, lifecycle on `subAgentActivity` items and the
 * child thread's own turn/status/tokenUsage notifications. The runtime
 * registers children from those explicit signals, intercepts their
 * notifications before parent-timeline mapping, and re-emits them as
 * synthetic `collabAgent/*` provider events the adapter turns into task.*
 * runtime events (timelineBypass keeps them out of the parent chat).
 *
 * WIP, probe-gated: registration is deliberately explicit-signals-only. The
 * spec's "provisionally treat unknown foreign thread ids as v2 children" rule
 * needs a live wire capture of the packaged binary before it lands — blind
 * capture risks eating unrelated traffic. Until then a child whose first
 * notification precedes registration passes through as today (no regression
 * vs main, which passes everything through).
 */
interface CollabChildAgentState {
  readonly agentThreadId: string;
  readonly nickname: string | undefined;
  readonly role: string | undefined;
  readonly agentPath: string | undefined;
  readonly depth: number | undefined;
  readonly parentThreadId: string | undefined;
  /**
   * Parent canonical turn active when the child registered. Stamped on every
   * synthetic collabAgent/* event so clients can batch a fleet by its spawn
   * turn — without it, separate fleets in one thread collapsed into a single
   * "direct:no-turn" CTA (review finding).
   */
  readonly spawnTurnId: TurnId | undefined;
}

function readThreadSpawnSource(thread: { readonly source: unknown }):
  | {
      nickname: string | undefined;
      role: string | undefined;
      agentPath: string | undefined;
      depth: number | undefined;
      parentThreadId: string | undefined;
    }
  | undefined {
  const source = thread.source;
  if (typeof source !== "object" || source === null || !("subAgent" in source)) {
    return undefined;
  }
  const subAgent = (source as { subAgent: unknown }).subAgent;
  if (typeof subAgent !== "object" || subAgent === null || !("thread_spawn" in subAgent)) {
    return undefined;
  }
  const spawn = (subAgent as { thread_spawn: unknown }).thread_spawn;
  if (typeof spawn !== "object" || spawn === null) {
    return undefined;
  }
  const record = spawn as Record<string, unknown>;
  return {
    nickname: typeof record.agent_nickname === "string" ? record.agent_nickname : undefined,
    role: typeof record.agent_role === "string" ? record.agent_role : undefined,
    agentPath: typeof record.agent_path === "string" ? record.agent_path : undefined,
    depth: typeof record.depth === "number" ? record.depth : undefined,
    parentThreadId:
      typeof record.parent_thread_id === "string" ? record.parent_thread_id : undefined,
  };
}

function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  if (notification.params.item.type !== "collabAgentToolCall") {
    return;
  }

  for (const receiverThreadId of notification.params.item.receiverThreadIds) {
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

/**
 * How a notification addressed to a REGISTERED child thread is handled.
 *
 * Exported and pure so the routing table can be asserted against captured
 * wire traces (see codexMultiAgentWire.json) rather than only read.
 *
 * - "agent-event": map to a synthetic collabAgent/* event (Agents surface).
 * - "parent": pass through to the parent path — it carries state the parent
 *   still owns (approval correlation cleanup).
 * - "drop": genuine child chatter with no parent meaning (deltas, name and
 *   plan updates).
 *
 * Default is "drop" ONLY for the enumerated chatter; anything unrecognized
 * routes to "parent" so new wire methods surface instead of vanishing
 * (two shipped bugs came from a catch-all that swallowed everything).
 */
export type CodexChildNotificationRoute = "agent-event" | "parent" | "drop";

const CHILD_AGENT_EVENT_METHODS: ReadonlySet<string> = new Set([
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "item/started",
  "item/completed",
  "thread/closed",
  "error",
]);

const CHILD_CHATTER_METHODS: ReadonlySet<string> = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/plan/delta",
  "turn/plan/updated",
  "turn/diff/updated",
  "thread/name/updated",
  "thread/settings/updated",
  "rawResponseItem/completed",
  // Child-owned thread lifecycle: the parent adapter maps these onto the
  // PARENT thread (archived/compacted state), so a child compacting would
  // rewrite the parent. Mirrors the v1 suppressor list — dropping them is
  // the pre-existing behavior for collab children (review finding).
  "thread/archived",
  "thread/unarchived",
  "thread/compacted",
  // Registration path 1 handles a child's first thread/started; a repeat
  // must not reach the parent (it would restart the parent's thread state).
  "thread/started",
]);

export function routeCodexChildNotification(method: string): CodexChildNotificationRoute {
  if (CHILD_AGENT_EVENT_METHODS.has(method)) {
    return "agent-event";
  }
  if (CHILD_CHATTER_METHODS.has(method)) {
    return "drop";
  }
  // Unknown or parent-owned (serverRequest/resolved, approvals, …).
  return "parent";
}

function toCodexUserInputAnswer(
  questionId: string,
  value: ProviderUserInputAnswers[string],
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse__ToolRequestUserInputAnswer,
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  if (typeof value === "string") {
    return Effect.succeed({ answers: [value] });
  }
  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return Effect.succeed({ answers });
  }
  if (isCodexUserInputAnswerObject(value)) {
    return Effect.succeed({ answers: value.answers });
  }
  return Effect.fail(new CodexSessionRuntimeInvalidUserInputAnswersError({ questionId }));
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse["answers"],
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  return Effect.forEach(
    Object.entries(answers),
    ([questionId, value]) =>
      toCodexUserInputAnswer(questionId, value).pipe(
        Effect.map((answer) => [questionId, answer] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession> | ((session: ProviderSession) => Partial<ProviderSession>),
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      ...(typeof updates === "function" ? updates(session) : updates),
      updatedAt,
    }));
  });
}

function parseThreadSnapshot(
  response: EffectCodexSchema.V2ThreadReadResponse | EffectCodexSchema.V2ThreadRollbackResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      items: turn.items,
    })),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * JSON-RPC code every steer rejection captured against codex-cli 0.147.0
 * carries. Anything else is not a steer precondition failure.
 */
const CODEX_STEER_REJECTION_CODE = -32600;

/**
 * Matching on message text is unavoidable here: captured codex-cli 0.147.0
 * responses carry no structured error data. Keep the two observed refusals
 * distinct. "No active" permits a fresh start only after the serialized
 * runtime view is also idle; "found B" proves B is running and must never
 * directly fall back to turn/start.
 */
function isNoActiveTurnRejection(cause: CodexErrors.CodexAppServerRequestError): boolean {
  return (
    cause.code === CODEX_STEER_REJECTION_CODE &&
    cause.errorMessage.trim().toLowerCase().startsWith("no active turn to steer")
  );
}

function readFoundActiveTurnId(cause: CodexErrors.CodexAppServerRequestError): TurnId | undefined {
  if (cause.code !== CODEX_STEER_REJECTION_CODE) {
    return undefined;
  }
  const match = /^expected active turn id `[^`]+` but found `([^`]+)`/i.exec(
    cause.errorMessage.trim(),
  );
  return match?.[1] ? TurnId.make(match[1]) : undefined;
}

/**
 * Reads the `activeTurnNotSteerable` codex error info the generated schema
 * declares as a `CodexErrorInfo` variant.
 *
 * Schema-declared, wire-unproven: no capture of this refusal exists. Every
 * steer rejection captured against codex-cli 0.147.0 is a bare
 * `{code: -32600, message}` with no `data`, and the `/review` refusal that
 * would carry the variant was never reproduced. This reads the one position
 * the schema implies (`data.codexErrorInfo`) purely so the day it appears is
 * a better message rather than a surprise.
 *
 * A miss can only make a rejection *more* conservative: unmatched refusals
 * stay terminal and are never re-issued. `turnKind` stays absent unless the
 * payload names one — the user-facing message must not invent a turn kind.
 */
function readActiveTurnNotSteerable(
  data: unknown,
): { readonly turnKind: string | undefined } | undefined {
  const variant = readRecord(readRecord(readRecord(data)?.codexErrorInfo)?.activeTurnNotSteerable);
  return variant
    ? { turnKind: typeof variant.turnKind === "string" ? variant.turnKind : undefined }
    : undefined;
}

interface CodexTurnSubmitClient {
  readonly raw: {
    readonly request: (
      method: string,
      payload?: unknown,
    ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  };
  readonly request: (
    method: "turn/steer",
    payload: CodexRpc.ClientRequestParamsByMethod["turn/steer"],
  ) => Effect.Effect<
    CodexRpc.ClientRequestResponsesByMethod["turn/steer"],
    CodexErrors.CodexAppServerError
  >;
}

/**
 * Settings the running turn was started with. Steering carries none of them
 * (the wire contract has no such fields), so a send that asks to change one
 * has to be refused rather than folded in — otherwise the UI shows a switch
 * the model never received.
 *
 * `interrupting` flips the moment `turn/interrupt` is issued: a message typed
 * right after Stop must not be folded into the turn being aborted.
 */
export interface CodexActiveTurnState {
  readonly turnId: TurnId;
  readonly model: string | undefined;
  readonly effort: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly interrupting: boolean;
}

export interface CodexSendTurnResult extends ProviderTurnStartResult {
  /** True when the message folded into an already-running turn. */
  readonly steered: boolean;
}

/**
 * Names the first setting the send asks to change, or undefined when it asks
 * for nothing the running turn cannot already provide. An omitted field is
 * "no preference", not "reset to default", so it never counts as a change.
 */
function readTurnSettingsChange(
  active: CodexActiveTurnState,
  turn: CodexSessionRuntimeSendTurnInput,
): string | undefined {
  const requestedModel = normalizeCodexModelSlug(turn.model);
  if (requestedModel !== undefined && requestedModel !== active.model) {
    return "the model";
  }
  if (turn.effort !== undefined && turn.effort !== active.effort) {
    return "reasoning effort";
  }
  if (turn.serviceTier !== undefined && turn.serviceTier !== active.serviceTier) {
    return "the service tier";
  }
  if (turn.interactionMode !== undefined && turn.interactionMode !== active.interactionMode) {
    return "the interaction mode";
  }
  return undefined;
}

/**
 * Submits one user message to a Codex thread.
 *
 * Idle session → `turn/start`, which opens a new provider turn exactly as
 * before.
 *
 * Mid-turn → `turn/steer`, which folds the message into the turn that is
 * already running. Codex answers a steer with the id of that same turn and
 * emits no `turn/started` notification, so nothing downstream projects a new
 * turn and the runtime's active-turn bookkeeping is left untouched: the
 * caller gets the running turn's id back and the message lands in that
 * turn's stream.
 *
 * Issuing `turn/start` mid-turn instead — what this runtime used to do — is
 * worse than it looks. Captured against codex-cli 0.147.0, the response
 * hands back a *different* turn id that never starts: no `turn/started`, no
 * items and no `turn/completed` ever carry it, while the message itself
 * folds into the turn already running. The runtime then reported that
 * phantom id as the turn's id, so callers persisted it as the active turn
 * and `turn/interrupt` was refused ("expected active turn id … but found
 * …"). Steering returns the id the server actually accepts.
 *
 * Only an idle session takes the `turn/start` path. A turn already being
 * interrupted rejects the send retryably until its terminal lifecycle
 * arrives, while a known active turn whose start-time settings are missing
 * rejects rather than risking a mid-turn phantom `turn/start` response.
 *
 * Rejections split by whether the message can still be delivered:
 *
 * - The steer lost a race with the end of its turn — the app-server refuses a
 *   stale `expectedTurnId`, and the runtime's own view has since gone idle.
 *   Nothing was delivered (the precondition failed), so the message is
 *   re-issued as a `turn/start` exactly once. This is the ordinary
 *   end-of-turn race, not a fault.
 * - `activeTurnNotSteerable` (`/review`, manual `/compact`) is a documented
 *   protocol outcome and is never re-issued: the running turn keeps going and
 *   the caller is told the message was not sent.
 * - A refusal reporting "found B" is terminal and reconciles B as active;
 *   its failed precondition proves this message was not delivered. A
 *   successful response naming a different turn is also terminal, but its
 *   delivery is uncertain, so re-issuing it risks a double post.
 *
 * No rejection is ever a session-level failure — see
 * `CodexSessionRuntimeTurnSteerRejectedError`.
 */
export const sendCodexTurn = (input: {
  readonly client: CodexTurnSubmitClient;
  readonly sessionRef: Ref.Ref<ProviderSession>;
  readonly activeTurnRef: Ref.Ref<CodexActiveTurnState | undefined>;
  readonly pendingTurnStartIdRef?: Ref.Ref<Deferred.Deferred<TurnId | undefined> | undefined>;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly turn: CodexSessionRuntimeSendTurnInput;
}): Effect.Effect<CodexSendTurnResult, CodexSessionRuntimeError> =>
  Effect.gen(function* () {
    const session = yield* Ref.get(input.sessionRef);
    const providerThreadId = currentProviderThreadId(session);
    if (!providerThreadId) {
      return yield* new CodexSessionRuntimeThreadIdMissingError({
        threadId: input.threadId,
      });
    }

    const startTurn = Effect.gen(function* () {
      const pendingTurnStartId = input.pendingTurnStartIdRef
        ? yield* Deferred.make<TurnId | undefined>()
        : undefined;
      if (pendingTurnStartId && input.pendingTurnStartIdRef) {
        yield* Ref.set(input.pendingTurnStartIdRef, pendingTurnStartId);
      }

      return yield* Effect.gen(function* () {
        // Read the model fresh: on the end-of-turn retry path the session has
        // moved on since the snapshot above.
        const current = yield* Ref.get(input.sessionRef);
        const requestedModel = normalizeCodexModelSlug(input.turn.model ?? current.model);
        const effectiveSettings = {
          model:
            requestedModel ??
            (input.turn.interactionMode !== undefined ? DEFAULT_MODEL : undefined),
          effort:
            input.turn.effort ?? (input.turn.interactionMode !== undefined ? "medium" : undefined),
          serviceTier: input.turn.serviceTier,
          interactionMode: input.turn.interactionMode,
        } as const;
        const startParams = yield* buildTurnStartParams({
          threadId: providerThreadId,
          runtimeMode: input.runtimeMode,
          ...(input.turn.input ? { prompt: input.turn.input } : {}),
          ...(input.turn.attachments ? { attachments: input.turn.attachments } : {}),
          ...(effectiveSettings.model ? { model: effectiveSettings.model } : {}),
          ...(effectiveSettings.serviceTier ? { serviceTier: effectiveSettings.serviceTier } : {}),
          ...(effectiveSettings.effort ? { effort: effectiveSettings.effort } : {}),
          ...(effectiveSettings.interactionMode
            ? { interactionMode: effectiveSettings.interactionMode }
            : {}),
        });
        const rawResponse = yield* input.client.raw.request("turn/start", startParams);
        const response = yield* decodeV2TurnStartResponse(rawResponse).pipe(
          Effect.mapError((error) =>
            CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
              "decode-response-payload",
              error,
              { method: "turn/start" },
            ),
          ),
        );
        const startedTurnId = TurnId.make(response.turn.id);
        // The response id is what the server validates `expectedTurnId` and
        // `turn/interrupt` against, so it wins over any id a `turn/started`
        // notification published — including when that notification arrived
        // first. The two agree for ordinary turns; a captured `/review` shows
        // them diverging, with the server naming the response id as active.
        yield* updateSession(input.sessionRef, {
          status: "running",
          activeTurnId: startedTurnId,
          ...(effectiveSettings.model ? { model: effectiveSettings.model } : {}),
        });
        yield* Ref.set(input.activeTurnRef, {
          turnId: startedTurnId,
          ...effectiveSettings,
          interrupting: false,
        });
        if (pendingTurnStartId) {
          yield* Deferred.succeed(pendingTurnStartId, startedTurnId);
        }
        return startedTurnId;
      }).pipe(
        Effect.ensuring(
          pendingTurnStartId && input.pendingTurnStartIdRef
            ? Deferred.succeed(pendingTurnStartId, undefined).pipe(
                Effect.andThen(Ref.set(input.pendingTurnStartIdRef, undefined)),
              )
            : Effect.void,
        ),
      );
    });

    const finish = (turnId: TurnId, steered: boolean) =>
      Effect.gen(function* () {
        const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(input.sessionRef));
        return {
          threadId: input.threadId,
          turnId,
          ...(resumedProviderThreadId
            ? { resumeCursor: { threadId: resumedProviderThreadId } }
            : {}),
          steered,
        } satisfies CodexSendTurnResult;
      });

    const activeTurnId = session.activeTurnId;
    const activeTurn = yield* Ref.get(input.activeTurnRef);
    if (activeTurnId === undefined) {
      return yield* finish(yield* startTurn, false);
    }
    if (activeTurn === undefined || activeTurn.turnId !== activeTurnId) {
      return yield* new CodexSessionRuntimeTurnSteerRejectedError({
        threadId: input.threadId,
        expectedTurnId: activeTurnId,
        reason: "rejected",
        detail: "active turn metadata is unavailable; message was not sent",
      });
    }
    if (activeTurn.interrupting) {
      return yield* new CodexSessionRuntimeTurnSteerRejectedError({
        threadId: input.threadId,
        expectedTurnId: activeTurnId,
        reason: "turn-interrupting",
      });
    }

    const changedSetting = readTurnSettingsChange(activeTurn, input.turn);
    if (changedSetting) {
      return yield* new CodexSessionRuntimeTurnSteerRejectedError({
        threadId: input.threadId,
        expectedTurnId: activeTurnId,
        reason: "turn-settings-changed",
        changedSetting,
      });
    }

    // `expectedTurnId` must be the id the SERVER considers active, which is
    // the one it returned from `turn/start` — not necessarily the one a
    // `turn/started` notification published. A captured `/review` shows the
    // two diverging, with the server accepting only the response id. The
    // runtime tracks the response id for exactly this reason (see the start
    // path). If the server still reports a different active id, reconcile it
    // below and leave this message terminally undelivered.
    const steerParams = yield* buildTurnSteerParams({
      threadId: providerThreadId,
      expectedTurnId: activeTurnId,
      ...(input.turn.input ? { prompt: input.turn.input } : {}),
      ...(input.turn.attachments ? { attachments: input.turn.attachments } : {}),
    });
    const steered = yield* input.client.request("turn/steer", steerParams).pipe(
      Effect.map((response) => ({ ok: true as const, turnId: TurnId.make(response.turnId) })),
      Effect.catchTag("CodexAppServerRequestError", (cause) =>
        Effect.succeed({ ok: false as const, cause }),
      ),
    );

    if (steered.ok) {
      if (steered.turnId !== activeTurnId) {
        return yield* new CodexSessionRuntimeTurnSteerRejectedError({
          threadId: input.threadId,
          expectedTurnId: activeTurnId,
          reason: "turn-id-mismatch",
          steeredTurnId: steered.turnId,
        });
      }
      // Deliberately no session update: the steered message belongs to a turn
      // that is already tracked, and its settings are unchanged by
      // construction (see the refusal above).
      return yield* finish(activeTurnId, true);
    }

    // Classify from the response itself. The `activeTurnNotSteerable`
    // variant is checked first so the schema-declared refusal, if it ever
    // arrives, cannot be mistaken for a stale precondition and re-issued.
    const notSteerable = readActiveTurnNotSteerable(steered.cause.data);
    if (notSteerable) {
      return yield* new CodexSessionRuntimeTurnSteerRejectedError({
        threadId: input.threadId,
        expectedTurnId: activeTurnId,
        reason: "active-turn-not-steerable",
        ...(notSteerable.turnKind ? { turnKind: notSteerable.turnKind } : {}),
        detail: steered.cause.message,
        cause: steered.cause,
      });
    }

    const foundActiveTurnId = readFoundActiveTurnId(steered.cause);
    if (foundActiveTurnId !== undefined) {
      yield* updateSession(input.sessionRef, {
        status: "running",
        activeTurnId: foundActiveTurnId,
      });
      yield* Ref.set(input.activeTurnRef, {
        ...activeTurn,
        turnId: foundActiveTurnId,
      });
      return yield* new CodexSessionRuntimeTurnSteerRejectedError({
        threadId: input.threadId,
        expectedTurnId: activeTurnId,
        reason: "rejected",
        steeredTurnId: foundActiveTurnId,
        detail: `${steered.cause.message}; active turn reconciled, message was not sent`,
        cause: steered.cause,
      });
    }

    if (!isNoActiveTurnRejection(steered.cause)) {
      return yield* new CodexSessionRuntimeTurnSteerRejectedError({
        threadId: input.threadId,
        expectedTurnId: activeTurnId,
        reason: "rejected",
        detail: steered.cause.message,
        cause: steered.cause,
      });
    }

    const latestSession = yield* Ref.get(input.sessionRef);
    const latestActiveTurn = yield* Ref.get(input.activeTurnRef);
    if (latestSession.activeTurnId !== undefined || latestActiveTurn !== undefined) {
      return yield* new CodexSessionRuntimeTurnSteerRejectedError({
        threadId: input.threadId,
        expectedTurnId: activeTurnId,
        reason: "rejected",
        detail: `${steered.cause.message}; runtime still reports an active turn, message was not sent`,
        cause: steered.cause,
      });
    }

    const rejection = new CodexSessionRuntimeTurnSteerRejectedError({
      threadId: input.threadId,
      expectedTurnId: activeTurnId,
      reason: "stale-expected-turn-id",
      detail: steered.cause.message,
      cause: steered.cause,
    });

    // The serialized runtime view independently confirms the refused turn is
    // gone. Re-issue exactly once as a fresh turn. A failure here keeps its
    // turn-start error type rather than being disguised as a steer rejection.
    yield* Effect.logDebug("codex refused a stale steer precondition; re-issuing as turn/start", {
      threadId: input.threadId,
      expectedTurnId: activeTurnId,
      cause: rejection.detail,
    });
    return yield* finish(yield* startTurn, false);
  });

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const crypto = yield* Crypto.Crypto;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const collabChildAgentsRef = yield* Ref.make(new Map<string, CollabChildAgentState>());
    /** Child provider-thread id → its currently running provider turn id. */
    const collabChildLiveTurnsRef = yield* Ref.make(new Map<string, string>());
    /**
     * Settings of the turn currently running, plus whether it is being
     * interrupted. Steering carries neither, so both have to be remembered
     * here to decide whether a mid-turn send can fold in.
     */
    const activeTurnRef = yield* Ref.make<CodexActiveTurnState | undefined>(undefined);
    const pendingTurnStartIdRef = yield* Ref.make<
      Deferred.Deferred<TurnId | undefined> | undefined
    >(undefined);
    // One runtime owns one provider thread. Serialize the complete
    // decision/RPC/fallback span so concurrent sends always re-read the state
    // produced by the preceding send before choosing steer versus start.
    const turnSubmissionSemaphore = yield* Semaphore.make(1);
    const closedRef = yield* Ref.make(false);

    // `~` is not shell-expanded when env vars are set via
    // `child_process.spawn`; `expandHomePath` lets a configured
    // `CODEX_HOME=~/.codex_work` reach codex as an absolute path.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...options.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const extendEnv = options.environment === undefined;
    const appServerArgs = codexSessionAppServerArgs(options.appServerArgs, options.launchArgs);
    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, appServerArgs, {
      env,
      extendEnv,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: options.cwd,
          env,
          extendEnv,
          forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} app-server`,
              cause,
            }),
        ),
      );

    const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
      Layer.build,
      Effect.provideService(Scope.Scope, runtimeScope),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    const serverNotifications = yield* Queue.unbounded<CodexServerNotification>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = (purpose: CodexErrors.CodexAppServerIdentifierPurpose) =>
      crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerIdentifierGenerationError({
              purpose,
              cause,
            }),
        ),
      );

    const sessionCreatedAt = yield* nowIso;
    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt,
    } satisfies ProviderSession;
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.gen(function* () {
        const id = yield* randomUUIDv4("provider-event");
        return yield* offerEvent({
          id: EventId.make(id),
          provider: PROVIDER,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          createdAt: yield* nowIso,
          ...event,
        });
      });
    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });

    const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
      Ref.get(pendingApprovalsRef).pipe(
        Effect.flatMap((pendingApprovals) =>
          Effect.forEach(
            Array.from(pendingApprovals.values()),
            (pendingApproval) =>
              Deferred.succeed(pendingApproval.decision, decision).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
      Ref.get(pendingUserInputsRef).pipe(
        Effect.flatMap((pendingUserInputs) =>
          Effect.forEach(
            Array.from(pendingUserInputs.values()),
            (pendingUserInput) =>
              Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    /**
     * Registers v2 collab children and re-emits their notifications as
     * synthetic `collabAgent/*` events for the adapter's task.* synthesis.
     * Returns true when the notification was fully handled (must not reach
     * parent-timeline mapping).
     */
    const interceptCollabChildNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        // Registration path 1: child thread announces itself with a
        // subAgent thread_spawn source.
        if (notification.method === "thread/started") {
          const thread = notification.params.thread;
          const spawn = readThreadSpawnSource(thread);
          if (!spawn) {
            return false;
          }
          // Merge with any subAgentActivity registration that got here
          // first. spawnTurnId is REGISTRATION-time-only on both paths: for
          // an already-known child we keep its value (set or unset) — a
          // later thread/started during an unrelated parent turn must not
          // backfill that turn as the spawn batch, which would stamp an old
          // child onto a new fleet's CTA (review finding). Only a genuinely
          // new registration captures the current turn.
          const existingChild = (yield* Ref.get(collabChildAgentsRef)).get(thread.id);
          const spawnTurnId = existingChild
            ? existingChild.spawnTurnId
            : ((yield* Ref.get(sessionRef)).activeTurnId ?? undefined);
          const state: CollabChildAgentState = {
            agentThreadId: thread.id,
            nickname: spawn.nickname ?? thread.agentNickname ?? existingChild?.nickname,
            role: spawn.role ?? thread.agentRole ?? existingChild?.role,
            agentPath: spawn.agentPath ?? existingChild?.agentPath,
            depth: spawn.depth ?? existingChild?.depth,
            parentThreadId:
              spawn.parentThreadId ?? thread.parentThreadId ?? existingChild?.parentThreadId,
            spawnTurnId,
          };
          yield* Ref.update(collabChildAgentsRef, (current) => {
            const next = new Map(current);
            next.set(thread.id, state);
            return next;
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "collabAgent/started",
            ...(state.spawnTurnId ? { turnId: state.spawnTurnId } : {}),
            payload: {
              agentThreadId: state.agentThreadId,
              ...(state.nickname ? { nickname: state.nickname } : {}),
              ...(state.role ? { role: state.role } : {}),
              ...(state.agentPath ? { agentPath: state.agentPath } : {}),
              ...(state.depth !== undefined ? { depth: state.depth } : {}),
              ...(state.parentThreadId ? { parentThreadId: state.parentThreadId } : {}),
            },
          });
          return true;
        }

        // Registration path 2: parent-side subAgentActivity item names the
        // child thread (may arrive before or after thread/started).
        if (
          (notification.method === "item/started" || notification.method === "item/completed") &&
          notification.params.item.type === "subAgentActivity"
        ) {
          const item = notification.params.item;
          // Never register the session's ROOT thread as its own child. The
          // wire emits subAgentActivity {agentPath: "/root", interacted}
          // about the root during collab runs; registering it intercepted
          // every subsequent root notification — including the final
          // assistant message and turn/completed — so the thread hung
          // "working" after all subagents finished (live-probe finding).
          const rootProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          if (
            item.agentThreadId === rootProviderThreadId ||
            item.agentPath === "/root" ||
            item.agentPath === "/"
          ) {
            return false;
          }
          const activitySpawnTurnId = (yield* Ref.get(sessionRef)).activeTurnId ?? undefined;
          yield* Ref.update(collabChildAgentsRef, (current) => {
            const existing = current.get(item.agentThreadId);
            const next = new Map(current);
            // Merge-late semantics: when thread/started registered first, a
            // later subAgentActivity still carries the real agentPath (and a
            // derived nickname) — fill missing fields, never clobber known
            // ones. spawnTurnId is registration-time-only: for an already
            // registered child, a later activity during an UNRELATED turn
            // must not backfill that turn as the spawn batch (review
            // finding); an unset spawn turn stays unset.
            next.set(item.agentThreadId, {
              agentThreadId: item.agentThreadId,
              nickname:
                existing?.nickname ??
                item.agentPath.split("/").findLast((segment) => segment.length > 0),
              role: existing?.role,
              agentPath: existing?.agentPath ?? item.agentPath,
              depth: existing?.depth,
              parentThreadId: existing?.parentThreadId,
              spawnTurnId: existing ? existing.spawnTurnId : activitySpawnTurnId,
            });
            return next;
          });
          const registeredChild = (yield* Ref.get(collabChildAgentsRef)).get(item.agentThreadId);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "collabAgent/activity",
            ...(registeredChild?.spawnTurnId ? { turnId: registeredChild.spawnTurnId } : {}),
            payload: {
              agentThreadId: item.agentThreadId,
              agentPath: item.agentPath,
              activityKind: item.kind,
            },
          });
          return true;
        }

        // Interception: notifications addressed to a registered child thread
        // become agent-scoped synthetic events instead of parent chatter.
        const providerConversationId = readNotificationThreadId(notification);
        if (!providerConversationId) {
          return false;
        }
        // Belt-and-braces: the root thread's traffic must never be
        // intercepted, whatever the registry says.
        const interceptRootId = currentProviderThreadId(yield* Ref.get(sessionRef));
        if (providerConversationId === interceptRootId) {
          return false;
        }
        const children = yield* Ref.get(collabChildAgentsRef);
        const child = children.get(providerConversationId);
        if (!child) {
          return false;
        }
        const childIdentity = {
          agentThreadId: child.agentThreadId,
          ...(child.nickname ? { nickname: child.nickname } : {}),
          ...(child.role ? { role: child.role } : {}),
          ...(child.agentPath ? { agentPath: child.agentPath } : {}),
        };
        switch (notification.method) {
          case "turn/started": {
            const childTurnId =
              typeof (notification.params as { turn?: { id?: unknown } }).turn?.id === "string"
                ? ((notification.params as { turn: { id: string } }).turn.id as string)
                : undefined;
            if (childTurnId) {
              yield* Ref.update(collabChildLiveTurnsRef, (current) => {
                const next = new Map(current);
                next.set(child.agentThreadId, childTurnId);
                return next;
              });
            }
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/turnStarted",
              payload: childIdentity,
            });
            return true;
          }
          case "turn/completed":
            yield* Ref.update(collabChildLiveTurnsRef, (current) => {
              const next = new Map(current);
              next.delete(child.agentThreadId);
              return next;
            });
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/turnCompleted",
              payload: {
                ...childIdentity,
                turn: notification.params.turn,
              },
            });
            return true;
          case "thread/status/changed":
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/statusChanged",
              payload: {
                ...childIdentity,
                status: notification.params.status,
              },
            });
            return true;
          case "thread/tokenUsage/updated":
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/tokenUsage",
              payload: {
                ...childIdentity,
                tokenUsage: notification.params.tokenUsage,
              },
            });
            return true;
          case "item/started":
          case "item/completed":
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/item",
              payload: {
                ...childIdentity,
                item: notification.params.item,
              },
            });
            return true;
          case "thread/closed":
            // The child is gone: drop its live-turn entry so a later Stop
            // doesn't waste a turn/interrupt RPC on a closed thread before
            // reaching the parent (review finding).
            yield* Ref.update(collabChildLiveTurnsRef, (current) => {
              const next = new Map(current);
              next.delete(child.agentThreadId);
              return next;
            });
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/closed",
              payload: childIdentity,
            });
            return true;
          case "error": {
            // A child error must surface as a failed agent, not vanish into
            // the default swallow (review finding: the child stayed
            // "running" forever). Retryable errors (willRetry) keep the
            // child RUNNING and interruptible — mirroring the root error
            // handler; settling it would orphan a still-live child from
            // Stop (review finding). Terminal errors clean up the live turn
            // like thread/closed and reuse the statusChanged systemError
            // path.
            const willRetry = (notification.params as { willRetry?: boolean }).willRetry === true;
            if (willRetry) {
              return true;
            }
            yield* Ref.update(collabChildLiveTurnsRef, (current) => {
              const next = new Map(current);
              next.delete(child.agentThreadId);
              return next;
            });
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/statusChanged",
              payload: {
                ...childIdentity,
                status: { type: "systemError" },
              },
            });
            return true;
          }
          default:
            // Routing table decides (single source of truth, asserted
            // against captured wire traces): enumerated chatter is dropped,
            // everything else — including methods this build has never seen
            // — falls through to the parent path rather than vanishing.
            return routeCodexChildNotification(notification.method) === "drop";
        }
      });

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        let payload: unknown = notification.params;
        const route = readRouteFields(notification);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const childParentTurnId = (() => {
          const providerConversationId = readNotificationThreadId(notification);
          return providerConversationId
            ? collabReceiverTurns.get(providerConversationId)
            : undefined;
        })();

        rememberCollabReceiverTurns(collabReceiverTurns, notification, route.turnId);
        // Interception FIRST: a registered v2 child is usually also in the
        // receiver-turn map (collabAgentToolCall.receiverThreadIds), and the
        // legacy suppressor below would drop its lifecycle before it could
        // become synthetic collabAgent events (review finding). The
        // suppressor still covers UNREGISTERED children.
        if (yield* interceptCollabChildNotification(notification)) {
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        // Suppression applies to receiver-map children (v1) AND to any
        // conversation that is not the root thread. The live capture
        // (codexMultiAgentWire.json) shows a child's thread/status/changed
        // arriving BEFORE anything registers the child — pre-registration
        // lifecycle must not reach the parent path, where the adapter maps
        // thread/* onto parent session state. Root-id-known guard keeps the
        // root's own early notifications flowing during session open.
        const suppressRootId = currentProviderThreadId(yield* Ref.get(sessionRef));
        const foreignConversation = (() => {
          const providerConversationId = readNotificationThreadId(notification);
          return (
            providerConversationId !== undefined &&
            suppressRootId !== undefined &&
            providerConversationId !== suppressRootId
          );
        })();
        if (
          (childParentTurnId !== undefined || foreignConversation) &&
          shouldSuppressChildConversationNotification(notification.method)
        ) {
          // Stop-everything must not depend on registration timing: a
          // child's turn/started can arrive before the subAgentActivity that
          // registers it (captured ordering), and suppressing it without
          // remembering the live turn would leave that child running after
          // Stop (review finding). Track live turns for ANY foreign
          // conversation; interrupts are best-effort per child, so a
          // false-positive entry costs one ignored RPC at worst.
          const foreignThreadId = readNotificationThreadId(notification);
          if (foreignThreadId !== undefined) {
            if (notification.method === "turn/started") {
              const foreignTurnId =
                typeof (notification.params as { turn?: { id?: unknown } }).turn?.id === "string"
                  ? (notification.params as { turn: { id: string } }).turn.id
                  : undefined;
              if (foreignTurnId) {
                yield* Ref.update(collabChildLiveTurnsRef, (current) => {
                  const next = new Map(current);
                  next.set(foreignThreadId, foreignTurnId);
                  return next;
                });
              }
            } else if (
              notification.method === "turn/completed" ||
              notification.method === "thread/closed"
            ) {
              yield* Ref.update(collabChildLiveTurnsRef, (current) => {
                const next = new Map(current);
                next.delete(foreignThreadId);
                return next;
              });
            }
          }
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        let requestId: ApprovalRequestId | undefined;
        let requestKind: ProviderRequestKind | undefined;
        let turnId = childParentTurnId ?? route.turnId;
        let itemId = route.itemId;

        if (notification.method === "serverRequest/resolved") {
          const rawRequestId =
            typeof notification.params.requestId === "string"
              ? notification.params.requestId
              : String(notification.params.requestId);
          const correlation = rawRequestId
            ? (yield* Ref.get(approvalCorrelationsRef)).get(rawRequestId)
            : undefined;
          if (correlation) {
            requestId = correlation.requestId;
            requestKind = correlation.requestKind;
            turnId = correlation.turnId ?? turnId;
            itemId = correlation.itemId ?? itemId;
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.delete(rawRequestId);
              return next;
            });
          }
        }

        if (notification.method === "turn/started") {
          const pendingTurnStartId = yield* Ref.get(pendingTurnStartIdRef);
          const authoritativeTurnId = pendingTurnStartId
            ? yield* Deferred.await(pendingTurnStartId)
            : (yield* Ref.get(sessionRef)).activeTurnId;
          if (authoritativeTurnId) {
            turnId = authoritativeTurnId;
            payload = {
              ...notification.params,
              turn: {
                ...notification.params.turn,
                id: authoritativeTurnId,
              },
            };
          }
        }

        yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: notification.method,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(requestKind ? { requestKind } : {}),
          ...(notification.method === "item/agentMessage/delta"
            ? { textDelta: notification.params.delta }
            : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
      });

    const currentSessionProviderThreadId = Effect.map(Ref.get(sessionRef), currentProviderThreadId);

    yield* client.handleServerNotification("thread/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.thread.id !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            resumeCursor: { threadId: payload.thread.id },
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, (session) => ({
            status: "running",
            // Only fills a gap — it never renames a turn the runtime already
            // tracks. A captured `/review` publishes a different id here than
            // the one the server accepts for steer and interrupt, so letting
            // this overwrite the start response's id would point both at an
            // id the server rejects.
            activeTurnId: session.activeTurnId ?? TurnId.make(payload.turn.id),
          }));
        }),
      ),
    );

    yield* client.handleServerNotification("turn/completed", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          const lastError =
            payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
              ? payload.turn.error.message
              : undefined;
          return updateSession(sessionRef, {
            status: payload.turn.status === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            ...(lastError ? { lastError } : {}),
          }).pipe(Effect.andThen(Ref.set(activeTurnRef, undefined)));
        }),
      ),
    );

    yield* client.handleServerNotification("error", (payload) =>
      Effect.gen(function* () {
        const session = yield* Ref.get(sessionRef);
        const providerThreadId = currentProviderThreadId(session);
        const payloadThreadId = payload.threadId;
        if (providerThreadId && payloadThreadId && payloadThreadId !== providerThreadId) {
          return;
        }
        const errorMessage = payload.error.message;
        // The protocol makes `turnId` required. An error about some other
        // turn must not rewrite this session's status, and — the bug this
        // scoping fixes — a terminal error must not leave `activeTurnId`
        // pointing at a turn that is already dead, which is what made a
        // later send try to steer a turn that no longer existed.
        if (session.activeTurnId === undefined || payload.turnId !== session.activeTurnId) {
          return yield* errorMessage
            ? updateSession(sessionRef, { lastError: errorMessage })
            : Effect.void;
        }
        if (payload.willRetry) {
          return yield* updateSession(sessionRef, {
            status: "running",
            ...(errorMessage ? { lastError: errorMessage } : {}),
          });
        }
        yield* updateSession(sessionRef, {
          status: "error",
          activeTurnId: undefined,
          ...(errorMessage ? { lastError: errorMessage } : {}),
        });
        yield* Ref.set(activeTurnRef, undefined);
      }),
    );

    yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4("command-approval-request"));
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.approvalId ?? payload.itemId,
            requestKind: "command",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.approvalId ?? payload.itemId, {
            requestId,
            requestKind: "command",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/commandExecution/requestApproval",
          requestId,
          requestKind: "command",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(
          yield* randomUUIDv4("file-change-approval-request"),
        );
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.itemId,
            requestKind: "file-change",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.itemId, {
            requestId,
            requestKind: "file-change",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/fileChange/requestApproval",
          requestId,
          requestKind: "file-change",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4("user-input-request"));
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();

        yield* Ref.update(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            turnId,
            itemId,
            answers,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/tool/requestUserInput",
          requestId,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolvedAnswers = yield* Deferred.await(answers).pipe(
          Effect.ensuring(
            Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );

        return {
          answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                questionId: error.questionId,
              }),
            ),
          ),
        } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
      }),
    );

    yield* client.handleUnknownServerRequest((method) =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method)),
    );

    const registerServerNotification = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
      client.handleServerNotification(method, (params) =>
        Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
          Effect.asVoid,
        ),
      );

    yield* Effect.forEach(
      Object.values(
        CodexRpc.SERVER_NOTIFICATION_METHODS,
      ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>,
      registerServerNotification,
      { concurrency: 1, discard: true },
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach(handleRawNotification),
      Effect.forkIn(runtimeScope),
    );

    const stderrRemainderRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = classifyCodexStderrLine(line);
                if (!classified) {
                  return Effect.void;
                }
                return emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "process/stderr",
                  message: classified.message,
                });
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }
            const nextStatus = exitCode === 0 ? "closed" : "error";
            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(Ref.set(activeTurnRef, undefined)),
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Starting Codex App Server session.");
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
      });

      const providerThreadId = opened.thread.id;
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: "ready",
        cwd: opened.cwd,
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: yield* nowIso,
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");
      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }
      return providerThreadId;
    });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
      if (alreadyClosed) {
        return;
      }
      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* Ref.set(activeTurnRef, undefined);
      yield* emitSessionEvent("session/closed", "Session stopped").pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Codex session closed event.", { cause }),
        ),
      );
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    return {
      start,
      getSession: Ref.get(sessionRef),
      sendTurn: (input) =>
        turnSubmissionSemaphore.withPermit(
          Effect.gen(function* () {
            // Fail before touching the MCP catalog when the session has no
            // provider thread yet.
            yield* readProviderThreadId;
            if (hasConfiguredMcpServer(options.appServerArgs)) {
              yield* client.request("config/mcpServer/reload", undefined).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to refresh Codex MCP tool catalog before turn.", {
                    cause,
                  }),
                ),
              );
            }
            return yield* sendCodexTurn({
              client,
              sessionRef,
              activeTurnRef,
              pendingTurnStartIdRef,
              threadId: options.threadId,
              runtimeMode: options.runtimeMode,
              turn: input,
            });
          }),
        ),
      interruptTurn: (turnId) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const session = yield* Ref.get(sessionRef);
          const effectiveTurnId = turnId ?? session.activeTurnId;
          if (!effectiveTurnId) {
            return;
          }
          const previousActiveTurn = yield* Ref.get(activeTurnRef);
          // Stop makes the turn unsteerable from this instant, before any RPC
          // goes out: a message typed right after Stop belongs to the next
          // turn, not the one being aborted (it would otherwise be folded
          // into a turn that is about to stop reading).
          yield* Ref.update(activeTurnRef, (current) =>
            current?.turnId === effectiveTurnId ? { ...current, interrupting: true } : current,
          );
          // Stop-everything: children are full threads with their own turns;
          // interrupting only the parent leaves the fleet running. Interrupt
          // each live child turn first, best-effort per child, BOUNDED: the
          // transport awaits an unbounded Deferred per request, so a wedged
          // child would otherwise block the parent interrupt forever —
          // exactly during the runaway fleet where Stop matters most
          // (review finding). Per-child and overall deadlines guarantee the
          // parent interrupt below always runs.
          const liveChildTurns = yield* Ref.get(collabChildLiveTurnsRef);
          yield* Effect.forEach(
            Array.from(liveChildTurns.entries()),
            ([childThreadId, childTurnId]) =>
              client
                .request("turn/interrupt", {
                  threadId: childThreadId,
                  turnId: childTurnId,
                })
                .pipe(Effect.timeoutOption("3 seconds"), Effect.ignore),
            { concurrency: 8, discard: true },
          ).pipe(Effect.timeoutOption("10 seconds"), Effect.ignore);
          yield* client
            .request("turn/interrupt", {
              threadId: providerThreadId,
              turnId: effectiveTurnId,
            })
            .pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Ref.update(activeTurnRef, (current) =>
                      current?.turnId === effectiveTurnId && current.interrupting
                        ? previousActiveTurn
                        : current,
                    ),
              ),
            );
        }),
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });
        return parseThreadSnapshot(response);
      }),
      rollbackThread: (numTurns) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const response = yield* client.request("thread/rollback", {
            threadId: providerThreadId,
            numTurns,
          });
          yield* updateSession(sessionRef, {
            status: "ready",
            activeTurnId: undefined,
          });
          yield* Ref.set(activeTurnRef, undefined);
          return parseThreadSnapshot(response);
        }),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovalsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }
          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.decision, decision);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/requestApproval/decision",
            requestId: pending.requestId,
            requestKind: pending.requestKind,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              requestId: pending.requestId,
              requestKind: pending.requestKind,
              decision,
            },
          });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          yield* Ref.update(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
