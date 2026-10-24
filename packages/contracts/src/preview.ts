import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BROWSER_PROFILE_MAX_COUNT, BrowserProfile, BrowserProfileId } from "./browserProfile.ts";

export const PREVIEW_URL_MAX_LENGTH = 2_048;
export const CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS = 32;

const Url = TrimmedNonEmptyString.check(Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH));

export const ConfiguredLocalServerUrls = Schema.Array(Url).check(
  Schema.isMaxLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS),
);
const Title = Schema.String.check(Schema.isMaxLength(512));

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

/**
 * The page's measured viewport can be smaller than the minimum selectable
 * fixed size while fill mode follows a narrow panel. Keep measurement
 * validation separate from the stricter user-selectable size constraints.
 */
export const PreviewRenderedViewportSize = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewRenderedViewportSize = typeof PreviewRenderedViewportSize.Type;

export const PREVIEW_VIEWPORT_PRESET_IDS = [
  "iphone-se",
  "iphone-xr",
  "iphone-12-pro",
  "iphone-14-pro-max",
  "pixel-7",
  "samsung-galaxy-s8-plus",
  "samsung-galaxy-s20-ultra",
  "ipad-mini",
  "ipad-air",
  "ipad-pro",
  "surface-pro-7",
  "surface-duo",
  "galaxy-z-fold-5",
  "asus-zenbook-fold",
  "samsung-galaxy-a51-71",
  "nest-hub",
  "nest-hub-max",
] as const;

export const PreviewViewportPresetId = Schema.Literals(PREVIEW_VIEWPORT_PRESET_IDS);
export type PreviewViewportPresetId = typeof PreviewViewportPresetId.Type;

const LEGACY_PREVIEW_VIEWPORT_PRESET_IDS = [
  "desktop-1920x1080",
  "desktop-1440x900",
  "laptop-1366x768",
  "laptop-1280x800",
  "ipad-pro-11",
  "iphone-15-pro",
  "pixel-8",
  "galaxy-s24",
] as const;

const StoredPreviewViewportPresetId = Schema.Literals([
  ...PREVIEW_VIEWPORT_PRESET_IDS,
  ...LEGACY_PREVIEW_VIEWPORT_PRESET_IDS,
]);

export const PreviewViewportSetting = Schema.Union([
  Schema.TaggedStruct("fill", {}),
  Schema.TaggedStruct("freeform", {
    ...PreviewViewportSize.fields,
  }).check(viewportAreaFilter),
  Schema.TaggedStruct("preset", {
    ...PreviewViewportSize.fields,
    presetId: StoredPreviewViewportPresetId,
  }).check(viewportAreaFilter),
]);
export type PreviewViewportSetting = typeof PreviewViewportSetting.Type;

export const FILL_PREVIEW_VIEWPORT = {
  _tag: "fill",
} as const satisfies PreviewViewportSetting;

/**
 * Zoom is applied by the desktop main process to the Chromium guest, but the ladder lives here so
 * the settings UI can offer exactly the steps the zoom controls step through.
 */
export const PREVIEW_ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
] as const;

export const PreviewZoomFactor = Schema.Literals(PREVIEW_ZOOM_LEVELS);
export type PreviewZoomFactor = typeof PreviewZoomFactor.Type;

export const DEFAULT_PREVIEW_ZOOM_FACTOR: PreviewZoomFactor = 1.0;

export const PreviewAppearancePreference = Schema.Literals(["system", "light", "dark"]);
export type PreviewAppearancePreference = typeof PreviewAppearancePreference.Type;

export const DEFAULT_PREVIEW_APPEARANCE: PreviewAppearancePreference = "system";

const PreviewFileDownload = Schema.Struct({ id: Schema.String, fileName: Schema.String });

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
    download: Schema.optional(PreviewFileDownload),
  }),
]);
export type PreviewNavStatus = typeof PreviewNavStatus.Type;

export const PreviewRuntime = Schema.Literals(["desktop", "server"]);
export type PreviewRuntime = typeof PreviewRuntime.Type;

/**
 * Host setup the server's browser is missing, sent as JSON in the reason when
 * the preview stream closes with code 4503. Close reasons are capped at 123
 * bytes, which this fits.
 */
export const PreviewStreamHostSetup = Schema.Struct({
  need: Schema.Literals(["sandbox", "libraries"]),
  command: Schema.String,
});
export type PreviewStreamHostSetup = typeof PreviewStreamHostSetup.Type;
export const PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE = 4503;

export const PreviewSessionSnapshot = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  viewport: Schema.optional(PreviewViewportSetting),
  colorScheme: Schema.optional(PreviewAppearancePreference),
  zoomFactor: Schema.optional(PreviewZoomFactor),
  /**
   * Browser profile the tab's Chromium partition is derived from. Fixed at
   * open: Electron only honours a `<webview>`'s partition before attach, so
   * switching would require tearing the guest down and losing page state.
   */
  profileId: Schema.optional(BrowserProfileId),
  runtime: Schema.optional(PreviewRuntime),
  automationOwner: Schema.optional(Schema.String),
  reveal: Schema.optional(Schema.Boolean),
  revealRequest: Schema.optional(Schema.Struct({ id: Schema.String, force: Schema.Boolean })),
  updatedAt: Schema.String,
});
export type PreviewSessionSnapshot = typeof PreviewSessionSnapshot.Type;

