import { Schema } from "effect";
import {
  EnvironmentId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { LegacySelector, Locator, OptionalTimeoutMs, PreviewAutomationOperation, PreviewAutomationTabTargetFields } from "./previewAutomationPart2.ts";
export type { PreviewAutomationAction } from "./previewAutomationPart2.ts";
export {
  BrowserNavigationTarget,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationActInput,
  PreviewAutomationActInputs,
  PreviewAutomationClickInput,
  PreviewAutomationDialogInput,
  PreviewAutomationDragInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHoverInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationOperation,
  PreviewAutomationPressInput,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationUploadInput,
} from "./previewAutomationPart2.ts";

export const PreviewAutomationWaitForInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  text: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Case counts.",
  }),
  urlIncludes: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter((input) => {
    if (input.selector !== undefined && input.locator !== undefined) {
      return "Provide at most one of selector or locator.";
    }
    return (
      input.selector !== undefined ||
      input.locator !== undefined ||
      input.text !== undefined ||
      input.urlIncludes !== undefined ||
      "Provide at least one wait condition."
    );
  }),
);
export type PreviewAutomationWaitForInput = typeof PreviewAutomationWaitForInput.Type;

const PreviewAutomationElement = Schema.Struct({
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  selector: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
type PreviewAutomationElement = typeof PreviewAutomationElement.Type;

export const PreviewAutomationConsoleEntry = Schema.Struct({
  level: Schema.String,
  text: Schema.String,
  timestamp: Schema.String,
  source: Schema.optional(Schema.String),
});
export type PreviewAutomationConsoleEntry = typeof PreviewAutomationConsoleEntry.Type;

export const PreviewAutomationNetworkEntry = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  status: Schema.NullOr(Schema.Number),
  failed: Schema.Boolean,
  errorText: Schema.optional(Schema.String),
  timestamp: Schema.String,
});
export type PreviewAutomationNetworkEntry = typeof PreviewAutomationNetworkEntry.Type;

export const PreviewAutomationActionEvent = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed", "interrupted"]),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PreviewAutomationActionEvent = typeof PreviewAutomationActionEvent.Type;

export const PreviewAutomationSnapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  visibleText: Schema.String,
  interactiveElements: Schema.Array(PreviewAutomationElement),
  accessibilityTree: Schema.Unknown,
  consoleEntries: Schema.Array(PreviewAutomationConsoleEntry),
  networkEntries: Schema.Array(PreviewAutomationNetworkEntry),
  actionTimeline: Schema.Array(PreviewAutomationActionEvent),
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type PreviewAutomationSnapshot = typeof PreviewAutomationSnapshot.Type;

export const PreviewAutomationRecordingStatus = Schema.Struct({
  tabId: PreviewTabId,
  recording: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.String),
});
export type PreviewAutomationRecordingStatus = typeof PreviewAutomationRecordingStatus.Type;

export const PREVIEW_RECORDING_STOP_TIMEOUT_MS = 120_000;

export const PreviewAutomationRecordingArtifact = Schema.Struct({
  id: Schema.String,
  tabId: PreviewTabId,
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.String,
});
export type PreviewAutomationRecordingArtifact = typeof PreviewAutomationRecordingArtifact.Type;

const PreviewAutomationClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
type PreviewAutomationClientId = typeof PreviewAutomationClientId.Type;

const PreviewAutomationConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
type PreviewAutomationConnectionId = typeof PreviewAutomationConnectionId.Type;

const PreviewAutomationHostIdentity = Schema.Struct({
  clientId: PreviewAutomationClientId,
  environmentId: EnvironmentId,
});
type PreviewAutomationHostIdentity = typeof PreviewAutomationHostIdentity.Type;

export const PreviewAutomationHost = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  /** Missing means the V1 operation set from before capability negotiation. */
  supportedOperations: Schema.optional(Schema.Array(PreviewAutomationOperation)),
});
export type PreviewAutomationHost = typeof PreviewAutomationHost.Type;

export const PreviewAutomationHostFocus = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  connectionId: PreviewAutomationConnectionId,
  focused: Schema.Boolean,
  liveTabs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        tabId: PreviewTabId,
        visible: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type PreviewAutomationHostFocus = typeof PreviewAutomationHostFocus.Type;

export const PreviewAutomationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
  tabIdExplicit: Schema.optional(Schema.Boolean),
  /** Supplied by the broker from authenticated scope, never from tool input. */
  agentSessionId: Schema.optional(Schema.String),
  operation: PreviewAutomationOperation,
  input: Schema.Unknown,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewAutomationRequest = typeof PreviewAutomationRequest.Type;

