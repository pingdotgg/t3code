// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { field } from "../unknownField.ts";

import { toMcpElicitationResponse } from "../../provider/CodexMcpElicitation.ts";

import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKAPIRetryMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeUtil from "node:util";

import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderTurn,
  ProviderApprovalDecision,
  ProviderApprovalFullAccessOverride,
  ProviderApprovalOption,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as Schema from "effect/Schema";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import type { ClaudeApprovalResponse } from "./ClaudeSessionTypes.ts";
import type { ClaudeLiveQueryContext } from "./ClaudeAssistantArtifacts.ts";

export const CLAUDE_NO_STANDING_GRANT_OPTIONS = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export function claudeApprovalPresentation(input: {
  readonly permissionMode: PermissionMode;
  readonly prompt: string;
  readonly callbackOptions: Pick<
    Parameters<CanUseTool>[2],
    "decisionReason" | "matchedAskRule" | "suppressAlwaysAllowRule"
  >;
}): {
  readonly reason?: string;
  readonly fullAccessOverride?: ProviderApprovalFullAccessOverride;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
} {
  // The reason can carry terminal escapes from the CLI's own prompt renderer.
  const reason = NodeUtil.stripVTControlCharacters(
    input.callbackOptions.decisionReason ?? "",
  ).trim();
  // Bypass auto-allows everything it can, so any ask that still reaches the
  // callback is one bypass refused. The SDK drops the CLI's decision_reason_type,
  // leaving the matched ask rule as the only way to tell the two causes apart.
  const fullAccessOverride: ProviderApprovalFullAccessOverride | undefined =
    input.permissionMode !== "bypassPermissions"
      ? undefined
      : input.callbackOptions.matchedAskRule === undefined
        ? "provider_check"
        : "ask_rule";
  return {
    ...(reason === "" || reason === input.prompt ? {} : { reason }),
    ...(fullAccessOverride === undefined ? {} : { fullAccessOverride }),
    ...(input.callbackOptions.suppressAlwaysAllowRule === true
      ? { options: CLAUDE_NO_STANDING_GRANT_OPTIONS }
      : {}),
  };
}

export function permissionResultFromDecision(input: {
  readonly toolName: string;
  readonly decision: ProviderApprovalDecision;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseID: string;
  readonly suggestions?: Parameters<CanUseTool>[2]["suggestions"];
  readonly feedback?: string;
  /** Under an administrator's ceiling, T3 Code's mode is the only one; Claude cannot switch it. */
  readonly managedCeiling?: boolean;
}): PermissionResult {
  if (input.decision === "accept" || input.decision === "acceptForSession") {
    return {
      behavior: "allow",
      updatedInput: input.toolInput,
      toolUseID: input.toolUseID,
      decisionClassification:
        input.decision === "acceptForSession" ? "user_permanent" : "user_temporary",
      ...(input.decision === "acceptForSession"
        ? {
            updatedPermissions: toSessionPermissionUpdates(
              input.toolName,
              input.managedCeiling === true
                ? input.suggestions?.filter((suggestion) => suggestion.type !== "setMode")
                : input.suggestions,
            ),
          }
        : {}),
    };
  }

  return {
    behavior: "deny",
    message:
      input.feedback?.trim() ||
      (input.decision === "cancel"
        ? "User cancelled tool execution."
        : "User declined tool execution."),
    toolUseID: input.toolUseID,
    decisionClassification: "user_reject",
    ...(input.decision === "cancel" ? { interrupt: true } : {}),
  };
}

export function toSessionPermissionUpdates(
  toolName: string,
  suggestions: ReadonlyArray<PermissionUpdate> | undefined,
): Array<PermissionUpdate> {
  const updates = (suggestions ?? []).map((suggestion): PermissionUpdate => ({
    ...suggestion,
    destination: "session",
  }));
  if (updates.length > 0) {
    return updates;
  }
  return [
    {
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session",
    },
  ];
}

