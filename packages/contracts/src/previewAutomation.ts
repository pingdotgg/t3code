import { Schema } from "effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PREVIEW_VIEWPORT_MAX_AREA,
  PreviewRenderedViewportSize,
  PreviewTabId,
  PreviewViewportPresetId,
  PreviewViewportSetting,
  PreviewViewportSize,
} from "./preview.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const BoundedUrl = Schema.String.check(Schema.isTrimmed())
  .check(
    Schema.isNonEmpty({
      description:
        "Absolute http(s) URL or a schemeless host such as t3.chat or localhost:5173. Schemeless public hosts use https; loopback hosts use http.",
    }),
  )
  .check(Schema.isMaxLength(2048));
const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0))
    .check(Schema.isLessThanOrEqualTo(60_000))
    .annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." }),
).annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." });

/** Operations understood by desktop hosts predating viewport resizing. */
export const PREVIEW_AUTOMATION_V1_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
] as const;

/** Advertised by current desktop hosts for mixed-version routing. */
export const PREVIEW_AUTOMATION_OPERATIONS = [
  ...PREVIEW_AUTOMATION_V1_OPERATIONS,
  "resize",
] as const;

export const PreviewAutomationOperation = Schema.Literals(PREVIEW_AUTOMATION_OPERATIONS);
export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;

export const PreviewAutomationStatus = Schema.Struct({
  available: Schema.Boolean,
  visible: Schema.Boolean,
  tabId: Schema.NullOr(PreviewTabId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  /** Optional for compatibility with desktop hosts predating viewport sizing. */
  viewportSetting: Schema.optional(PreviewViewportSetting),
  /** Measured guest-page viewport in CSS pixels when a webview is ready. */
  viewport: Schema.optional(PreviewRenderedViewportSize),
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatus.Type;

export const PreviewAutomationOpenInput = Schema.Struct({
  url: Schema.optional(BoundedUrl).annotate({
    description:
      "Optional initial page URL, for example https://t3.chat or localhost:5173. Omit to open a blank tab.",
  }),
  show: Schema.optional(
    Schema.Boolean.annotate({
      description: "Whether to reveal the preview panel to the human. Defaults to true.",
    }),
  ),
  reuseExistingTab: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Reuse the thread's active browser tab when available. Defaults to true; set false to create a new tab.",
    }),
  ),
}).annotate({
  description:
    "Opens the collaborative browser for the current thread. Use preview_navigate afterward when readiness waiting matters.",
});
export type PreviewAutomationOpenInput = typeof PreviewAutomationOpenInput.Type;

export const BrowserNavigationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("url").annotate({
      description: "Selects direct URL navigation.",
    }),
    url: BoundedUrl.annotate({
      description: "Direct website URL.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("environment-port").annotate({
      description: "Selects a dev-server port relative to the current execution environment.",
    }),
    port: Schema.Int.check(Schema.isGreaterThan(0))
      .check(Schema.isLessThan(65_536))
      .annotate({ description: "Dev-server TCP port inside the current environment." }),
    protocol: Schema.optional(
      Schema.Literals(["http", "https"]).annotate({
        description: "Dev-server protocol. Defaults to http.",
      }),
    ),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Optional path, query, and fragment, for example /settings?tab=account.",
      }),
    ),
  }),
]);
export type BrowserNavigationTarget = typeof BrowserNavigationTarget.Type;