export const PreviewOpenInput = Schema.Struct({
  threadId: ThreadId,
  url: Schema.optional(Url),
  viewport: Schema.optional(PreviewViewportSetting),
  profileId: Schema.optional(BrowserProfileId),
  runtime: Schema.optional(PreviewRuntime),
  reveal: Schema.optional(Schema.Boolean),
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

/**
 * Unlike page input, these need no control of the tab.
 */
export const PreviewAdjustInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  colorScheme: Schema.optional(PreviewAppearancePreference),
  zoomFactor: Schema.optional(PreviewZoomFactor),
  hardReload: Schema.optional(Schema.Boolean),
  clear: Schema.optional(Schema.Literals(["cookies", "cache"])),
});
export type PreviewAdjustInput = typeof PreviewAdjustInput.Type;

export const PreviewCloseInput = Schema.Struct({
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
});
export type PreviewCloseInput = typeof PreviewCloseInput.Type;

export const BROWSER_RECORDING_FRAME_RATES = [30, 60] as const;
export const BrowserRecordingFrameRate = Schema.Literals(BROWSER_RECORDING_FRAME_RATES);
export type BrowserRecordingFrameRate = typeof BrowserRecordingFrameRate.Type;
export const DEFAULT_BROWSER_RECORDING_FRAME_RATE: BrowserRecordingFrameRate = 30;

export const PreviewReportProfilesInput = Schema.Struct({
  profiles: Schema.Array(BrowserProfile).check(Schema.isMaxLength(BROWSER_PROFILE_MAX_COUNT)),
  defaultProfileId: BrowserProfileId,
  /** Optional so older clients keep reporting; omitting it keeps the last reported rate. */
  recordingFrameRate: Schema.optional(BrowserRecordingFrameRate),
});
export type PreviewReportProfilesInput = typeof PreviewReportProfilesInput.Type;

export const PreviewClearProfileInput = Schema.Struct({
  profileId: BrowserProfileId,
});
export type PreviewClearProfileInput = typeof PreviewClearProfileInput.Type;

export const PreviewListInput = Schema.Struct({
  threadId: ThreadId,
});
export type PreviewListInput = typeof PreviewListInput.Type;

export const PreviewListResult = Schema.Struct({
  sessions: Schema.Array(PreviewSessionSnapshot),
  /** Identifies the current server process so revision resets are safe. */
  serverEpoch: TrimmedNonEmptyString,
  revision: NonNegativeInt,
});
export type PreviewListResult = typeof PreviewListResult.Type;

const PreviewEventBaseSchema = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  createdAt: Schema.String,
  serverEpoch: TrimmedNonEmptyString,
  /** Monotonic server state revision shared with PreviewListResult. */
  revision: PositiveInt,
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
  request: Schema.optional(
    Schema.Struct({
      hardReload: Schema.optional(Schema.Boolean),
      clear: Schema.optional(Schema.Literals(["cookies", "cache"])),
    }),
  ),
});

const PreviewFailedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("failed"),
  url: Url,
  title: Title,
  code: Schema.Int,
  description: Schema.String,
  download: Schema.optional(PreviewFileDownload),
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

export const DiscoveredLocalServer = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThan(65536)),
  url: Url,
  processName: Schema.NullOr(TrimmedNonEmptyString),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  terminal: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      terminalId: TrimmedNonEmptyString,
    }),
  ),
});
export type DiscoveredLocalServer = typeof DiscoveredLocalServer.Type;

export const DiscoveredLocalServerList = Schema.Struct({
  servers: Schema.Array(DiscoveredLocalServer),
  scannedAt: Schema.String,
  configuredUrlProbing: Schema.optional(Schema.Literal(true)),
});
export type DiscoveredLocalServerList = typeof DiscoveredLocalServerList.Type;

export class PreviewSessionLookupError extends Schema.TaggedError<PreviewSessionLookupError>()(
  "PreviewSessionLookupError",
  {
    threadId: Schema.String,
    tabId: Schema.String,
  },
) {
  override get message() {
    return `Unknown preview session: thread=${this.threadId}, tab=${this.tabId}`;
  }
}

export class PreviewInvalidUrlError extends Schema.TaggedError<PreviewInvalidUrlError>()(
  "PreviewInvalidUrlError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol", "unexpected"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export class PreviewControlRequiredError extends Schema.TaggedError<PreviewControlRequiredError>()(
  "PreviewControlRequiredError",
  { tabId: Schema.String },
) {
  override get message() {
    return "Take control of the server browser and use its viewer controls.";
  }
}

export class PreviewClearProfileError extends Schema.TaggedError<PreviewClearProfileError>()(
  "PreviewClearProfileError",
  { profileId: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "The environment could not delete this browser profile's data.";
  }
}

export const PreviewError = Schema.Union([
  PreviewSessionLookupError,
  PreviewInvalidUrlError,
  PreviewControlRequiredError,
]);
export type PreviewError = typeof PreviewError.Type;
