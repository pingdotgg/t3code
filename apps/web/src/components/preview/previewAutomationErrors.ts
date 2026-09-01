import {
  EnvironmentId,
  type PreviewAutomationHost,
  PreviewAutomationOperation,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  PreviewTabId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface PreviewAutomationOperationContext {
  readonly requestId: PreviewAutomationRequest["requestId"];
  readonly operation: PreviewAutomationRequest["operation"];
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly threadId: PreviewAutomationRequest["threadId"];
  readonly tabId: Exclude<PreviewAutomationRequest["tabId"], undefined> | null;
}

export class PreviewAutomationOverlayTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationOverlayTimeoutError>()(
  "PreviewAutomationOverlayTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    stage: Schema.Literal("overlay-readiness"),
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview webview for ${this.operation} request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} tab ${this.tabId} did not become compositing-ready within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationHostDeadlineError extends Schema.TaggedErrorClass<PreviewAutomationHostDeadlineError>()(
  "PreviewAutomationHostDeadlineError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    stage: Schema.Literal("host-execution"),
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} exceeded its ${this.timeoutMs}ms host execution deadline.`;
  }
}

export class PreviewAutomationDesktopFailureError extends Schema.TaggedErrorClass<PreviewAutomationDesktopFailureError>()(
  "PreviewAutomationDesktopFailureError",
  {
    nativeName: TrimmedNonEmptyString,
    safeMessage: TrimmedNonEmptyString,
    stage: Schema.optional(TrimmedNonEmptyString),
  },
) {
  override get message(): string {
    return this.stage === undefined
      ? `Desktop preview failed with ${this.nativeName}.`
      : `Desktop preview failed with ${this.nativeName} during ${this.stage}.`;
  }
}

export class PreviewAutomationNavigationTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationNavigationTimeoutError>()(
  "PreviewAutomationNavigationTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    readiness: Schema.Literals(["domContentLoaded", "load"]),
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview navigation for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} tab ${this.tabId} did not reach ${this.readiness} readiness within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationViewportTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationViewportTimeoutError>()(
  "PreviewAutomationViewportTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview viewport for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} tab ${this.tabId} was not rendered within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationTargetUnavailableError extends Schema.TaggedErrorClass<PreviewAutomationTargetUnavailableError>()(
  "PreviewAutomationTargetUnavailableError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    bridgeAvailable: Schema.Boolean,
  },
) {
  get responseTag() {
    return "PreviewAutomationTabNotFoundError" as const;
  }

  override get message(): string {
    return `Preview automation target for ${this.operation} request ${this.requestId} is unavailable on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"}, bridge ${this.bridgeAvailable ? "available" : "unavailable"}).`;
  }
}

export class PreviewAutomationRecordingNotActiveError extends Schema.TaggedErrorClass<PreviewAutomationRecordingNotActiveError>()(
  "PreviewAutomationRecordingNotActiveError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
  },
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation request ${this.requestId} found no active recording for tab ${this.tabId ?? "unassigned"} on environment ${this.environmentId} thread ${this.threadId}.`;
  }
}

export class PreviewAutomationTargetNotEditableHostError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotEditableHostError>()(
  "PreviewAutomationTargetNotEditableHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  get responseTag() {
    return "PreviewAutomationTargetNotEditableError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} requires an editable target in tab ${this.tabId ?? "unassigned"}.`;
  }
}

const targetNotEditableDiagnostics = (
  cause: unknown,
): {
  readonly selectorKind?: "focused-element" | "locator" | "selector";
  readonly selectorLength?: number;
} | null => {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("_tag" in cause) ||
    cause._tag !== "PreviewAutomationTargetNotEditableError"
  ) {
    return null;
  }
  const selectorKind =
    "selectorKind" in cause &&
    (cause.selectorKind === "focused-element" ||
      cause.selectorKind === "locator" ||
      cause.selectorKind === "selector")
      ? cause.selectorKind
      : undefined;
  const selectorLength =
    "selectorLength" in cause &&
    typeof cause.selectorLength === "number" &&
    Number.isInteger(cause.selectorLength) &&
    cause.selectorLength >= 0
      ? cause.selectorLength
      : undefined;
  return {
    ...(selectorKind === undefined ? {} : { selectorKind }),
    ...(selectorLength === undefined ? {} : { selectorLength }),
  };
};

