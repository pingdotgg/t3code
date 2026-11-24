import type {
  NodeId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";

import * as IdAllocator from "./IdAllocator.ts";
import type { ProviderAdapterFailureReason } from "./ProviderAdapter.ts";
import * as Schema from "effect/Schema";

export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  {},
) {
  override get message() {
    return "The request leaves too little context for a provider handoff. Shorten the request or use a larger-context model; the current request has not been truncated.";
  }
}

export class ContextHandoffBackgroundWorkError extends Schema.TaggedError<ContextHandoffBackgroundWorkError>()(
  "ContextHandoffBackgroundWorkError",
  {},
) {
  override get message() {
    return "The target provider still has background work running. Wait for it to finish or stop it before retrying the handoff.";
  }
}

export const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_096;
const MAX_PROVIDER_FAILURE_CODE_LENGTH = 128;

const DEFAULT_PROVIDER_FAILURE_MESSAGE = "Provider turn failed.";
const PROVIDER_STORAGE_FULL_MESSAGE =
  "The provider's disk or database is full. Free space on the machine running the T3 Code server, then retry the turn. If disk space is available, check the provider's database size limit.";
const STORAGE_FULL_OUTPUT =
  /\b(?:ENOSPC|SQLITE_FULL|no space left on device|database (?:or disk )?is full|disk is full)\b/iu;
// inotify also reports ENOSPC when its watch limit is exhausted.
const WATCH_LIMIT_OUTPUT = /\bSystem limit for number of file watchers reached\b/iu;

function isStorageFullOutput(output: unknown): boolean {
  return (
    typeof output === "string" &&
    STORAGE_FULL_OUTPUT.test(output) &&
    !WATCH_LIMIT_OUTPUT.test(output)
  );
}

function hasStorageFullCause(cause: unknown): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") return isStorageFullOutput(cause);
      const error = cause as Record<string, unknown>;
      const message = stringField(cause, "message");
      const code = stringField(cause, "code");
      const syscall = stringField(cause, "syscall");
      if (syscall === "watch" || syscall === "inotify_add_watch") return false;
      if (
        isStorageFullOutput(message) ||
        ((code === "ENOSPC" || code === "SQLITE_FULL") &&
          !WATCH_LIMIT_OUTPUT.test(message ?? "")) ||
        (error._tag === "AcpRequestError" &&
          isStorageFullOutput(stringField(cause, "errorMessage"))) ||
        ((error._tag === "AcpProcessExitedError" ||
          error._tag === "CodexAppServerProcessExitedError") &&
          isStorageFullOutput(stringField(cause, "stderr")))
      ) {
        return true;
      }
      cause = error.cause;
    } catch {
      return false;
    }
  }
  return false;
}

// Gateways answer an oversized body with a 413 page; resending the same history fails identically.
const REQUEST_TOO_LARGE_STATUS = /^\s*(?:(?:API Error|Error|HTTP|status)(?:\s*:)?\s*)?413\b/iu;
const REQUEST_TOO_LARGE_REASON = /\b(?:Request Entity|Payload|Content) Too Large\b/u;
const REQUEST_TOO_LARGE_MESSAGE =
  "This thread's request is too large for the provider (HTTP 413), so retrying fails the same way. Start a fresh session with /clear, or continue in a new thread.";

const PROVIDER_FAILURE_CATEGORIES: Partial<
  Record<string, { readonly summary: string; readonly guidance: string }>
> = {
  ProviderAdapterTurnStartError: {
    summary: "The provider could not start this turn",
    guidance: "Retry the turn; if it keeps failing, check the provider setup and server logs.",
  },
  ProviderAdapterEventStreamError: {
    summary: "The provider event stream closed unexpectedly",
    guidance: "Retry the turn; if it keeps failing, check the provider and server logs.",
  },
  ProviderAdapterOpenSessionError: {
    summary: "The provider session could not be opened",
    guidance: "Check that the provider is installed and signed in, then retry the turn.",
  },
  ProviderAdapterResumeThreadError: {
    summary: "The provider conversation could not be resumed",
    guidance: "Retry the turn; if it keeps failing, check the provider and server logs.",
  },
};

// macOS privacy protection (TCC) refuses a CLI the project folder with EPERM.
const PERMISSION_DENIED_OUTPUT = /\bEPERM\b|Operation not permitted/u;

/**
 * What to do after a provider CLI exits on its own. Only recognises the
 * output; the output itself stays out of the message.
 */
export function providerProcessExitGuidance(output: unknown): string {
  if (isStorageFullOutput(output)) return PROVIDER_STORAGE_FULL_MESSAGE;
  return typeof output === "string" && PERMISSION_DENIED_OUTPUT.test(output)
    ? "It was denied access to a file or folder (EPERM). On macOS, allow T3 Code under System Settings > Privacy & Security > Files and Folders, or move the project out of Desktop, Documents, or Downloads, then retry the turn."
    : "Check the server logs for the provider's output, then retry the turn.";
}