export const PreviewAutomationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: PreviewAutomationConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: PreviewAutomationConnectionId,
    request: PreviewAutomationRequest,
  }),
]);
export type PreviewAutomationStreamEvent = typeof PreviewAutomationStreamEvent.Type;

export const PreviewAutomationResponse = Schema.Struct({
  clientId: PreviewAutomationClientId,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      _tag: TrimmedNonEmptyString,
      message: Schema.String,
      detail: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type PreviewAutomationResponse = typeof PreviewAutomationResponse.Type;

const McpCapabilityErrorFields = {
  environmentId: EnvironmentId,
  threadId: Schema.optional(ThreadId),
  providerSessionId: Schema.optional(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
};

export class PreviewAutomationUnavailableError extends Schema.TaggedError<PreviewAutomationUnavailableError>()(
  "PreviewAutomationUnavailableError",
  {
    capability: Schema.Literal("preview"),
    ...McpCapabilityErrorFields,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability: browser preview tools are off for this thread. Do not retry them. To check a page, use a headless browser from the shell, such as Playwright, or curl. The user can turn on "Agent browser access" in Settings; it applies when the agent session next starts.`;
  }
}

export class McpCapabilityUnavailableError extends Schema.TaggedError<McpCapabilityUnavailableError>()(
  "McpCapabilityUnavailableError",
  {
    capability: TrimmedNonEmptyString,
    ...McpCapabilityErrorFields,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}

const PreviewAutomationScopeErrorFields = {
  operation: PreviewAutomationOperation,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
};

export const SERVER_BROWSER_AUTOMATION_CLIENT_ID = "server-browser";

const PreviewAutomationRequestErrorFields = {
  ...PreviewAutomationScopeErrorFields,
  clientId: TrimmedNonEmptyString,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  tabId: Schema.optional(PreviewTabId),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
};

const PreviewAutomationRemoteDiagnosticFields = {
  remoteTag: TrimmedNonEmptyString,
  remoteMessageLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.Defect(),
};

const PreviewAutomationOptionalRemoteDiagnosticFields = {
  remoteTag: Schema.optional(TrimmedNonEmptyString),
  remoteMessageLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.optional(Schema.Defect()),
};

export class PreviewAutomationNoAvailableHostError extends Schema.TaggedError<PreviewAutomationNoAvailableHostError>()(
  "PreviewAutomationNoAvailableHostError",
  {
    ...PreviewAutomationScopeErrorFields,
    clientId: Schema.optional(TrimmedNonEmptyString),
    connectionId: Schema.optional(PreviewAutomationConnectionId),
    requestId: Schema.optional(TrimmedNonEmptyString),
    tabId: Schema.optional(PreviewTabId),
    timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `No preview automation host is available for ${this.operation} in environment ${this.environmentId}. The server-owned browser may be starting or reconnecting. Retry preview_status, then call preview_open if no tab is available. If it remains unavailable, report the browser connection failure.`;
  }
}

export class PreviewAutomationUnsupportedClientError extends Schema.TaggedError<PreviewAutomationUnsupportedClientError>()(
  "PreviewAutomationUnsupportedClientError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} does not support ${this.operation}.`;
  }
}

export class PreviewAutomationTabNotFoundError extends Schema.TaggedError<PreviewAutomationTabNotFoundError>()(
  "PreviewAutomationTabNotFoundError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return this.tabId
      ? `Preview tab ${this.tabId} was not found for ${this.operation}. Omit tabId to use the current tab, or call preview_open.`
      : `No active preview tab was found for ${this.operation}. Call preview_open first.`;
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedError<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const summary = `Preview automation ${this.operation} timed out after ${this.timeoutMs}ms.`;
    return this.reason === undefined ? summary : `${summary} ${this.reason}`;
  }
}

export const PreviewAutomationControlReason = Schema.Literals([
  "agentMismatch",
  "humanControl",
  "tabRequired",
  "closed",
  "interrupted",
  "dialogPending",
  "tabLimit",
]);
export type PreviewAutomationControlReason = typeof PreviewAutomationControlReason.Type;

export class PreviewAutomationControlInterruptedError extends Schema.TaggedError<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    reason: Schema.optional(PreviewAutomationControlReason),
  },
) {
  override get message(): string {
    if (this.reason === "agentMismatch")
      return "This browser tab belongs to another agent session or a human. Open your own tab.";
    if (this.reason === "humanControl")
      return "A human controls this browser tab. Wait until they release control.";
    if (this.reason === "tabRequired")
      return "Multiple browser tabs belong to this session. Pass a tabId from preview_open or from the tabs listed by preview_status.";
    if (this.reason === "dialogPending")
      return "A browser dialog is pending. Read preview_status and resolve it with preview_dialog.";
    if (this.reason === "tabLimit")
      return "Too many server browser tabs are open. Close one with t3_preview_close, or reuse a tabId from preview_status tabs.";
    if (this.reason === "closed") return "This browser tab is closed. Call preview_open.";
    if (this.reason === "interrupted")
      return "Browser control changed. Take a fresh snapshot before trying again.";
    return `Preview automation ${this.operation} was interrupted on client ${this.clientId}.`;
  }
}