export const awaitClaudeApprovalDecision = Effect.fn("awaitClaudeApprovalDecision")(function* (
  decision: Deferred.Deferred<ClaudeApprovalResponse>,
  signal: AbortSignal,
) {
  const cancellation = Effect.callback<ClaudeApprovalResponse>((resume) => {
    const abort = () => resume(Effect.succeed({ decision: "cancel" }));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
  return yield* Effect.raceFirst(Deferred.await(decision), cancellation);
});

// Web and mobile offer a session grant when options are omitted, and this
// path only ever answers once.
export const CLAUDE_MCP_ELICITATION_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
];

export type ClaudeMcpElicitationContent = NonNullable<ElicitationResult["content"]>;

export const isClaudeMcpElicitationValue = (
  value: unknown,
): value is ClaudeMcpElicitationContent[string] =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

export const withoutSchemaDefaults = (schema: Record<string, unknown>): Record<string, unknown> => {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return schema;
  }
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, field]) => [
        key,
        typeof field === "object" && field !== null
          ? Object.fromEntries(Object.entries(field).filter(([name]) => name !== "default"))
          : field,
      ]),
    ),
  };
};

// The card collects consent only; schema defaults must never grant unseen permissions.
export function claudeMcpElicitationAcceptance(
  request: ElicitationRequest,
): ElicitationResult | undefined {
  if (request.mode === "url" || request.requestedSchema === undefined) return undefined;
  const response = toMcpElicitationResponse(
    { mode: "form", requestedSchema: withoutSchemaDefaults(request.requestedSchema) },
    "accept",
  );
  // The helper leaves content out when the schema is not a form it can read.
  const filled = response.content;
  if (
    response.action !== "accept" ||
    typeof filled !== "object" ||
    filled === null ||
    Array.isArray(filled)
  ) {
    return undefined;
  }
  const content: ClaudeMcpElicitationContent = {};
  for (const [key, value] of Object.entries(filled)) {
    if (!isClaudeMcpElicitationValue(value)) return undefined;
    content[key] = value;
  }
  return { action: "accept", content };
}