// codex_protocol::protocol::validate_thread_goal_objective
const CODEX_GOAL_VALIDATION_MESSAGE =
  /^goal objective must (?:not be empty|be at most \d{1,6} characters)$/u;

// codex_config::ConstraintError::InvalidValue for a managed requirements.toml or cloud policy.
const CODEX_ACCESS_REQUIREMENT_REJECTION =
  /invalid value for `(approval_policy|sandbox_mode)`: `([A-Za-z]{1,32})` is not in the allowed set /u;

const PROVIDER_FAILURE_REASONS: Record<ProviderAdapterFailureReason, string> = {
  previous_turn_active: "the previous turn is still running",
  attachment_unreadable: "an attachment could not be read",
};

/**
 * Walks a cause chain for curated text without reading arbitrary provider
 * defect text. `known` is the message of a domain error T3 raised itself;
 * `category` is the generic message of the innermost provider wrapper seen.
 */
function curatedCauseMessages(cause: unknown): {
  readonly known: string | undefined;
  readonly category: string | undefined;
} {
  const seen = new Set<unknown>();
  let category: (typeof PROVIDER_FAILURE_CATEGORIES)[string];
  let reason: string | undefined;
  const categoryMessage = () => {
    if (category === undefined) return undefined;
    return reason
      ? `${category.summary}: ${reason}. ${category.guidance}`
      : `${category.summary}. ${category.guidance}`;
  };
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") break;
      const tag = (cause as Record<string, unknown>)._tag;
      switch (tag) {
        case "ContextHandoffBudgetError":
          return { known: new ContextHandoffBudgetError().message, category: categoryMessage() };
        case "ContextHandoffBackgroundWorkError":
          return {
            known: new ContextHandoffBackgroundWorkError().message,
            category: categoryMessage(),
          };
        case "AcpModelSelectionError":
        case "ClaudeBackgroundWorkBlocksQueryReplacementError":
        case "ClaudeAppendSystemPromptFileError":
        case "ClaudeAppendSystemPromptMissingValueError":
        case "ClaudeSettingsLaunchArgError":
        case "ClaudeMcpRegistrationTimeoutError":
        case "ClaudeCodeRootRefusalError":
        case "ClaudeCodeStartupExitError":
        case "ClaudeConversationNotFoundError":
        case "CursorModelUnavailableError":
        case "CodexGoalObjectiveTooLongError":
        case "CodexAppServerUnresponsiveError":
        case "CodexAppServerRetiredError":
        case "ProviderSetupError":
        case "ProviderAdapterThreadInUseError":
        case "ProviderCompactionUnsupportedError":
          return { known: stringField(cause, "message"), category: categoryMessage() };
        case "CodexAppServerRequestError": {
          // Only Codex's fixed-shape goal validation and managed-requirements
          // text is actionable and safe to show; other request error text stays hidden.
          const rejection = stringField(cause, "message");
          if (
            (cause as Record<string, unknown>).method === "thread/goal/set" &&
            rejection !== undefined &&
            CODEX_GOAL_VALIDATION_MESSAGE.test(rejection)
          ) {
            return { known: `Codex rejected the goal: ${rejection}.`, category: categoryMessage() };
          }
          const access =
            rejection === undefined ? null : CODEX_ACCESS_REQUIREMENT_REJECTION.exec(rejection);
          if (access !== null) {
            return {
              known: `Codex's managed requirements do not allow \`${access[1]}\` \`${access[2]}\`, which this thread's access mode uses. Switch the thread to an access mode the policy allows.`,
              category: categoryMessage(),
            };
          }
          break;
        }
        case "AcpProcessExitedError":
        case "CodexAppServerProcessExitedError": {
          const exit = `provider process exited${processExitStatus(cause)}`;
          const stage = category === undefined ? `The ${exit}` : `${category.summary}: the ${exit}`;
          const guidance = providerProcessExitGuidance((cause as Record<string, unknown>).stderr);
          return {
            known: `${stage}. ${guidance}`,
            category: categoryMessage(),
          };
        }
        // ACP reserves -32000 for auth_required; the agent's own text is not shown.
        case "AcpRequestError":
          if ((cause as Record<string, unknown>).code !== -32000) break;
          return {
            known:
              "The provider needs you to sign in. Sign in from its provider settings or with its own CLI or app, then retry the turn.",
            category: categoryMessage(),
          };
        case "ContextHandoffDeliveryUncertainError":
          return {
            known:
              "T3 could not confirm whether conversation history reached the provider. Retry the turn to recover the session.",
            category: categoryMessage(),
          };
        case "ProviderAdapterProtocolError": {
          const typedReason = (cause as Record<string, unknown>).reason;
          if (
            category !== undefined &&
            typeof typedReason === "string" &&
            Object.hasOwn(PROVIDER_FAILURE_REASONS, typedReason)
          ) {
            reason ??= PROVIDER_FAILURE_REASONS[typedReason as ProviderAdapterFailureReason];
          }
          break;
        }
      }
      if (typeof tag === "string" && Object.hasOwn(PROVIDER_FAILURE_CATEGORIES, tag)) {
        category = PROVIDER_FAILURE_CATEGORIES[tag];
        reason = undefined;
      }
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      break;
    }
  }
  return { known: undefined, category: categoryMessage() };
}

