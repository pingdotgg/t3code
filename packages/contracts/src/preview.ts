/**
 * Schemas for the desktop in-app browser preview surface.
 *
 * The server owns canonical tab metadata, while the Electron renderer owns the
 * actual webview and reports navigation state back through these contracts.
 */
import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PREVIEW_URL_MAX_LENGTH = 2048;
export const PREVIEW_TITLE_MAX_LENGTH = 2048;

const Url = TrimmedNonEmptyString.check(Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH));
const Title = Schema.String.check(Schema.isMaxLength(PREVIEW_TITLE_MAX_LENGTH));

export const PreviewTabId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewTabId = typeof PreviewTabId.Type;

export const PREVIEW_VIEWPORT_MIN_DIMENSION = 240;
export const PREVIEW_VIEWPORT_MAX_DIMENSION = 3840;
export const PREVIEW_VIEWPORT_MAX_AREA = 3840 * 2160;

const PreviewViewportDimension = Schema.Int.check(
  Schema.isBetween({
    minimum: PREVIEW_VIEWPORT_MIN_DIMENSION,
    maximum: PREVIEW_VIEWPORT_MAX_DIMENSION,
  }),
);

const viewportAreaFilter = Schema.makeFilter(
  ({ width, height }: { readonly width: number; readonly height: number }) =>
    width * height <= PREVIEW_VIEWPORT_MAX_AREA ||
    `Viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`,
);

export const PreviewViewportSize = Schema.Struct({
  width: PreviewViewportDimension,
  height: PreviewViewportDimension,
}).check(viewportAreaFilter);
export type PreviewViewportSize = typeof PreviewViewportSize.Type;

export const PreviewRenderedViewportSize = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewRenderedViewportSize = typeof PreviewRenderedViewportSize.Type;

export const PreviewViewportSetting = Schema.Union([
  Schema.TaggedStruct("fill", {}),
  Schema.TaggedStruct("freeform", {
    width: PreviewViewportDimension,
    height: PreviewViewportDimension,
  }).check(viewportAreaFilter),
]);
export type PreviewViewportSetting = typeof PreviewViewportSetting.Type;

export const FILL_PREVIEW_VIEWPORT: PreviewViewportSetting = { _tag: "fill" };

export const PreviewNavStatus = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Loading", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("Success", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("LoadFailed", {
    url: Url,
    title: Title,
    code: Schema.Int,
    description: Schema.String,
  }),
]);
export type PreviewNavStatus = typeof PreviewNavStatus.Type;

export const PreviewSessionSnapshot = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  viewport: Schema.optional(PreviewViewportSetting),
  updatedAt: Schema.String,
});
export type PreviewSessionSnapshot = typeof PreviewSessionSnapshot.Type;

export const PreviewOpenInput = Schema.Struct({
  threadId: ThreadId,
  url: Schema.optional(Url),
});
export type PreviewOpenInput = typeof PreviewOpenInput.Type;

export const PreviewNavigateInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  url: Url,
  resolvedTitle: Schema.optional(Title),
});
export type PreviewNavigateInput = typeof PreviewNavigateInput.Type;

export const PreviewReportStatusInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
});
export type PreviewReportStatusInput = typeof PreviewReportStatusInput.Type;

export const PreviewRefreshInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type PreviewRefreshInput = typeof PreviewRefreshInput.Type;

export const PreviewResizeInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  viewport: PreviewViewportSetting,
});
export type PreviewResizeInput = typeof PreviewResizeInput.Type;

export const PreviewCloseInput = Schema.Struct({
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
});
export type PreviewCloseInput = typeof PreviewCloseInput.Type;

export const PreviewListInput = Schema.Struct({
  threadId: ThreadId,
});
export type PreviewListInput = typeof PreviewListInput.Type;

export const PreviewListResult = Schema.Struct({
  sessions: Schema.Array(PreviewSessionSnapshot),
});
export type PreviewListResult = typeof PreviewListResult.Type;

export const PreviewDiscoverLocalServersInput = Schema.Struct({
  ports: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  ),
  host: Schema.optional(Schema.String),
});
export type PreviewDiscoverLocalServersInput = typeof PreviewDiscoverLocalServersInput.Type;

export const PreviewDiscoveredLocalServer = Schema.Struct({
  url: Url,
  host: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  title: Schema.optional(Title),
  status: Schema.Int,
});
export type PreviewDiscoveredLocalServer = typeof PreviewDiscoveredLocalServer.Type;

export const PreviewDiscoverLocalServersResult = Schema.Struct({
  servers: Schema.Array(PreviewDiscoveredLocalServer),
});
export type PreviewDiscoverLocalServersResult = typeof PreviewDiscoverLocalServersResult.Type;

const PreviewEventBaseSchema = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  createdAt: Schema.String,
});

const PreviewOpenedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("opened"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewNavigatedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("navigated"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewResizedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("resized"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewFailedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("failed"),
  url: Url,
  title: Title,
  code: Schema.Int,
  description: Schema.String,
});

const PreviewClosedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

export const PreviewEvent = Schema.Union([
  PreviewOpenedEvent,
  PreviewNavigatedEvent,
  PreviewResizedEvent,
  PreviewFailedEvent,
  PreviewClosedEvent,
]);
export type PreviewEvent = typeof PreviewEvent.Type;

export class PreviewSessionLookupError extends Schema.TaggedErrorClass<PreviewSessionLookupError>()(
  "PreviewSessionLookupError",
  {
    threadId: Schema.String,
    tabId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown preview session: thread=${this.threadId}, tab=${this.tabId}`;
  }
}

export class PreviewInvalidUrlError extends Schema.TaggedErrorClass<PreviewInvalidUrlError>()(
  "PreviewInvalidUrlError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol", "unexpected"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export const PreviewError = Schema.Union([PreviewSessionLookupError, PreviewInvalidUrlError]);
export type PreviewError = typeof PreviewError.Type;
