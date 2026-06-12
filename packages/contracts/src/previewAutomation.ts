import { Schema } from "effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";

const BoundedUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));
const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(60_000)),
);

export const PreviewAutomationOperation = Schema.Literals([
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
]);
export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;

export const PreviewAutomationStatus = Schema.Struct({
  available: Schema.Boolean,
  visible: Schema.Boolean,
  tabId: Schema.NullOr(PreviewTabId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatus.Type;

export const PreviewAutomationOpenInput = Schema.Struct({
  url: Schema.optional(BoundedUrl),
  show: Schema.optional(Schema.Boolean),
  reuseExistingTab: Schema.optional(Schema.Boolean),
});
export type PreviewAutomationOpenInput = typeof PreviewAutomationOpenInput.Type;

export const PreviewAutomationNavigateInput = Schema.Struct({
  url: BoundedUrl,
  readiness: Schema.optional(Schema.Literals(["load", "domContentLoaded", "none"])),
  timeoutMs: OptionalTimeoutMs,
});
export type PreviewAutomationNavigateInput = typeof PreviewAutomationNavigateInput.Type;

export const PreviewAutomationClickInput = Schema.Union([
  Schema.Struct({
    selector: TrimmedNonEmptyString,
    timeoutMs: OptionalTimeoutMs,
  }),
  Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    timeoutMs: OptionalTimeoutMs,
  }),
]);
export type PreviewAutomationClickInput = typeof PreviewAutomationClickInput.Type;

export const PreviewAutomationTypeInput = Schema.Struct({
  text: Schema.String,
  selector: Schema.optional(TrimmedNonEmptyString),
  clear: Schema.optional(Schema.Boolean),
  timeoutMs: OptionalTimeoutMs,
});
export type PreviewAutomationTypeInput = typeof PreviewAutomationTypeInput.Type;

export const PreviewAutomationPressInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  modifiers: Schema.optional(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
});
export type PreviewAutomationPressInput = typeof PreviewAutomationPressInput.Type;

export const PreviewAutomationScrollInput = Schema.Struct({
  deltaX: Schema.optional(Schema.Number),
  deltaY: Schema.optional(Schema.Number),
  selector: Schema.optional(TrimmedNonEmptyString),
});
export type PreviewAutomationScrollInput = typeof PreviewAutomationScrollInput.Type;

export const PreviewAutomationEvaluateInput = Schema.Struct({
  expression: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  awaitPromise: Schema.optional(Schema.Boolean),
  returnByValue: Schema.optional(Schema.Boolean),
});
export type PreviewAutomationEvaluateInput = typeof PreviewAutomationEvaluateInput.Type;

export const PreviewAutomationWaitForInput = Schema.Struct({
  selector: Schema.optional(TrimmedNonEmptyString),
  text: Schema.optional(TrimmedNonEmptyString),
  urlIncludes: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: OptionalTimeoutMs,
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

export const PreviewAutomationSnapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  visibleText: Schema.String,
  interactiveElements: Schema.Array(PreviewAutomationElement),
  accessibilityTree: Schema.Unknown,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type PreviewAutomationSnapshot = typeof PreviewAutomationSnapshot.Type;

export const PreviewAutomationOwner = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  tabId: Schema.NullOr(PreviewTabId),
  visible: Schema.Boolean,
  supportsAutomation: Schema.Boolean,
  focusedAt: Schema.String,
});
export type PreviewAutomationOwner = typeof PreviewAutomationOwner.Type;

export const PreviewAutomationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
  operation: PreviewAutomationOperation,
  input: Schema.Unknown,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewAutomationRequest = typeof PreviewAutomationRequest.Type;

export const PreviewAutomationResponse = Schema.Struct({
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
  { message: Schema.String },
) {}

export class PreviewAutomationNoFocusedOwnerError extends Schema.TaggedErrorClass<PreviewAutomationNoFocusedOwnerError>()(
  "PreviewAutomationNoFocusedOwnerError",
  { message: Schema.String },
) {}

export class PreviewAutomationUnsupportedClientError extends Schema.TaggedErrorClass<PreviewAutomationUnsupportedClientError>()(
  "PreviewAutomationUnsupportedClientError",
  { message: Schema.String },
) {}

export class PreviewAutomationTabNotFoundError extends Schema.TaggedErrorClass<PreviewAutomationTabNotFoundError>()(
  "PreviewAutomationTabNotFoundError",
  { message: Schema.String },
) {}

export class PreviewAutomationTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  { message: Schema.String },
) {}

export class PreviewAutomationExecutionError extends Schema.TaggedErrorClass<PreviewAutomationExecutionError>()(
  "PreviewAutomationExecutionError",
  { message: Schema.String, detail: Schema.optional(Schema.Unknown) },
) {}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedErrorClass<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  { message: Schema.String, selector: Schema.String },
) {}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedErrorClass<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  { message: Schema.String, maximumBytes: Schema.Int },
) {}

export const PreviewAutomationError = Schema.Union([
  PreviewAutomationUnavailableError,
  PreviewAutomationNoFocusedOwnerError,
  PreviewAutomationUnsupportedClientError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
]);
export type PreviewAutomationError = typeof PreviewAutomationError.Type;

export const PreviewUrlResolution = Schema.Struct({
  requestedUrl: Schema.String,
  resolvedUrl: Schema.String,
  resolutionKind: Schema.Literal("direct"),
  environmentId: EnvironmentId,
});
export type PreviewUrlResolution = typeof PreviewUrlResolution.Type;