// Only the structured status; stderr and the spawner cause can carry provider output.
function processExitStatus(exited: object): string {
  const { signal, code } = exited as Record<string, unknown>;
  if (typeof signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(signal)) {
    return ` after signal ${signal}`;
  }
  return typeof code === "number" && Number.isSafeInteger(code) ? ` with code ${code}` : "";
}

/**
 * The curated message of a domain error in a failure's cause chain, if any.
 * Callers that pass their own `message` to `makeProviderFailure` check it
 * first, so a known reason is not hidden behind a wrapper's text.
 */
export function knownProviderFailureMessage(cause: unknown): string | undefined {
  return hasStorageFullCause(cause)
    ? PROVIDER_STORAGE_FULL_MESSAGE
    : curatedCauseMessages(cause).known;
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? "";
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  const sanitized: Array<string> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized.push(
      codePoint <= 0x08 ||
        (codePoint >= 0x0b && codePoint <= 0x0c) ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character,
    );
  }
  return sanitized.join("");
}

function redactProviderFailureText(value: string): string {
  return replaceUnsafeControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'][\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /((?<![\w-])[\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .trim();
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redactProviderFailureText(value);
  if (redacted.length <= maxLength) return redacted;
  let end = Math.max(0, maxLength - 1);
  const finalCodeUnit = redacted.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${redacted.slice(0, end)}…`;
}

export function makeProviderFailure(input: {
  readonly cause?: unknown;
  readonly message?: string | undefined;
  readonly code?: string | null | undefined;
  readonly class?: OrchestrationV2ProviderFailureClass;
  readonly retryable?: boolean | null;
  readonly resetAt?: string | null;
}): OrchestrationV2ProviderFailure {
  const storageFull = hasStorageFullCause(input);
  const curated = curatedCauseMessages(input.cause);
  const requestTooLarge =
    input.message !== undefined &&
    (REQUEST_TOO_LARGE_STATUS.test(input.message) || REQUEST_TOO_LARGE_REASON.test(input.message));
  const rawMessage = storageFull
    ? PROVIDER_STORAGE_FULL_MESSAGE
    : requestTooLarge
      ? REQUEST_TOO_LARGE_MESSAGE
      : (input.message ?? curated.known ?? curated.category ?? DEFAULT_PROVIDER_FAILURE_MESSAGE);
  const message = boundedText(rawMessage, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  const rawCode = input.code ?? stringField(input.cause, "code") ?? null;
  const code =
    rawCode === null ? null : boundedText(rawCode, MAX_PROVIDER_FAILURE_CODE_LENGTH) || null;

  return {
    class: storageFull ? "provider_error" : (input.class ?? "unknown"),
    message: message || DEFAULT_PROVIDER_FAILURE_MESSAGE,
    code: storageFull ? "provider_storage_full" : code,
    retryable: storageFull || requestTooLarge ? false : (input.retryable ?? null),
    ...(!storageFull &&
    input.class === "usage_limit" &&
    input.resetAt != null &&
    Number.isFinite(Date.parse(input.resetAt))
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(input.resetAt)) }
      : {}),
  };
}

export function makeProviderFailureTurnItem(input: {
  // Defaults to the turn's single failure row.
  readonly id?: TurnItemId;
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry?: OrchestrationV2ProviderRetry;
  readonly retryStartedAt?: DateTime.Utc;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  return {
    id:
      input.id ??
      IdAllocator.derive.turnItemFromProviderItem({
        driver: input.driver,
        nativeItemId: `terminal-failure:${input.providerTurnId}`,
      }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: "failed",
    title: input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
    startedAt: input.retryStartedAt ?? input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "error",
    failure: input.failure,
    ...(input.retry === undefined ? {} : { retry: input.retry }),
  };
}

/**
 * Longest a turn may stay in provider retries before the adapter stops it as
 * failed. Codex waits for the network without limit and a hung Claude request
 * can take many minutes per attempt, so counting attempts alone never ends them.
 */
export const PROVIDER_RETRY_BUDGET_MS = 10 * 60 * 1000;

export function makeProviderRetryTurnItem(input: {
  readonly id?: TurnItemId;
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  const completed = input.status !== "running";
  let title = "Provider retry";
  if (input.status === "completed") {
    title = "Provider recovered";
  } else if (input.status === "failed") {
    title = input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
  } else if (input.status === "interrupted" || input.status === "cancelled") {
    title = "Provider retry stopped";
  }
  return {
    id:
      input.id ??
      IdAllocator.derive.turnItemFromProviderItem({
        driver: input.driver,
        nativeItemId: `terminal-failure:${input.providerTurnId}`,
      }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: input.status,
    title,
    startedAt: input.startedAt,
    completedAt: completed ? input.updatedAt : null,
    updatedAt: input.updatedAt,
    type: "error",
    failure: input.failure,
    retry: input.retry,
  };
}