export const PreviewAutomationNavigateInput = Schema.Struct({
  url: Schema.optional(BoundedUrl).annotate({
    description:
      "Website URL, for example https://t3.chat. Use this for public pages and directly reachable URLs.",
  }),
  target: Schema.optional(
    BrowserNavigationTarget.annotate({
      description:
        "Environment-relative target. Prefer {kind:'environment-port',port:5173} for a dev server in the current environment.",
    }),
  ).annotate({
    description:
      "Environment-relative target. Prefer {kind:'environment-port',port:5173} for a dev server in the current environment.",
  }),
  readiness: Schema.optional(
    Schema.Literals(["load", "domContentLoaded", "none"]).annotate({
      description:
        "Readiness milestone before returning. 'load' waits for loading to stop (default), 'domContentLoaded' waits for an interactive document, and 'none' returns immediately.",
    }),
  ).annotate({
    description:
      "Readiness milestone before returning. 'load' is the default; use 'none' only when a later wait call will verify the page.",
  }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter(
      (input) =>
        Number(input.url !== undefined) + Number(input.target !== undefined) === 1 ||
        "Provide exactly one of url or target.",
    ),
  )
  .annotate({
    description:
      "Navigates the active browser tab. Provide exactly one of url or target; for most public pages use url.",
  });
export type PreviewAutomationNavigateInput = typeof PreviewAutomationNavigateInput.Type;

export const PreviewAutomationResizeInput = Schema.Struct({
  mode: Schema.Literals(["fill", "freeform", "preset"]).annotate({
    description:
      "Viewport mode: fill follows the preview panel, freeform uses exact independently resizable dimensions, and preset uses a named device size.",
  }),
  preset: Schema.optional(
    PreviewViewportPresetId.annotate({
      description: "Named viewport from Chrome DevTools' standard device catalog.",
    }),
  ).annotate({
    description: "Named device size. Required only when mode is preset.",
  }),
  width: Schema.optional(
    PreviewViewportSize.fields.width.annotate({
      description: "Freeform viewport width in CSS pixels. Required only in freeform mode.",
    }),
  ).annotate({
    description: "Freeform viewport width in CSS pixels. Required only in freeform mode.",
  }),
  height: Schema.optional(
    PreviewViewportSize.fields.height.annotate({
      description: "Freeform viewport height in CSS pixels. Required only in freeform mode.",
    }),
  ).annotate({
    description: "Freeform viewport height in CSS pixels. Required only in freeform mode.",
  }),
  orientation: Schema.optional(
    Schema.Literals(["portrait", "landscape"]).annotate({
      description:
        "Orientation for a fixed device preset. Defaults to the preset's native orientation.",
    }),
  ).annotate({
    description:
      "Orientation for a named device preset. It is not accepted in fill or freeform mode.",
  }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      const hasPreset = input.preset !== undefined;
      const hasWidth = input.width !== undefined;
      const hasHeight = input.height !== undefined;
      if (hasWidth !== hasHeight) return "Custom dimensions require both width and height.";
      if (input.mode === "fill") {
        return !hasPreset && !hasWidth && input.orientation === undefined
          ? true
          : "Fill mode does not accept a preset, dimensions, or orientation.";
      }
      if (input.mode === "freeform") {
        if (!hasWidth || !hasHeight || hasPreset || input.orientation !== undefined) {
          return "Freeform mode requires width and height and does not accept a preset or orientation.";
        }
      } else if (!hasPreset || hasWidth || hasHeight) {
        return "Preset mode requires a preset and does not accept custom dimensions.";
      }
      if (hasWidth && hasHeight && input.width! * input.height! > PREVIEW_VIEWPORT_MAX_AREA) {
        return `Custom viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`;
      }
      return true;
    }),
  )
  .annotate({
    description:
      "Sets the active browser tab to fill-panel, independently resizable freeform, or named device-preset sizing.",
  });
export type PreviewAutomationResizeInput = typeof PreviewAutomationResizeInput.Type;

export const PreviewAutomationResizeResult = Schema.Struct({
  tabId: PreviewTabId,
  setting: PreviewViewportSetting,
  viewport: PreviewRenderedViewportSize,
});
export type PreviewAutomationResizeResult = typeof PreviewAutomationResizeResult.Type;

const Locator = TrimmedNonEmptyString.annotate({
  description:
    "Playwright selector, preferably role/text based, for example role=button[name='Send'] or text=Continue. Use snapshot first to inspect the page.",
});

const LegacySelector = TrimmedNonEmptyString.annotate({
  description:
    "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting.",
});

export const PreviewAutomationClickInput = Schema.Struct({
  selector: Schema.optional(LegacySelector).annotate({
    description:
      "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector, preferably role/text based, for example role=button[name='Send'] or text=Continue. Use snapshot first to inspect the page.",
  }),
  x: Schema.optional(
    Schema.Finite.annotate({
      description: "Viewport-relative X coordinate in CSS pixels. Must be paired with y.",
    }),
  ),
  y: Schema.optional(
    Schema.Finite.annotate({
      description: "Viewport-relative Y coordinate in CSS pixels. Must be paired with x.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter((input) => {
      const selectorModes =
        Number(input.selector !== undefined) + Number(input.locator !== undefined);
      const hasX = input.x !== undefined;
      const hasY = input.y !== undefined;
      if (hasX !== hasY) return "Coordinates require both x and y.";
      const coordinateModes = hasX && hasY ? 1 : 0;
      return selectorModes + coordinateModes === 1 || "Provide exactly one click target.";
    }),
  )
  .annotate({
    description:
      "Clicks one target. Provide exactly one of locator, selector, or the x/y coordinate pair.",
  });
export type PreviewAutomationClickInput = typeof PreviewAutomationClickInput.Type;

export const PreviewAutomationTypeInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Literal text to insert." }),
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector for the input. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector for the input, for example role=textbox[name='Message'] or textarea[placeholder*='Message'].",
  }),
  clear: Schema.optional(
    Schema.Boolean.annotate({
      description: "Clear the existing input value before inserting text. Defaults to false.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.selector !== undefined && input.locator !== undefined) ||
        "Provide at most one of selector or locator.",
    ),
  )
  .annotate({
    description:
      "Types into locator/selector, or into the currently focused element when neither target is provided.",
  });
export type PreviewAutomationTypeInput = typeof PreviewAutomationTypeInput.Type;

export const PreviewAutomationPressInput = Schema.Struct({
  key: Schema.String.check(Schema.isTrimmed())
    .check(
      Schema.isNonEmpty({
        description:
          "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
      }),
    )
    .annotateKey({
      description:
        "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
    }),
  modifiers: Schema.optional(
    Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"])).annotate({
      description: "Modifier keys held while pressing key.",
    }),
  ),
}).annotate({ description: "Presses one keyboard key in the active browser tab." });
export type PreviewAutomationPressInput = typeof PreviewAutomationPressInput.Type;

export const PreviewAutomationScrollInput = Schema.Struct({
  deltaX: Schema.optional(
    Schema.Finite.annotate({
      description: "Horizontal scroll delta in CSS pixels. Positive scrolls right. Defaults to 0.",
    }),
  ),
  deltaY: Schema.optional(
    Schema.Finite.annotate({
      description: "Vertical scroll delta in CSS pixels. Positive scrolls down. Defaults to 0.",
    }),
  ),
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector for a scrollable container. Omit to scroll the viewport.",
  }),
  locator: Schema.optional(Locator).annotate({
    description: "Playwright selector for a scrollable container. Omit to scroll the viewport.",
  }),
})
  .check(
    Schema.makeFilter((input) => {
      if (input.selector !== undefined && input.locator !== undefined) {
        return "Provide at most one of selector or locator.";
      }
      return (
        input.deltaX !== undefined || input.deltaY !== undefined || "Provide deltaX or deltaY."
      );
    }),
  )
  .annotate({
    description:
      "Scrolls the viewport, or a locator/selector container. Provide deltaX, deltaY, or both.",
  });
