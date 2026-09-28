import {
  EnvironmentId,
  PreviewAutomationManagedTargetAuthError,
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
    readiness: Schema.Literals(["domContentLoaded", "load", "networkIdle"]),
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
    candidateLocators: Schema.optional(Schema.Array(Schema.String)),
  },
) {
  get responseTag() {
    return "PreviewAutomationTargetNotEditableError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} requires an editable target in tab ${this.tabId ?? "unassigned"}.`;
  }
}

export class PreviewAutomationInvalidSelectorHostError extends Schema.TaggedErrorClass<PreviewAutomationInvalidSelectorHostError>()(
  "PreviewAutomationInvalidSelectorHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    selectorKind: Schema.optional(Schema.Literals(["locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    candidateLocators: Schema.optional(Schema.Array(Schema.String)),
  },
) {
  get responseTag() {
    return "PreviewAutomationInvalidSelectorError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} received an invalid selector in tab ${this.tabId ?? "unassigned"}.`;
  }
}

export class PreviewAutomationTargetNotFoundHostError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotFoundHostError>()(
  "PreviewAutomationTargetNotFoundHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    selectorKind: Schema.optional(Schema.Literals(["locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    candidateLocators: Schema.optional(Schema.Array(Schema.String)),
  },
) {
  get responseTag() {
    return "PreviewAutomationTargetNotFoundError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} could not find its target in tab ${this.tabId ?? "unassigned"}.`;
  }
}

const readSelectorKind = (
  cause: object,
): "focused-element" | "locator" | "selector" | undefined => {
  if (!("selectorKind" in cause)) return undefined;
  const value = cause.selectorKind;
  if (value === "focused-element" || value === "locator" || value === "selector") {
    return value;
  }
  return undefined;
};

const readSelectorLength = (cause: object): number | undefined => {
  if (!("selectorLength" in cause)) return undefined;
  const value = cause.selectorLength;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
};

const readCandidateLocators = (cause: object): string[] | undefined => {
  if (!("candidateLocators" in cause) || !Array.isArray(cause.candidateLocators)) {
    return undefined;
  }
  const values = cause.candidateLocators.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return values.length > 0 ? values : undefined;
};

const targetNotEditableDiagnostics = (
  cause: unknown,
): {
  readonly selectorKind?: "focused-element" | "locator" | "selector";
  readonly selectorLength?: number;
  readonly candidateLocators?: string[];
} | null => {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("_tag" in cause) ||
    cause._tag !== "PreviewAutomationTargetNotEditableError"
  ) {
    return null;
  }
  const selectorKind = readSelectorKind(cause);
  const selectorLength = readSelectorLength(cause);
  const candidateLocators = readCandidateLocators(cause);
  return {
    ...(selectorKind === undefined ? {} : { selectorKind }),
    ...(selectorLength === undefined ? {} : { selectorLength }),
    ...(candidateLocators === undefined ? {} : { candidateLocators }),
  };
};

const targetSelectorDiagnostics = (
  cause: unknown,
  tag: "PreviewAutomationTargetNotFoundError" | "PreviewAutomationInvalidSelectorError",
): {
  readonly selectorKind?: "locator" | "selector";
  readonly selectorLength?: number;
  readonly candidateLocators?: string[];
} | null => {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause) || cause._tag !== tag) {
    return null;
  }
  const selectorKind = readSelectorKind(cause);
  const selectorLength = readSelectorLength(cause);
  const candidateLocators = readCandidateLocators(cause);
  return {
    ...(selectorKind === "locator" || selectorKind === "selector" ? { selectorKind } : {}),
    ...(selectorLength === undefined ? {} : { selectorLength }),
    ...(candidateLocators === undefined ? {} : { candidateLocators }),
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
    const notEditable = targetNotEditableDiagnostics(input.cause);
    if (notEditable) {
      return new PreviewAutomationTargetNotEditableHostError({
        requestId: input.requestId,
        operation: input.operation,
        environmentId: input.environmentId,
        threadId: input.threadId,
        tabId: input.tabId,
        ...notEditable,
      });
    }
    const notFound = targetSelectorDiagnostics(input.cause, "PreviewAutomationTargetNotFoundError");
    if (notFound) {
      return new PreviewAutomationTargetNotFoundHostError({
        requestId: input.requestId,
        operation: input.operation,
        environmentId: input.environmentId,
        threadId: input.threadId,
        tabId: input.tabId,
        ...notFound,
      });
    }
    const invalidSelector = targetSelectorDiagnostics(
      input.cause,
      "PreviewAutomationInvalidSelectorError",
    );
    if (invalidSelector) {
      return new PreviewAutomationInvalidSelectorHostError({
        requestId: input.requestId,
        operation: input.operation,
        environmentId: input.environmentId,
        threadId: input.threadId,
        tabId: input.tabId,
        ...invalidSelector,
      });
    }
    return new PreviewAutomationOperationError(input);
  }

  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} failed on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"}).`;
  }
}

export const PreviewAutomationHostError = Schema.Union([
  PreviewAutomationManagedTargetAuthError,
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationViewportTimeoutError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetNotEditableHostError,
  PreviewAutomationTargetNotFoundHostError,
  PreviewAutomationInvalidSelectorHostError,
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