export class PreviewAutomationExecutionError extends Schema.TaggedError<PreviewAutomationExecutionError>()(
  "PreviewAutomationExecutionError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === undefined
      ? `Preview automation ${this.operation} failed on client ${this.clientId}.`
      : `Preview automation ${this.operation} failed: ${this.reason}`;
  }
}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedError<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    staleRef: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    if (this.staleRef)
      return "This element ref is stale. Navigation, dialogs, and new snapshots replace refs; take a fresh snapshot and use its refs.";
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      const guidance =
        this.selectorKind === "locator"
          ? "Use aria-ref=<ref> from the latest snapshot or a Playwright role/text selector; put CSS in selector."
          : "selector takes CSS; use locator for aria-ref=<ref>, role, or text targets.";
      return `Preview automation ${this.operation} received an invalid ${this.selectorKind} (${this.selectorLength} characters). ${guidance}`;
    }
    return `Preview automation ${this.operation} received an invalid selector.`;
  }
}

export class PreviewAutomationTargetNotEditableError extends Schema.TaggedError<PreviewAutomationTargetNotEditableError>()(
  "PreviewAutomationTargetNotEditableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  override get message(): string {
    if (this.selectorKind === "focused-element") {
      return `Preview automation ${this.operation} requires an editable focused element.`;
    }
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return `Preview automation ${this.operation} requires an editable ${this.selectorKind} (${this.selectorLength} characters).`;
    }
    return `Preview automation ${this.operation} requires an editable target.`;
  }
}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedError<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    maximumBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  },
) {
  override get message(): string {
    const summary =
      this.maximumBytes === undefined
        ? `Preview automation ${this.operation} produced a result that is too large.`
        : `Preview automation ${this.operation} produced a result larger than ${this.maximumBytes} bytes.`;
    return summary;
  }
}

export class PreviewAutomationClientDisconnectedError extends Schema.TaggedError<PreviewAutomationClientDisconnectedError>()(
  "PreviewAutomationClientDisconnectedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} disconnected during ${this.operation}.`;
  }
}

export class PreviewAutomationRequestQueueClosedError extends Schema.TaggedError<PreviewAutomationRequestQueueClosedError>()(
  "PreviewAutomationRequestQueueClosedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} stopped accepting ${this.operation} requests.`;
  }
}

export class PreviewAutomationRemoteUnavailableError extends Schema.TaggedError<PreviewAutomationRemoteUnavailableError>()(
  "PreviewAutomationRemoteUnavailableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} is unavailable on client ${this.clientId}.`;
  }
}

export class PreviewAutomationMalformedResponseError extends Schema.TaggedError<PreviewAutomationMalformedResponseError>()(
  "PreviewAutomationMalformedResponseError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} returned a malformed response for ${this.operation}.`;
  }
}

export class PreviewAutomationRecordingTransferError extends Schema.TaggedError<PreviewAutomationRecordingTransferError>()(
  "PreviewAutomationRecordingTransferError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Preview recording could not be saved to the agent environment.";
  }
}

export class PreviewAutomationRecordingDesktopUpdateRequiredError extends Schema.TaggedError<PreviewAutomationRecordingDesktopUpdateRequiredError>()(
  "PreviewAutomationRecordingDesktopUpdateRequiredError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Update the desktop app to transfer recordings. The recording remains on the desktop.";
  }
}

export class PreviewAutomationRecordingTooLargeError extends Schema.TaggedError<PreviewAutomationRecordingTooLargeError>()(
  "PreviewAutomationRecordingTooLargeError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The recording exceeds 50 MiB. Make a shorter recording.";
  }
}

export class PreviewAutomationRecordingDeadlineExpiredError extends Schema.TaggedError<PreviewAutomationRecordingDeadlineExpiredError>()(
  "PreviewAutomationRecordingDeadlineExpiredError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The recording transfer deadline expired.";
  }
}

export const PreviewAutomationError = Schema.Union([
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  PreviewAutomationUnavailableError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationUnsupportedClientError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationMalformedResponseError,
]);
export type PreviewAutomationError = typeof PreviewAutomationError.Type;

export const PreviewUrlResolution = Schema.Struct({
  requestedUrl: Schema.String,
  resolvedUrl: Schema.String,
  resolutionKind: Schema.Literals(["direct", "direct-private-network"]),
  environmentId: EnvironmentId,
});
export type PreviewUrlResolution = typeof PreviewUrlResolution.Type;