export type PreviewAutomationScrollInput = typeof PreviewAutomationScrollInput.Type;

export const PreviewAutomationEvaluateInput = Schema.Struct({
  expression: Schema.String.check(Schema.isTrimmed())
    .check(
      Schema.isNonEmpty({
        description:
          "JavaScript expression evaluated in the page's main frame, for example document.title or (() => ({href: location.href}))().",
      }),
    )
    .check(Schema.isMaxLength(64_000))
    .annotateKey({
      description:
        "JavaScript expression evaluated in the page's main frame, for example document.title or (() => ({href: location.href}))().",
    }),
  awaitPromise: Schema.optional(
    Schema.Boolean.annotate({ description: "Await a returned Promise. Defaults to true." }),
  ),
  returnByValue: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Serialize and return the value instead of a remote object reference. Defaults to true.",
    }),
  ),
}).annotate({
  description:
    "Evaluates JavaScript in the page. Prefer snapshot and semantic actions; use evaluate for inspection or unsupported interactions.",
});
export type PreviewAutomationEvaluateInput = typeof PreviewAutomationEvaluateInput.Type;

export const PreviewAutomationWaitForInput = Schema.Struct({
  selector: Schema.optional(LegacySelector).annotate({
    description: "Legacy CSS selector that must match an element. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotate({
    description:
      "Playwright selector that must match an element, for example role=button[name='Send'].",
  }),
  text: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Case-sensitive substring that must appear in visible document text.",
    }),
  ).annotate({
    description: "Case-sensitive substring that must appear in visible document text.",
  }),
  urlIncludes: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Substring that must appear in the current absolute URL.",
    }),
  ).annotate({ description: "Substring that must appear in the current absolute URL." }),
  timeoutMs: OptionalTimeoutMs,
})
  .check(
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
  )
  .annotate({
    description:
      "Waits until all provided conditions match. Use after click/type when the page changes asynchronously.",
  });
export type PreviewAutomationWaitForInput = typeof PreviewAutomationWaitForInput.Type;