export class PreviewAutomationOperationError extends Schema.TaggedErrorClass<PreviewAutomationOperationError>()(
  "PreviewAutomationOperationError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    input: PreviewAutomationOperationContext & { readonly cause: unknown },
  ): PreviewAutomationHostError {
    if (isPreviewAutomationHostError(input.cause)) return input.cause;
    const diagnostics = targetNotEditableDiagnostics(input.cause);
    return diagnostics
      ? new PreviewAutomationTargetNotEditableHostError({
          requestId: input.requestId,
          operation: input.operation,
          environmentId: input.environmentId,
          threadId: input.threadId,
          tabId: input.tabId,
          ...diagnostics,
        })
      : new PreviewAutomationOperationError(input);
  }

  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} failed on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"}).`;
  }
}

export const PreviewAutomationHostError = Schema.Union([
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationHostDeadlineError,
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationViewportTimeoutError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetNotEditableHostError,
  PreviewAutomationOperationError,
]);
export type PreviewAutomationHostError = typeof PreviewAutomationHostError.Type;

export const isPreviewAutomationHostError = Schema.is(PreviewAutomationHostError);

const SAFE_NATIVE_ERROR_NAMES = new Set(["AbortError", "UnknownVizError"]);
const SAFE_ERROR_STAGE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_ERROR_TAG_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const isPreviewAutomationDesktopFailureError = Schema.is(PreviewAutomationDesktopFailureError);

const timeoutMessage = (stage?: string): string =>
  stage === undefined
    ? "Preview automation timed out."
    : `Preview automation timed out during ${stage}.`;

const safeErrorCause = (
  cause: unknown,
): { readonly name: string; readonly message: string; readonly stage?: string } | null => {
  if (isPreviewAutomationDesktopFailureError(cause)) {
    return {
      name: cause.nativeName,
      message: cause.safeMessage,
      ...(cause.stage === undefined ? {} : { stage: cause.stage }),
    };
  }
  if (typeof cause !== "object" || cause === null) return null;
  const record = cause as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : "";
  const message = typeof record["message"] === "string" ? record["message"] : "";
  const rawStage = typeof record["stage"] === "string" ? record["stage"] : undefined;
  const stage =
    rawStage !== undefined && SAFE_ERROR_STAGE_PATTERN.test(rawStage) ? rawStage : undefined;
  if (SAFE_NATIVE_ERROR_NAMES.has(name)) {
    return {
      name,
      message: "Preview capture failed.",
      ...(stage === undefined ? {} : { stage }),
    };
  }
  const flattenedOwnedTimeout = message.match(
    /\bPreview[^\n]{0,160}?timed out during ([a-z][a-z0-9-]{0,63}) after \d+ms/,
  );
  if (flattenedOwnedTimeout?.[1]) {
    return {
      name: "PreviewAutomationTimeoutError",
      message: timeoutMessage(flattenedOwnedTimeout[1]),
      stage: flattenedOwnedTimeout[1],
    };
  }
  const rawTag = typeof record["_tag"] === "string" ? record["_tag"] : "";
  const tag = SAFE_ERROR_TAG_PATTERN.test(rawTag) ? rawTag : "";
  if (tag.endsWith("TimeoutError") && message.length > 0) {
    return {
      name: tag,
      message: timeoutMessage(stage),
      ...(stage === undefined ? {} : { stage }),
    };
  }
  return null;
};

export function serializePreviewAutomationHostError(
  error: PreviewAutomationHostError,
): NonNullable<PreviewAutomationResponse["error"]> {
  const detail = Object.fromEntries(
    Object.entries(error).filter(
      ([key]) =>
        key !== "_tag" && key !== "cause" && key !== "name" && key !== "message" && key !== "stack",
    ),
  );
  const cause = "cause" in error ? safeErrorCause(error.cause) : null;
  return {
    _tag: error.responseTag,
    message: error.message,
    ...(Object.keys(detail).length === 0 && cause === null
      ? {}
      : { detail: { ...detail, ...(cause === null ? {} : { cause }) } }),
  };
}
