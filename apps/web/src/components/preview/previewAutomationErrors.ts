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
    environmentId: EnvironmentId,
    threadId: ThreadId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview webview for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} did not register within ${this.timeoutMs}ms.`;
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

const PreviewAutomationTargetHostFields = {
  requestId: TrimmedNonEmptyString,
  operation: PreviewAutomationOperation,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  tabId: Schema.NullOr(PreviewTabId),
  cause: Schema.Defect(),
};

const readTargetLookupKind = (
  cause: unknown,
): "missing" | "hidden" | "disabled" | "ambiguous" | null => {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) return null;
  if (cause._tag === "PreviewAutomationTargetHiddenError") return "hidden";
  if (cause._tag === "PreviewAutomationTargetDisabledError") return "disabled";
  if (cause._tag === "PreviewAutomationTargetAmbiguousError") return "ambiguous";
  if (cause._tag === "PreviewAutomationTargetNotFoundError") return "missing";
  return null;
};

const readAmbiguousMatchCount = (cause: unknown): number => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "matchCount" in cause &&
    typeof cause.matchCount === "number" &&
    Number.isInteger(cause.matchCount) &&
    cause.matchCount >= 0
  ) {
    return cause.matchCount;
  }
  return 0;
};

export class PreviewAutomationTargetNotFoundHostError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotFoundHostError>()(
  "PreviewAutomationTargetNotFoundHostError",
  PreviewAutomationTargetHostFields,
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} could not find a target in tab ${this.tabId ?? "unassigned"}.`;
  }
}

export class PreviewAutomationTargetHiddenHostError extends Schema.TaggedErrorClass<PreviewAutomationTargetHiddenHostError>()(
  "PreviewAutomationTargetHiddenHostError",
  PreviewAutomationTargetHostFields,
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} found a target in tab ${this.tabId ?? "unassigned"}, but it is not visible.`;
  }
}

export class PreviewAutomationTargetDisabledHostError extends Schema.TaggedErrorClass<PreviewAutomationTargetDisabledHostError>()(
  "PreviewAutomationTargetDisabledHostError",
  PreviewAutomationTargetHostFields,
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} found a target in tab ${this.tabId ?? "unassigned"}, but it is disabled.`;
  }
}

export class PreviewAutomationTargetAmbiguousHostError extends Schema.TaggedErrorClass<PreviewAutomationTargetAmbiguousHostError>()(
  "PreviewAutomationTargetAmbiguousHostError",
  {
    ...PreviewAutomationTargetHostFields,
    matchCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  },
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} matched ${this.matchCount} elements in tab ${this.tabId ?? "unassigned"}.`;
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
    const lookupKind = readTargetLookupKind(input.cause);
    if (lookupKind) {
      const shared = {
        requestId: input.requestId,
        operation: input.operation,
        environmentId: input.environmentId,
        threadId: input.threadId,
        tabId: input.tabId,
        cause: input.cause,
      };
      if (lookupKind === "hidden") return new PreviewAutomationTargetHiddenHostError(shared);
      if (lookupKind === "disabled") return new PreviewAutomationTargetDisabledHostError(shared);
      if (lookupKind === "ambiguous") {
        return new PreviewAutomationTargetAmbiguousHostError({
          ...shared,
          matchCount: readAmbiguousMatchCount(input.cause),
        });
      }
      return new PreviewAutomationTargetNotFoundHostError(shared);
    }
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
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationViewportTimeoutError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetNotFoundHostError,
  PreviewAutomationTargetHiddenHostError,
  PreviewAutomationTargetDisabledHostError,
  PreviewAutomationTargetAmbiguousHostError,
  PreviewAutomationTargetNotEditableHostError,
  PreviewAutomationOperationError,
]);
export type PreviewAutomationHostError = typeof PreviewAutomationHostError.Type;

export const isPreviewAutomationHostError = Schema.is(PreviewAutomationHostError);

export function serializePreviewAutomationHostError(
  error: PreviewAutomationHostError,
): NonNullable<PreviewAutomationResponse["error"]> {
  const detail = Object.fromEntries(
    Object.entries(error).filter(
      ([key]) =>
        key !== "_tag" && key !== "cause" && key !== "name" && key !== "message" && key !== "stack",
    ),
  );
  return {
    _tag: error.responseTag,
    message: error.message,
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}