export const awaitClaudeUserInputAnswers = Effect.fn("awaitClaudeUserInputAnswers")(function* (
  answers: Deferred.Deferred<ProviderUserInputAnswers>,
  signal: AbortSignal,
) {
  const cancellation = Effect.callback<ProviderUserInputAnswers>((resume) => {
    const abort = () => resume(Effect.succeed({}));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
  return yield* Effect.raceFirst(Deferred.await(answers), cancellation);
});

/** Exclude CLI-internal "[ede_diagnostic] ..." telemetry from error banners. */
export function resultUserFacingError(result: SDKResultMessage): string | undefined {
  const errors = "errors" in result && Array.isArray(result.errors) ? result.errors : [];
  if (result.subtype === "success" && !result.is_error) {
    return undefined;
  }
  return errors.find(
    (error): error is string => typeof error === "string" && !error.startsWith("[ede_diagnostic]"),
  );
}

export const CONTEXT_WINDOW_FULL_ERROR =
  "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.";

export function terminalResultError(
  reason: SDKResultMessage["terminal_reason"],
  failureHint?: string,
): string | undefined {
  switch (reason) {
    case "api_error":
      return failureHint ?? "Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed":
      return "Claude could not start the turn.";
    case "blocking_limit":
      // blocking_limit also means context exhaustion; only rate-limit evidence sets the hint.
      return failureHint ?? CONTEXT_WINDOW_FULL_ERROR;
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction.";
    case "prompt_too_long":
      return CONTEXT_WINDOW_FULL_ERROR;
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error":
      return "Claude stopped: the model returned an error.";
    default:
      return undefined;
  }
}

export function isOverloadedResult(result: SDKResultMessage): boolean {
  return result.subtype === "success" && result.api_error_status === 529;
}

export function terminalStatusFromResult(
  message: SDKResultMessage,
  failureHint?: string,
): Extract<
  OrchestrationV2ProviderTurn["status"],
  "completed" | "interrupted" | "failed" | "cancelled"
> {
  // Explicit abort reasons override success envelopes with is_error=false.
  if (
    message.terminal_reason === "aborted_tools" ||
    message.terminal_reason === "aborted_streaming"
  ) {
    return "interrupted";
  }
  if (message.subtype === "success") {
    // The SDK can report API failures as subtype "success" with is_error set.
    return isOverloadedResult(message) ||
      message.api_error_status === 429 ||
      terminalResultError(message.terminal_reason, failureHint) !== undefined ||
      (message.is_error && failureHint !== undefined)
      ? "failed"
      : "completed";
  }
  const errorText = message.errors.join("\n").toLowerCase();
  if (errorText.includes("interrupt")) {
    return "interrupted";
  }
  if (errorText.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

export function isClaudeActiveSteeringAbortResult(message: SDKResultMessage): boolean {
  return (
    message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools"
  );
}

export function isClaudeProviderContinuationTurn(
  input: ProviderAdapter.ProviderAdapterV2TurnInput,
): boolean {
  return input.message.createdBy === "agent" && input.message.creationSource === "provider";
}

export function isClaudePromptEchoGatedFrame(message: SDKMessage): boolean {
  switch (message.type) {
    case "assistant":
    case "stream_event":
    case "user":
      return message.parent_tool_use_id === null;
    case "result":
      return true;
    default:
      return false;
  }
}

export function claudeFrameToolUseIds(message: SDKMessage): ReadonlyArray<string> {
  const ids: Array<string> = [];
  const parent = Reflect.get(message, "parent_tool_use_id");
  if (typeof parent === "string") {
    ids.push(parent);
  }
  if (message.type === "system") {
    const toolUseId = Reflect.get(message, "tool_use_id");
    if (typeof toolUseId === "string") {
      ids.push(toolUseId);
    }
  }
  return ids;
}

export function claudeEchoedPromptUuids(message: SDKMessage): ReadonlyArray<string> {
  const uuids = Reflect.get(message, "user_message_uuids");
  if (Array.isArray(uuids)) {
    return uuids.filter((uuid): uuid is string => typeof uuid === "string");
  }
  const uuid = Reflect.get(message, "user_message_uuid");
  return typeof uuid === "string" ? [uuid] : [];
}

export function claudePromptLifecycle(
  message: SDKMessage,
): { readonly uuid: string; readonly state: string } | null {
  const type: unknown = Reflect.get(message, "type");
  if (type !== "command_lifecycle") return null;
  const uuid: unknown = Reflect.get(message, "command_uuid");
  const state: unknown = Reflect.get(message, "state");
  return typeof uuid === "string" && typeof state === "string" ? { uuid, state } : null;
}

// Without an echo, non-human origin proves a foreign turn only on CLIs known to echo prompts.
export function isClaudeResultForOtherTurn(input: {
  readonly message: SDKResultMessage;
  readonly promptUuid: string;
  readonly promptEchoMode: ClaudeLiveQueryContext["promptEchoMode"];
}): boolean {
  const echoed = claudeEchoedPromptUuids(input.message);
  if (echoed.length > 0) return !echoed.includes(input.promptUuid);
  return (
    input.promptEchoMode !== "unknown" &&
    input.message.origin !== undefined &&
    input.message.origin.kind !== "human"
  );
}

export function isClaudeTaskNotificationOriginResult(
  message: SDKMessage,
): message is SDKResultMessage & {
  readonly origin: Extract<
    NonNullable<SDKResultMessage["origin"]>,
    { readonly kind: "task-notification" }
  >;
} {
  return message.type === "result" && message.origin?.kind === "task-notification";
}

// The CLI throttles unchanged rate_limit_event frames, but repeats this
// undeclared payload on each blocked assistant response.
export const isClaudeBlockedAssistantRateLimit = Schema.is(
  Schema.Struct({
    api_error_params: Schema.Struct({
      rate_limit_info: Schema.Struct({
        status: Schema.Literal("rejected"),
        rateLimitType: Schema.optionalKey(Schema.Unknown),
        resetsAt: Schema.optionalKey(Schema.Unknown),
        overageStatus: Schema.optionalKey(Schema.String),
        isUsingOverage: Schema.optionalKey(Schema.Boolean),
        overageInUse: Schema.optionalKey(Schema.Boolean),
      }),
    }),
  }),
);

export function claudeUsageLimitResetAt(resetsAt: unknown): string | null {
  const resetMs = typeof resetsAt === "number" ? resetsAt * 1000 : NaN;
  return Number.isFinite(resetMs) && resetMs > 0 && resetMs < 8.64e15
    ? DateTime.formatIso(DateTime.makeUnsafe(resetMs))
    : null;
}

export function gatewayCooldownResetAt(
  cooldown: RegExpExecArray | null,
  completedAt: DateTime.Utc,
): string | undefined {
  if (cooldown === null) return undefined;
  const seconds =
    Number(cooldown[1] ?? 0) * 3_600 + Number(cooldown[2] ?? 0) * 60 + Number(cooldown[3] ?? 0);
  const resetMs = DateTime.toEpochMillis(completedAt) + seconds * 1_000;
  return seconds > 0 && resetMs < 8.64e15
    ? DateTime.formatIso(DateTime.makeUnsafe(resetMs))
    : undefined;
}

export function providerFailureFromResult(
  message: SDKResultMessage,
  receivedAt: DateTime.Utc,
  failureHint?: string,
  usageLimited = false,
): OrchestrationV2ProviderFailure | null {
  const gatewayResetAt =
    failureHint === undefined &&
    message.subtype === "success" &&
    message.is_error &&
    message.terminal_reason === "api_error" &&
    message.api_error_status === 503
      ? gatewayCooldownResetAt(
          /^API Error: 503 \[[^\]\r\n]+\] \[429\]: \{"type":"error","error":\{"type":"rate_limit_error",[^\r\n]*\} \(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/.exec(
            message.result,
          ),
          receivedAt,
        )
      : undefined;
  if (gatewayResetAt !== undefined) {
    return makeProviderFailure({
      class: "usage_limit",
      message: "Claude API rate limit reached. Try again later.",
      code: "api_error_429",
      retryable: true,
      resetAt: gatewayResetAt,
    });
  }
  const failureClass =
    (message.subtype === "success" && message.api_error_status === 429) || usageLimited
      ? "usage_limit"
      : "provider_error";
  const listedError = resultUserFacingError(message);
  const apiErrorMessage =
    message.subtype === "success" &&
    message.terminal_reason === "api_error" &&
    message.result.trim().startsWith("API Error:")
      ? makeProviderFailure({ message: message.result }).message.slice(0, 500)
      : undefined;
  const structuredError = isOverloadedResult(message)
    ? "Claude API is overloaded (529). Try again shortly."
    : message.subtype === "success" && message.api_error_status === 429
      ? "Claude API rate limit reached. Try again later."
      : terminalResultError(message.terminal_reason, failureHint ?? apiErrorMessage);
  if (message.subtype !== "success") {
    return makeProviderFailure({
      message: listedError ?? structuredError ?? message.errors.join("\n"),
      code: message.subtype,
      class: failureClass,
    });
  }
  if (!message.is_error && structuredError === undefined) {
    return null;
  }
  const apiErrorStatus = message.api_error_status ?? null;
  // API-key sessions get no rate_limit_info, so a gateway's 429 carries its reset only as text.
  const resetAt =
    apiErrorStatus === 429 && message.result.startsWith("API Error:")
      ? gatewayCooldownResetAt(
          /\(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/.exec(message.result),
          receivedAt,
        )
      : undefined;
  return makeProviderFailure({
    message: listedError ?? structuredError ?? failureHint ?? message.result,
    code:
      apiErrorStatus === null
        ? (message.terminal_reason ?? "sdk_result_error")
        : `api_error_${apiErrorStatus}`,
    class: failureClass,
    retryable: apiErrorStatus === 429 || apiErrorStatus === 529 ? true : null,
    resetAt: resetAt ?? null,
  });
}

export function providerFailureFromApiRetry(
  message: SDKAPIRetryMessage,
): OrchestrationV2ProviderFailure {
  const errorName = message.error.replaceAll("_", " ");
  return makeProviderFailure({
    message: `Claude API ${errorName}.`,
    code:
      message.error_status === null
        ? message.error
        : `api_error_${Math.trunc(message.error_status)}`,
    class:
      message.error_status === 429
        ? "usage_limit"
        : message.error_status === null
          ? "transport_error"
          : "provider_error",
    retryable: true,
  });
}