export const PreviewAutomationElement = Schema.Struct({
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  selector: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type PreviewAutomationElement = typeof PreviewAutomationElement.Type;

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

export const PreviewAutomationRecordingArtifact = Schema.Struct({
  id: Schema.String,
  tabId: PreviewTabId,
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.String,
});
export type PreviewAutomationRecordingArtifact = typeof PreviewAutomationRecordingArtifact.Type;

export const PreviewAutomationClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewAutomationClientId = typeof PreviewAutomationClientId.Type;
export const PreviewAutomationConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type PreviewAutomationConnectionId = typeof PreviewAutomationConnectionId.Type;

export const PreviewAutomationHostIdentity = Schema.Struct({
  clientId: PreviewAutomationClientId,
  environmentId: EnvironmentId,
});
export type PreviewAutomationHostIdentity = typeof PreviewAutomationHostIdentity.Type;

export const PreviewAutomationHost = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  /**
   * Missing means the pre-capability-negotiation V1 operation set. This lets
   * a newer server safely coexist with an older desktop during rollout.
   */
  supportedOperations: Schema.optional(Schema.Array(PreviewAutomationOperation)),
});
export type PreviewAutomationHost = typeof PreviewAutomationHost.Type;

export const PreviewAutomationHostFocus = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  connectionId: PreviewAutomationConnectionId,
  focused: Schema.Boolean,
});
export type PreviewAutomationHostFocus = typeof PreviewAutomationHostFocus.Type;

export const PreviewAutomationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
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

export class PreviewAutomationUnavailableError extends Schema.TaggedErrorClass<PreviewAutomationUnavailableError>()(
  "PreviewAutomationUnavailableError",
  {
    capability: Schema.Literal("preview"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    providerSessionId: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
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

export class PreviewAutomationNoAvailableHostError extends Schema.TaggedErrorClass<PreviewAutomationNoAvailableHostError>()(
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
    const summary = `No preview automation host is available for ${this.operation} in environment ${this.environmentId}.`;
    return summary;
  }
}

export class PreviewAutomationUnsupportedClientError extends Schema.TaggedErrorClass<PreviewAutomationUnsupportedClientError>()(
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

export class PreviewAutomationTabNotFoundError extends Schema.TaggedErrorClass<PreviewAutomationTabNotFoundError>()(
  "PreviewAutomationTabNotFoundError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    const summary = this.tabId
      ? `Preview tab ${this.tabId} was not found for ${this.operation}.`
      : `No active preview tab was found for ${this.operation}.`;
    return summary;
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    const summary = `Preview automation ${this.operation} timed out after ${this.timeoutMs}ms.`;
    return summary;
  }
}

export class PreviewAutomationControlInterruptedError extends Schema.TaggedErrorClass<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} was interrupted on client ${this.clientId}.`;
  }
}

export class PreviewAutomationExecutionError extends Schema.TaggedErrorClass<PreviewAutomationExecutionError>()(
  "PreviewAutomationExecutionError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} failed on client ${this.clientId}.`;
  }
}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedErrorClass<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  override get message(): string {
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return `Preview automation ${this.operation} received an invalid ${this.selectorKind} (${this.selectorLength} characters).`;
    }
    return `Preview automation ${this.operation} received an invalid selector.`;
  }
}

export class PreviewAutomationTargetNotEditableError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotEditableError>()(
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

export class PreviewAutomationResultTooLargeError extends Schema.TaggedErrorClass<PreviewAutomationResultTooLargeError>()(
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

export class PreviewAutomationClientDisconnectedError extends Schema.TaggedErrorClass<PreviewAutomationClientDisconnectedError>()(
  "PreviewAutomationClientDisconnectedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} disconnected during ${this.operation}.`;
  }
}

export class PreviewAutomationRequestQueueClosedError extends Schema.TaggedErrorClass<PreviewAutomationRequestQueueClosedError>()(
  "PreviewAutomationRequestQueueClosedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} stopped accepting ${this.operation} requests.`;
  }
}

export class PreviewAutomationRemoteUnavailableError extends Schema.TaggedErrorClass<PreviewAutomationRemoteUnavailableError>()(
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

export class PreviewAutomationMalformedResponseError extends Schema.TaggedErrorClass<PreviewAutomationMalformedResponseError>()(
  "PreviewAutomationMalformedResponseError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} returned a malformed response for ${this.operation}.`;
  }
}

export const PreviewAutomationError = Schema.Union([
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
