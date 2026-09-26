/**
 * Desktop side of the in-app browser preview.
 *
 * Hosts per-tab Chromium WebContents references (the actual <webview>
 * elements live in the renderer; we only attach listeners and forward state
 * here). Single layer-scoped browser session partition.
 */
import { DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER } from "@t3tools/contracts";
import type {
  DesktopPreviewTabDefaults,
  DesktopPreviewAnnotationTheme,
  DesktopPreviewAutomationStatus,
  DesktopPreviewColorScheme,
  DesktopPreviewPointerEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewScreenshotArtifact,
  PreviewAutomationClickInput,
  PreviewAutomationActionEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationNetworkEntry,
  PreviewAutomationScreenshotCaptureFailure,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import {
  applySnapshotBudgets,
  candidateLocatorsFromElements,
  resolveSnapshotBudgets,
} from "@t3tools/shared/previewAutomationBudgets";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import {
  BrowserWindow,
  type BrowserWindow as BrowserWindowType,
  type Session,
  type WebContents,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewEnvironment from "./PreviewEnvironment.ts";
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
import { isPreviewAnnotationPayload } from "./PickedElementPayload.ts";
import { playwrightInjectedRuntimeInstallExpression } from "./PlaywrightInjectedRuntime.ts";
import { makePreviewAutomationKeySequence } from "./PreviewKeyboard.ts";
import { DEFAULT_ZOOM_FACTOR, nextZoomLevel, ZOOM_EPSILON } from "../zoomLevels.ts";

export type PreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

export interface PreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  controller: "human" | "agent" | "none";
  updatedAt: string;
}

const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const RECORDING_ARM_GRACE_MS = 10_000;
const PICTURE_IN_PICTURE_FRAME_INTERVAL_MS = Math.ceil(1_000 / 12);
const RECORDING_JPEG_QUALITY = 80;
const RECORDING_MAX_FRAME_WIDTH = 1600;
const RECORDING_MAX_FRAME_HEIGHT = 1200;
/**
 * Cold guests can reject capturePage with UnknownVizError or never settle it.
 * Bound each attempt so snapshots release control even when Chromium stalls.
 */
const CAPTURE_PAGE_RETRY_ATTEMPTS = 3;
const CAPTURE_PAGE_RETRY_DELAY_MS = 120;
const CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS = 1_000;
const SCREENSHOT_CAPTURE_FAILURE = {
  _tag: "PreviewScreenshotCaptureFailed",
  operation: "Page.captureScreenshot",
} satisfies PreviewAutomationScreenshotCaptureFailure;
const PICTURE_IN_PICTURE_INITIAL_WIDTH = 480;
const PICTURE_IN_PICTURE_INITIAL_HEIGHT = 320;
const PICTURE_IN_PICTURE_MIN_WIDTH = 240;
const PICTURE_IN_PICTURE_MIN_HEIGHT = 160;
const PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON = 0.01;
const DIAGNOSTIC_BUFFER_LIMIT = 200;
const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80;
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;
const requestRecordingCaptureExpression = (tabId: string): string =>
  `globalThis[${JSON.stringify(DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER)}]?.(${JSON.stringify(tabId)}) === true`;
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

interface PreviewZoomScope {
  readonly origin: string;
  readonly session: Session;
}

const previewZoomScope = (wc: WebContents): PreviewZoomScope | null => {
  if (wc.isDestroyed()) return null;
  try {
    const origin = new URL(wc.getURL()).origin;
    return origin === "null" ? null : { origin, session: wc.session };
  } catch {
    return null;
  }
};

const samePreviewZoomScope = (left: PreviewZoomScope, right: PreviewZoomScope): boolean =>
  left.session === right.session && left.origin === right.origin;

const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: "light",
  radius: "0.625rem",
  background: "white",
  foreground: "oklch(0.269 0 0)",
  popover: "white",
  popoverForeground: "oklch(0.269 0 0)",
  primary: "oklch(0.488 0.217 264)",
  primaryForeground: "white",
  muted: "rgb(0 0 0 / 4%)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "rgb(0 0 0 / 4%)",
  accentForeground: "oklch(0.269 0 0)",
  border: "rgb(0 0 0 / 8%)",
  input: "rgb(0 0 0 / 10%)",
  ring: "oklch(0.488 0.217 264)",
  fontSans: "system-ui, sans-serif",
  fontMono: "ui-monospace, monospace",
};

export const buildPreviewPictureInPictureDataUrl = (): string => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#111}img{width:100%;height:100%;object-fit:contain}</style></head><body><img id="frame" alt="Live browser preview"><script>window.previewPictureInPicture.onFrame((next)=>{document.getElementById("frame").src="data:image/jpeg;base64,"+next.data})</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

export const fitPictureInPictureContentSize = (
  current: ReadonlyArray<number>,
  aspectRatio: number,
): readonly [width: number, height: number] => {
  const currentWidth = Math.max(1, current[0] ?? PICTURE_IN_PICTURE_INITIAL_WIDTH);
  const currentHeight = Math.max(1, current[1] ?? PICTURE_IN_PICTURE_INITIAL_HEIGHT);
  const currentArea = currentWidth * currentHeight;
  let width = Math.sqrt(currentArea * aspectRatio);
  let height = width / aspectRatio;
  const minimumScale = Math.max(
    1,
    PICTURE_IN_PICTURE_MIN_WIDTH / width,
    PICTURE_IN_PICTURE_MIN_HEIGHT / height,
  );
  width *= minimumScale;
  height *= minimumScale;
  return [Math.round(width), Math.round(height)];
};

export const recordingFileExtension = (mimeType: string): string => {
  const subtype = mimeType.split(";", 1)[0]?.trim().toLowerCase().split("/")[1] ?? "";
  const extension = subtype.replace(/^x-/, "").replace(/[^a-z0-9]/g, "");
  return extension || "video";
};

const artifactSiteSlug = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_ARTIFACT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

interface CdpEvaluationResult {
  readonly result?: {
    readonly value?: unknown;
    readonly description?: string;
  };
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

export const PreviewAutomationSelectorKind = Schema.Literals([
  "focused-element",
  "selector",
  "locator",
]);
export type PreviewAutomationSelectorKind = typeof PreviewAutomationSelectorKind.Type;

export const PreviewAutomationEvaluationDetailKind = Schema.Literals([
  "exception-description",
  "exception-text",
  "unknown",
]);
export type PreviewAutomationEvaluationDetailKind =
  typeof PreviewAutomationEvaluationDetailKind.Type;

const previewAutomationEvaluationDetail = (exceptionDetails: unknown) => {
  if (typeof exceptionDetails !== "object" || exceptionDetails === null) {
    return { detailKind: "unknown" as const };
  }
  const details = exceptionDetails as Record<string, unknown>;
  const exception = details["exception"];
  const description =
    typeof exception === "object" &&
    exception !== null &&
    typeof (exception as Record<string, unknown>)["description"] === "string"
      ? (exception as Record<string, unknown>)["description"]
      : undefined;
  if (typeof description === "string" && description.length > 0) {
    return { detailKind: "exception-description" as const, detail: description };
  }
  const text = details["text"];
  if (typeof text === "string" && text.length > 0) {
    return { detailKind: "exception-text" as const, detail: text };
  }
  return { detailKind: "unknown" as const };
};

const previewAutomationTargetLabel = (
  selectorKind: PreviewAutomationSelectorKind,
  selectorLength?: number,
) =>
  selectorKind === "focused-element"
    ? "the focused element"
    : `${selectorKind} (${selectorLength ?? 0} characters)`;

interface PreviewOperationContext {
  readonly operation: string;
  readonly tabId?: string;
  readonly webContentsId?: number;
  readonly artifactPath?: string;
}

const normalizeCaptureRect = (value: unknown): PreviewAnnotationRect | null => {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  const x = rect["x"];
  const y = rect["y"];
  const width = rect["width"];
  const height = rect["height"];
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
};

const captureAnnotationScreenshot = (
  tabId: string,
  wc: Electron.WebContents,
  cropRect: PreviewAnnotationRect | null,
  capture: Effect.Effect<Electron.NativeImage, PreviewManagerError>,
): Effect.Effect<PreviewAnnotationPayload["screenshot"], PreviewManagerError> =>
  capture.pipe(
    Effect.map((image): PreviewAnnotationPayload["screenshot"] => {
      const size = image.getSize();
      return {
        dataUrl: image.toDataURL(),
        width: size.width,
        height: size.height,
        cropRect: cropRect ?? { x: 0, y: 0, width: size.width, height: size.height },
      };
    }),
  );

type Listener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>;
type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => Effect.Effect<void>;

type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

interface ManagedListeners {
  readonly scope: Scope.Closeable;
  readonly webContents: Electron.WebContents;
}

interface PickSession {
  readonly cancel: Effect.Effect<void>;
}

interface PendingRecording {
  readonly tabId: string;
  readonly webContents: Electron.WebContents;
  readonly requestingFrameTreeNodeId: number;
  readonly armedAtMillis: number;
}

interface BrowserControlSession {
  readonly webContentsId: number;
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
  readonly semaphore: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => void;
}

interface BrowserDiagnostics {
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly requests: ReadonlyMap<string, { url: string; method: string }>;
}

type PointerEventListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>;

interface ExpectedAgentInput {
  readonly signal: PreviewInputSignal;
  readonly expiresAt: number;
}

type FrameCaptureConsumer = "recording" | "picture-in-picture";

interface FrameCaptureSession {
  readonly scope: Scope.Closeable | null;
  readonly consumers: ReadonlySet<FrameCaptureConsumer>;
  readonly unthrottledWebContentsIds: ReadonlySet<number>;
}

interface PictureInPictureSession {
  readonly window: BrowserWindowType;
  readonly webContentsId: number;
  readonly ready: Deferred.Deferred<void, PreviewManagerError>;
  readonly initializationScope: Scope.Closeable;
  /** Mutable last applied ratio; lives on the session so release cannot race a shared map reinsert. */
  aspectRatio: number | undefined;
}
/**
 * Protocols a preview page may open in a real popup window.
 *
 * `about:blank` stays out: Chromium skips browser-side navigation for it, so the
 * child copies the guest's `contextIsolation: false` preferences and Electron
 * gives no way to override them. Reject those popups without replacing the opener.
 *
 * Deliberately not `ElectronShell.parseSafeExternalUrl`: that also admits
 * `vscode://vscode-remote/...` deep links, which belong in `shell.openExternal`
 * and not in a window spawned by a third-party page in the preview.
 */
const POPUP_PROTOCOLS = new Set(["http:", "https:"]);

const isPopupUrl = (rawUrl: string): boolean => {
  try {
    return POPUP_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
};

/**
 * Preferences for a popup a preview page opens.
 *
 * A popup is not a webview attach, so the `will-attach-webview` hardening in
 * `DesktopWindow` never sees it, and an unoverridden child would inherit the
 * guest's relaxed posture: the picker preload needs `contextIsolation: false`
 * to share `globalThis` with the previewed page, and no OAuth provider should
 * get that. The window keeps the opener and the guest session either way.
 */
const POPUP_WINDOW_OPTIONS = {
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
} satisfies Electron.BrowserWindowConstructorOptions;

/**
 * Decides what a preview page's `window.open` should do.
 *
 * `"popup"` opens a real window, which scripted popups need: denying them makes
 * `window.open()` return `null` (OAuth SDKs report that as a blocked popup), and
 * navigating the preview tab instead destroys the opener the popup has to
 * `postMessage` its result back to.
 *
 * `target="_blank"` links arrive as a tab disposition and keep loading in the
 * preview tab, which is what people expect from a link inside a preview.
 */
export const previewWindowOpenAction = (details: {
  readonly url: string;
  readonly disposition: Electron.HandlerDetails["disposition"];
}): "popup" | "navigate" | "deny" =>
  !isPopupUrl(details.url) ? "deny" : details.disposition === "new-window" ? "popup" : "navigate";

export const previewZoomShortcut = (input: Electron.Input): "in" | "out" | "reset" | null => {
  if (input.type !== "keyDown" || !(input.meta || input.control) || input.alt) return null;
  if (input.key === "+" || input.key === "=") return "in";
  if (input.key === "-") return "out";
  if (input.key === "0" && !input.shift) return "reset";
  return null;
};

export const isPreviewRefreshShortcut = (input: Electron.Input): boolean =>
  input.type === "keyDown" &&
  input.key.toLowerCase() === "r" &&
  (input.meta || input.control) &&
  !input.shift &&
  !input.alt;

const isPreviewInputSignal = (value: unknown): value is PreviewInputSignal => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "pointer") {
    return (
      "x" in value &&
      typeof value.x === "number" &&
      "y" in value &&
      typeof value.y === "number" &&
      "button" in value &&
      typeof value.button === "number"
    );
  }
  return (
    value.kind === "key" &&
    "key" in value &&
    typeof value.key === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
};

const inputSignalsMatch = (left: PreviewInputSignal, right: PreviewInputSignal): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pointer" && right.kind === "pointer") {
    return (
      Math.abs(left.x - right.x) <= 1 &&
      Math.abs(left.y - right.y) <= 1 &&
      left.button === right.button
    );
  }
  return (
    left.kind === "key" &&
    right.kind === "key" &&
    left.key === right.key &&
    left.code === right.code
  );
};

const makeNativeOperations = Effect.fn("PreviewManager.makeOperations")(function* (
  artifactDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const path = yield* Path.Path;
  const parentScope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const resolvedArtifactDirectory = path.resolve(artifactDirectory);
  const playwrightInstallExpression = yield* Effect.cached(
    playwrightInjectedRuntimeInstallExpression(),
  );

  const annotationThemeRef = yield* Ref.make(DEFAULT_ANNOTATION_THEME);
  const mainWindowRef = yield* Ref.make<Option.Option<BrowserWindow>>(Option.none());
  const tabsRef = yield* SynchronizedRef.make<ReadonlyMap<string, PreviewTabState>>(new Map());
  const attachedRef = yield* Ref.make<ReadonlyMap<number, ManagedListeners>>(new Map());
  const listenersRef = yield* Ref.make<ReadonlySet<Listener>>(new Set());
  const pointerEventListenersRef = yield* Ref.make<ReadonlySet<PointerEventListener>>(new Set());
  const recordingFrameListenersRef = yield* Ref.make<ReadonlySet<RecordingFrameListener>>(
    new Set(),
  );
  const pickSessionsRef = yield* Ref.make<ReadonlyMap<string, PickSession>>(new Map());
  const controlSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<number, BrowserControlSession>
  >(new Map());
  const diagnosticsRef = yield* Ref.make<ReadonlyMap<number, BrowserDiagnostics>>(new Map());
  const expectedAgentInputsRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<ExpectedAgentInput>>
  >(new Map());
  const controlEpochRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const actionTimelineRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<PreviewAutomationActionEvent>>
  >(new Map());
  const actionSequenceRef = yield* Ref.make(0);
  const pointerSequenceRef = yield* Ref.make(0);
  const frameCaptureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, FrameCaptureSession>
  >(new Map());
  const pictureInPictureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, PictureInPictureSession>
  >(new Map());
  const pictureInPictureMutationSemaphore = yield* Semaphore.make(1);
  const closingTabIdsRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const tabLifecycleLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const tabLifecycleGenerations = new Map<string, number>();
  let pendingRecording: PendingRecording | null = null;
  const displayMediaHandlerSessions = new WeakSet<Session>();
  let frameCaptureWindowOpen = true;
  let currentMainWindow: BrowserWindow | undefined;
  let mainWindowCleanupFiber: Fiber.Fiber<void, never> | undefined;

  const attempt = <A>(errorContext: PreviewOperationContext, evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    });
  const attemptPromise = <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => PromiseLike<A>,
  ) =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    });
  const requireCurrentGuest = (tabId: string, wc: Electron.WebContents) =>
    Effect.gen(function* () {
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (wc.isDestroyed() || tabs.get(tabId)?.webContentsId !== wc.id) {
        return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId: wc.id });
      }
    });
  const capturePageWithRetry = Effect.fn("PreviewManager.capturePageWithRetry")(function* (
    errorContext: PreviewOperationContext,
    tabId: string,
    wc: Electron.WebContents,
    rectangle?: Electron.Rectangle,
    attempts = CAPTURE_PAGE_RETRY_ATTEMPTS,
    retryDelayMs = CAPTURE_PAGE_RETRY_DELAY_MS,
  ) {
    const capture = Effect.gen(function* () {
      // Check after the retry delay, and again before accepting its result.
      yield* requireCurrentGuest(tabId, wc);
      const image = yield* Effect.tryPromise({
        // An abort-signal parameter makes a stalled promise interruptible.
        try: (_signal) => wc.capturePage(rectangle),
        catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
      }).pipe(
        Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
        Effect.catchTags({
          TimeoutError: (cause) =>
            Effect.fail(new PreviewOperationError({ ...errorContext, cause })),
        }),
      );
      yield* requireCurrentGuest(tabId, wc);
      return image;
    });
    return yield* capture.pipe(
      Effect.retry({
        times: attempts - 1,
        schedule: Schedule.spaced(retryDelayMs),
        while: isPreviewOperationError,
      }),
    );
  });
  const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const currentMillis = Clock.currentTimeMillis;
  const encodeJson = (errorContext: PreviewOperationContext, value: unknown) =>
    encodeUnknownJson(value).pipe(
      Effect.mapError((cause) => new PreviewOperationError({ ...errorContext, cause })),
    );
  const nextCounter = (ref: Ref.Ref<number>) =>
    Ref.modify(ref, (value) => [value, value + 1] as const);
  const replaceMap = <K, V>(
    source: ReadonlyMap<K, V>,
    update: (copy: Map<K, V>) => void,
  ): ReadonlyMap<K, V> => {
    const copy = new Map(source);
    update(copy);
    return copy;
  };
  const withTabLifecycleLock = <A, E, R>(
    tabId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const lifecycle = tabLifecycleLocks.get(tabId) ?? {
        semaphore: Semaphore.makeUnsafe(1),
        users: 0,
      };
      lifecycle.users += 1;
      tabLifecycleLocks.set(tabId, lifecycle);
      return lifecycle.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lifecycle.users -= 1;
            if (lifecycle.users === 0 && tabLifecycleLocks.get(tabId) === lifecycle) {
              tabLifecycleLocks.delete(tabId);
            }
          }),
        ),
      );
    });
  const setWindowBackgroundThrottling = Effect.fnUntraced(function* (
    window: BrowserWindow,
    enabled: boolean,
  ) {
    if (window.isDestroyed()) return;
    yield* attempt({ operation: "frameCapture.setWindowBackgroundThrottling" }, () => {
      window.webContents.setBackgroundThrottling?.(enabled);
    });
  });
  const setFrameCaptureBackgroundThrottling = Effect.fnUntraced(function* (enabled: boolean) {
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (Option.isNone(mainWindow)) return;
    yield* setWindowBackgroundThrottling(mainWindow.value, enabled);
  });
  const setFrameCaptureWebContentsBackgroundThrottling = Effect.fnUntraced(function* (
    wc: Electron.WebContents,
    enabled: boolean,
  ) {
    if (wc.isDestroyed()) return;
    yield* attempt(
      {
        operation: "frameCapture.setBackgroundThrottling",
        webContentsId: wc.id,
      },
      () => wc.setBackgroundThrottling?.(enabled),
    );
  });
  const restoreFrameCaptureWebContentsBackgroundThrottling = Effect.fnUntraced(function* (
    webContentsIds: ReadonlySet<number>,
  ) {
    yield* Effect.forEach(
      webContentsIds,
      (webContentsId) => {
        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) return Effect.void;
        return setFrameCaptureWebContentsBackgroundThrottling(wc, true).pipe(
          Effect.retry({ times: 2 }),
          Effect.catch((error) =>
            Effect.logWarning("Failed to restore preview webview frame capture throttling.", {
              webContentsId,
              error,
            }),
          ),
        );
      },
      { concurrency: "unbounded", discard: true },
    );
  });
  const keepFrameCaptureWebContentsUnthrottled = Effect.fnUntraced(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) => {
      const current = sessions.get(tabId);
      if (!current || current.unthrottledWebContentsIds.has(wc.id)) {
        return Effect.succeed([undefined, sessions] as const);
      }
      return setFrameCaptureWebContentsBackgroundThrottling(wc, false).pipe(
        Effect.map(
          () =>
            [
              undefined,
              replaceMap(sessions, (copy) => {
                copy.set(tabId, {
                  ...current,
                  unthrottledWebContentsIds: new Set([...current.unthrottledWebContentsIds, wc.id]),
                });
              }),
            ] as const,
        ),
      );
    });
  });
  const stopFrameCapture = Effect.fn("PreviewManager.stopFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) {
    const captureScope = yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) =>
      Effect.gen(function* () {
        const current = sessions.get(tabId);
        if (!current || !current.consumers.has(consumer)) {
          return [undefined, sessions] as const;
        }
        const consumers = new Set(current.consumers);
        consumers.delete(consumer);
        if (consumers.size > 0) {
          return [
            consumer === "picture-in-picture" ? current.scope : undefined,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                ...current,
                scope: consumer === "picture-in-picture" ? null : current.scope,
                consumers,
              });
            }),
          ] as const;
        }
        const remainingSessions = replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        });
        yield* restoreFrameCaptureWebContentsBackgroundThrottling(
          current.unthrottledWebContentsIds,
        );
        if (remainingSessions.size === 0) {
          yield* setFrameCaptureBackgroundThrottling(true).pipe(
            Effect.retry({ times: 2 }),
            Effect.catch((error) =>
              Effect.logWarning("Failed to restore preview frame capture throttling.", { error }),
            ),
          );
        }
        return [current.scope ?? undefined, remainingSessions] as const;
      }),
    );
    if (captureScope) {
      yield* Scope.close(captureScope, Exit.void).pipe(Effect.ignore);
    }
  });
  const stopAllRecordings = Effect.fn("PreviewManager.stopAllRecordings")(function* () {
    pendingRecording = null;
    const sessions = yield* SynchronizedRef.get(frameCaptureSessionsRef);
    yield* Effect.forEach(sessions.keys(), (tabId) => stopFrameCapture(tabId, "recording"), {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const deliverEvent = (
    eventKind: "state-change" | "recording-frame" | "pointer-event",
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) =>
    Effect.suspend(delivery).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Desktop preview event listener failed.", {
              eventKind,
              tabId,
              cause,
            }),
      ),
    );

  const emit = Effect.fn("PreviewManager.emit")(function* (tabId: string, state: PreviewTabState) {
    const listeners = yield* Ref.get(listenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("state-change", tabId, () => listener(tabId, state)),
      { discard: true },
    );
  });

  const tabIdsInZoomScope = (
    tabs: ReadonlyMap<string, PreviewTabState>,
    tabId: string,
    wc: WebContents,
  ): string[] => {
    const scope = previewZoomScope(wc);
    if (!scope) return [tabId];
    const tabIds: string[] = [];
    for (const [candidateTabId, candidate] of tabs) {
      if (candidate.webContentsId === null) continue;
      const candidateWebContents = webContents.fromId(candidate.webContentsId);
      if (!candidateWebContents) continue;
      const candidateScope = previewZoomScope(candidateWebContents);
      if (candidateScope && samePreviewZoomScope(scope, candidateScope)) {
        tabIds.push(candidateTabId);
      }
    }
    return tabIds.includes(tabId) ? tabIds : [...tabIds, tabId];
  };

  const resolveZoomFactorForWebContents = (
    tabs: ReadonlyMap<string, PreviewTabState>,
    tabId: string,
    wc: WebContents,
  ): number => {
    const current = tabs.get(tabId);
    if (!current) return DEFAULT_ZOOM_FACTOR;
    for (const scopedTabId of tabIdsInZoomScope(tabs, tabId, wc)) {
      if (scopedTabId === tabId) continue;
      const sibling = tabs.get(scopedTabId);
      if (sibling) return sibling.zoomFactor;
    }
    return current.zoomFactor;
  };

  const update = Effect.fn("PreviewManager.update")(function* (
    tabId: string,
    patch: Partial<PreviewTabState>,
  ) {
    const updatedAt = yield* currentIso;
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      const state: PreviewTabState = { ...current, ...patch, updatedAt };
      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    if (Option.isSome(next)) yield* emit(tabId, next.value);
  });

  const requireWebContents = Effect.fn("PreviewManager.requireWebContents")(function* (
    tabId: string,
  ) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    const tab = tabs.get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.webContentsId == null) {
      return yield* new PreviewWebviewNotInitializedError({ tabId });
    }
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc || wc.isDestroyed()) {
      yield* detachControlSession(tab.webContentsId, wc);
      return yield* new PreviewWebContentsNotFoundError({
        tabId,
        webContentsId: tab.webContentsId,
      });
    }
    return wc;
  });

  const resolveArtifactPath = (artifactPath: string) =>
    attempt({ operation: "resolveArtifactPath", artifactPath }, () => {
      const resolvedPath = path.resolve(artifactPath);
      const relativePath = path.relative(resolvedArtifactDirectory, resolvedPath);
      if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }
      return resolvedPath;
    }).pipe(
      Effect.flatMap((resolvedPath) =>
        resolvedPath === null
          ? Effect.fail(
              new PreviewArtifactPathOutsideDirectoryError({
                artifactPath,
                artifactDirectory: resolvedArtifactDirectory,
              }),
            )
          : Effect.succeed(resolvedPath),
      ),
    );

  const tabIdForWebContents = Effect.fn("PreviewManager.tabIdForWebContents")(function* (
    webContentsId: number,
  ) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    return (
      Array.from(tabs.entries()).find(([, tab]) => tab.webContentsId === webContentsId)?.[0] ?? null
    );
  });

  const pushBounded = <A>(buffer: ReadonlyArray<A>, entry: A): ReadonlyArray<A> =>
    [...buffer, entry].slice(-DIAGNOSTIC_BUFFER_LIMIT);

  const captureDiagnosticMessage = Effect.fn("PreviewManager.captureDiagnosticMessage")(function* (
    webContentsId: number,
    method: string,
    params: Record<string, unknown>,
  ) {
    const timestamp = yield* currentIso;
    yield* Ref.update(diagnosticsRef, (allDiagnostics) => {
      const current = allDiagnostics.get(webContentsId);
      if (!current) return allDiagnostics;
      const requestId = typeof params["requestId"] === "string" ? params["requestId"] : null;
      const next = (() => {
        if (method === "Runtime.consoleAPICalled") {
          const args = Array.isArray(params["args"]) ? params["args"] : [];
          const text = args
            .map((arg) => {
              if (typeof arg !== "object" || arg === null) return String(arg);
              const value = arg as Record<string, unknown>;
              return String(value["value"] ?? value["description"] ?? "");
            })
            .join(" ");
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof params["type"] === "string" ? params["type"] : "log",
              text,
              timestamp,
              source: "console",
            }),
          };
        }
        if (method === "Runtime.exceptionThrown") {
          const details =
            typeof params["exceptionDetails"] === "object" && params["exceptionDetails"] !== null
              ? (params["exceptionDetails"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: "error",
              text: String(details["text"] ?? "Uncaught exception"),
              timestamp,
              source: "exception",
            }),
          };
        }
        if (method === "Log.entryAdded") {
          const entry =
            typeof params["entry"] === "object" && params["entry"] !== null
              ? (params["entry"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            consoleEntries: pushBounded(current.consoleEntries, {
              level: typeof entry["level"] === "string" ? entry["level"] : "info",
              text: String(entry["text"] ?? ""),
              timestamp,
              source: typeof entry["source"] === "string" ? entry["source"] : "log",
            }),
          };
        }
        if (method === "Network.requestWillBeSent" && requestId) {
          const request =
            typeof params["request"] === "object" && params["request"] !== null
              ? (params["request"] as Record<string, unknown>)
              : {};
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.set(requestId, {
                url: String(request["url"] ?? ""),
                method: String(request["method"] ?? "GET"),
              });
            }),
          };
        }
        if (method === "Network.responseReceived" && requestId) {
          const request = current.requests.get(requestId);
          const response =
            typeof params["response"] === "object" && params["response"] !== null
              ? (params["response"] as Record<string, unknown>)
              : {};
          const status = typeof response["status"] === "number" ? response["status"] : null;
          return request && status !== null && status >= 400
            ? {
                ...current,
                networkEntries: pushBounded(current.networkEntries, {
                  ...request,
                  status,
                  failed: true,
                  timestamp,
                }),
              }
            : current;
        }
        if (method === "Network.loadingFailed" && requestId) {
          const request = current.requests.get(requestId);
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.delete(requestId);
            }),
            networkEntries: request
              ? pushBounded(current.networkEntries, {
                  ...request,
                  status: null,
                  failed: true,
                  errorText: String(params["errorText"] ?? "Network request failed"),
                  timestamp,
                })
              : current.networkEntries,
          };
        }
        if (method === "Network.loadingFinished" && requestId) {
          return {
            ...current,
            requests: replaceMap(current.requests, (copy) => {
              copy.delete(requestId);
            }),
          };
        }
        return current;
      })();
      return replaceMap(allDiagnostics, (copy) => {
        copy.set(webContentsId, next);
      });
    });
  });

  const detachControlSession = Effect.fn("PreviewManager.detachControlSession")(function* (
    webContentsId: number,
    expectedWebContents?: Electron.WebContents,
  ) {
    const detached = yield* SynchronizedRef.modify(
      controlSessionsRef,
      (
        sessions,
      ): readonly [
        (
          | { readonly matched: false }
          | { readonly matched: true; readonly control: BrowserControlSession | undefined }
        ),
        ReadonlyMap<number, BrowserControlSession>,
      ] => {
        const control = sessions.get(webContentsId);
        if (expectedWebContents && control?.webContents !== expectedWebContents) {
          return [{ matched: false }, sessions];
        }
        return [
          { matched: true, control },
          replaceMap(sessions, (copy) => {
            copy.delete(webContentsId);
          }),
        ];
      },
    );
    if (!detached.matched) return;
    const { control } = detached;
    if (control) {
      yield* Scope.close(control.scope, Exit.void).pipe(Effect.ignore);
      return;
    }
    yield* Ref.update(diagnosticsRef, (diagnostics) =>
      replaceMap(diagnostics, (copy) => {
        copy.delete(webContentsId);
      }),
    );
  });

  const ensureControlSession = Effect.fn("PreviewManager.ensureControlSession")(function* (
    wc: Electron.WebContents,
  ) {
    return yield* SynchronizedRef.modifyEffect(
      controlSessionsRef,
      (
        sessions,
      ): Effect.Effect<
        readonly [BrowserControlSession, ReadonlyMap<number, BrowserControlSession>],
        PreviewManagerError
      > => {
        const existing = sessions.get(wc.id);
        if (existing) return Effect.succeed([existing, sessions] as const);
        // Optional calls: test doubles may omit these; treat missing as closed/free.
        if (wc.isDevToolsOpened?.()) {
          return Effect.fail(
            new PreviewAutomationDevToolsOpenError({
              webContentsId: wc.id,
            }),
          );
        }
        if (wc.debugger.isAttached?.()) {
          return Effect.fail(
            new PreviewAutomationDebuggerAttachedError({
              webContentsId: wc.id,
            }),
          );
        }
        const createControlSession = Effect.fn("PreviewManager.createControlSession")(function* () {
          const semaphore = yield* Semaphore.make(1);
          const scope = yield* Scope.fork(parentScope, "sequential");
          const wcDebugger = wc.debugger;
          const handleDebuggerMessage = Effect.fn("PreviewManager.handleDebuggerMessage")(
            function* (method: string, params: Record<string, unknown>) {
              if (method === "Page.screencastFrame") {
                const sessionId = params["sessionId"];
                if (typeof sessionId === "number") {
                  yield* attemptPromise(
                    {
                      operation: "ackScreencastFrame",
                      webContentsId: wc.id,
                    },
                    () => wcDebugger.sendCommand("Page.screencastFrameAck", { sessionId }),
                  ).pipe(Effect.ignore);
                }
                const tabId = yield* tabIdForWebContents(wc.id);
                const metadata =
                  typeof params["metadata"] === "object" && params["metadata"] !== null
                    ? (params["metadata"] as Record<string, unknown>)
                    : {};
                if (tabId && typeof params["data"] === "string") {
                  const receivedAt = yield* currentIso;
                  const listeners = yield* Ref.get(recordingFrameListenersRef);
                  const frame: DesktopPreviewRecordingFrame = {
                    tabId,
                    data: params["data"],
                    width:
                      typeof metadata["deviceWidth"] === "number" ? metadata["deviceWidth"] : 0,
                    height:
                      typeof metadata["deviceHeight"] === "number" ? metadata["deviceHeight"] : 0,
                    receivedAt,
                  };
                  yield* Effect.forEach(
                    listeners,
                    (listener) =>
                      deliverEvent("recording-frame", frame.tabId, () => listener(frame)),
                    { discard: true },
                  );
                }
              }
              yield* captureDiagnosticMessage(wc.id, method, params);
            },
          );
          const onMessage: BrowserControlSession["onMessage"] = (_event, method, params) => {
            runFork(handleDebuggerMessage(method, params));
          };
          yield* Scope.addFinalizer(
            scope,
            Effect.all(
              [
                Ref.update(diagnosticsRef, (diagnostics) =>
                  replaceMap(diagnostics, (copy) => {
                    copy.delete(wc.id);
                  }),
                ),
                attempt({ operation: "detachControlSession", webContentsId: wc.id }, () => {
                  wcDebugger.off("message", onMessage);
                  if (wcDebugger.isAttached()) wcDebugger.detach();
                }).pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          );
          const control: BrowserControlSession = {
            webContentsId: wc.id,
            webContents: wc,
            debugger: wcDebugger,
            semaphore,
            scope,
            onMessage,
          };
          const initialize = Effect.fn("PreviewManager.initializeControlSession")(function* () {
            yield* Ref.update(diagnosticsRef, (diagnostics) =>
              replaceMap(diagnostics, (copy) => {
                copy.set(wc.id, {
                  consoleEntries: [],
                  networkEntries: [],
                  requests: new Map(),
                });
              }),
            );
            yield* attempt({ operation: "attachDebuggerListeners", webContentsId: wc.id }, () => {
              wcDebugger.on("message", onMessage);
              wcDebugger.attach("1.3");
            });
            yield* Effect.all(
              ["Runtime.enable", "Accessibility.enable", "Network.enable", "Log.enable"].map(
                (method) =>
                  attemptPromise(
                    { operation: `initializeDebugger.${method}`, webContentsId: wc.id },
                    () => wcDebugger.sendCommand(method),
                  ),
              ),
              { concurrency: "unbounded", discard: true },
            );
            return [
              control,
              replaceMap(sessions, (copy) => {
                copy.set(wc.id, control);
              }),
            ] as const;
          });
          return yield* initialize().pipe(
            Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
          );
        });
        return createControlSession();
      },
    );
  });

  const pushAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) =>
      replaceMap(timelines, (copy) => {
        copy.set(tabId, [...(timelines.get(tabId) ?? []), event].slice(-200));
      }),
    );
  const replaceAction = (tabId: string, event: PreviewAutomationActionEvent) =>
    Ref.update(actionTimelineRef, (timelines) => {
      const timeline = timelines.get(tabId);
      if (!timeline) return timelines;
      return replaceMap(timelines, (copy) => {
        copy.set(
          tabId,
          timeline.map((candidate) => (candidate.id === event.id ? event : candidate)),
        );
      });
    });

  type SendCommand = (
    method: string,
    commandParams?: Record<string, unknown>,
  ) => Effect.Effect<unknown, PreviewManagerError>;

  const captureAutomationScreenshotWithRetry = Effect.fn(
    "PreviewManager.captureAutomationScreenshotWithRetry",
  )(function* (tabId: string, wc: Electron.WebContents, send: SendCommand) {
    const errorContext = {
      operation: "automationSnapshot.captureScreenshot",
      tabId,
      webContentsId: wc.id,
    };
    const capture = Effect.gen(function* () {
      yield* requireCurrentGuest(tabId, wc);
      const result = yield* send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      }).pipe(
        Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
        Effect.catchTags({
          TimeoutError: (cause) =>
            Effect.fail(new PreviewOperationError({ ...errorContext, cause })),
        }),
      );
      const data = (result as { readonly data?: unknown } | null)?.data;
      if (typeof data !== "string" || data.length === 0) {
        return yield* new PreviewOperationError({
          ...errorContext,
          cause: new Error("The browser returned no screenshot data."),
        });
      }
      const image = yield* attempt(errorContext, () =>
        nativeImage.createFromBuffer(Buffer.from(data, "base64")),
      );
      const size = image.getSize();
      if (image.isEmpty() || size.width <= 0 || size.height <= 0) {
        return yield* new PreviewOperationError({
          ...errorContext,
          cause: new Error("The browser returned an empty screenshot."),
        });
      }
      yield* requireCurrentGuest(tabId, wc);
      return image;
    });
    return yield* capture.pipe(
      Effect.retry({
        times: CAPTURE_PAGE_RETRY_ATTEMPTS - 1,
        schedule: Schedule.spaced(CAPTURE_PAGE_RETRY_DELAY_MS),
        while: isPreviewOperationError,
      }),
    );
  });

  const prepareAutomationInput = Effect.fn("PreviewManager.prepareAutomationInput")(function* (
    send: SendCommand,
    enableRuntime: boolean,
  ) {
    yield* Effect.all(
      [
        ...(enableRuntime ? [send("Runtime.enable")] : []),
        send("Input.setIgnoreInputEvents", { ignore: false }),
      ],
      { concurrency: 2, discard: true },
    );
  });

  const withControlSession = Effect.fn("PreviewManager.withControlSession")(function* <A>(
    tabId: string,
    wc: Electron.WebContents,
    action: string,
    use: (send: SendCommand, sendCleanup: SendCommand) => Effect.Effect<A, PreviewManagerError>,
  ) {
    const sequence = yield* nextCounter(actionSequenceRef);
    const startedAt = yield* currentIso;
    const millis = yield* currentMillis;
    const actionEvent: PreviewAutomationActionEvent = {
      id: `browser-action-${millis.toString(36)}-${sequence.toString(36)}`,
      action,
      status: "running",
      startedAt,
    };
    yield* pushAction(tabId, actionEvent);
    const epoch = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
    const control = yield* ensureControlSession(wc);
    const execute = Effect.fn("PreviewManager.executeControlAction")(function* () {
      yield* update(tabId, { controller: "agent" });
      const send: SendCommand = Effect.fn("PreviewManager.sendCommand")(
        function* (method, commandParams) {
          const before = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
          if (before !== epoch) {
            return yield* new PreviewAutomationControlInterruptedError({
              operation: action,
              tabId,
              webContentsId: wc.id,
            });
          }
          const result = yield* attemptPromise(
            { operation: `${action}.${method}`, tabId, webContentsId: wc.id },
            () => control.debugger.sendCommand(method, commandParams),
          );
          const after = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
          if (after !== epoch) {
            return yield* new PreviewAutomationControlInterruptedError({
              operation: action,
              tabId,
              webContentsId: wc.id,
            });
          }
          return result;
        },
      );
      // Cleanup commands must still run after human input invalidates the action's
      // control epoch. Otherwise a partially dispatched input can leave Chromium
      // with a held key or focus emulation enabled for subsequent actions.
      const sendCleanup: SendCommand = Effect.fn("PreviewManager.sendCleanupCommand")(
        function* (method, commandParams) {
          return yield* attemptPromise(
            {
              operation: `${action}.cleanup.${method}`,
              tabId,
              webContentsId: wc.id,
            },
            () => control.debugger.sendCommand(method, commandParams),
          );
        },
      );
      return yield* use(send, sendCleanup);
    });
    const finalize = Effect.fn("PreviewManager.finalizeControlAction")(function* (
      exit: Exit.Exit<A, PreviewManagerError>,
    ) {
      const completedAt = yield* currentIso;
      if (exit._tag === "Success") {
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: "succeeded",
          completedAt,
        });
      } else {
        const error = Option.getOrNull(Cause.findErrorOption(exit.cause));
        const interrupted = isPreviewAutomationControlInterruptedError(error);
        const errorMessage = isPreviewOperationError(error)
          ? PreviewOperationError.toTimelineMessage(error)
          : isPreviewAutomationEvaluationError(error)
            ? PreviewAutomationEvaluationError.toTimelineMessage(error)
            : isPreviewAutomationInvalidSelectorError(error)
              ? PreviewAutomationInvalidSelectorError.toTimelineMessage(error)
              : error instanceof Error
                ? error.message
                : String(error);
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: interrupted ? "interrupted" : "failed",
          completedAt,
          error: errorMessage,
        });
      }
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (tabs.has(tabId)) yield* update(tabId, { controller: "none" });
    });
    return yield* control.semaphore.withPermit(execute().pipe(Effect.onExit(finalize)));
  });

  const evaluateWithDebugger = <A = unknown>(
    tabId: string,
    send: SendCommand,
    expression: string,
    returnByValue: boolean,
    awaitPromise = true,
  ): Effect.Effect<A, PreviewManagerError> =>
    send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    }).pipe(
      Effect.flatMap((rawResponse) => {
        const response = rawResponse as CdpEvaluationResult;
        if (!response.exceptionDetails) {
          return Effect.succeed(response.result?.value as A);
        }
        const detail = previewAutomationEvaluationDetail(response.exceptionDetails);
        return Effect.fail(
          new PreviewAutomationEvaluationError({
            tabId,
            detailKind: detail.detailKind,
            detailLength: detail.detail?.length ?? 0,
            cause: response.exceptionDetails,
          }),
        );
      }),
    );

  const automationLocator = (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): string | null => input.locator ?? (input.selector ? `css=${input.selector}` : null);

  const automationSelectorDiagnostics = (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): {
    readonly selectorKind: PreviewAutomationSelectorKind;
    readonly selectorLength?: number;
  } => {
    if (input.locator !== undefined) {
      return { selectorKind: "locator", selectorLength: input.locator.length };
    }
    if (input.selector !== undefined) {
      return { selectorKind: "selector", selectorLength: input.selector.length };
    }
    return { selectorKind: "focused-element" };
  };

  const ensurePlaywrightInjected = Effect.fn("PreviewManager.ensurePlaywrightInjected")(function* (
    tabId: string,
    send: SendCommand,
  ) {
    const installed = yield* evaluateWithDebugger<boolean>(
      tabId,
      send,
      "Boolean(globalThis.__t3PlaywrightInjected)",
      true,
    );
    if (installed) return;
    const expression = yield* playwrightInstallExpression.pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "ensurePlaywrightInjected",
            tabId,
            cause,
          }),
      ),
    );
    yield* evaluateWithDebugger(tabId, send, expression, true);
  });

  const cancelPickElement = Effect.fn("PreviewManager.cancelPickElement")(function* (
    tabId: string,
  ) {
    const session = (yield* Ref.get(pickSessionsRef)).get(tabId);
    if (session) yield* session.cancel;
  });

  const detachListeners = Effect.fn("PreviewManager.detachListeners")(function* (
    webContentsId: number,
    expectedWebContents?: Electron.WebContents,
  ) {
    const managed = yield* Ref.modify(attachedRef, (attached) => [
      attached.get(webContentsId)?.webContents === expectedWebContents || !expectedWebContents
        ? attached.get(webContentsId)
        : undefined,
      attached.get(webContentsId)?.webContents === expectedWebContents || !expectedWebContents
        ? replaceMap(attached, (copy) => {
            copy.delete(webContentsId);
          })
        : attached,
    ]);
    if (managed) yield* Scope.close(managed.scope, Exit.void).pipe(Effect.ignore);
  });

  const isPreviewRefreshShortcut = (input: Electron.Input): boolean =>
    input.type === "keyDown" &&
    input.key.toLowerCase() === "r" &&
    (input.meta || input.control) &&
    !input.shift &&
    !input.alt;

  const computeNavStatus = (
    wc: Electron.WebContents,
    loading: boolean = wc.isLoading(),
  ): PreviewNavStatus => {
    const url = wc.getURL();
    const title = wc.getTitle();
    if (url === "" || url === "about:blank") return { kind: "Idle" };
    if (loading) return { kind: "Loading", url, title };
    return { kind: "Success", url, title };
  };

  const consumeExpectedAgentInput = Effect.fn("PreviewManager.consumeExpectedAgentInput")(
    function* (tabId: string, signal: PreviewInputSignal) {
      const now = yield* currentMillis;
      return yield* Ref.modify(expectedAgentInputsRef, (allExpected) => {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        );
        const index = pending.findIndex((expected) => inputSignalsMatch(expected.signal, signal));
        const matched = index >= 0;
        const nextPending = matched
          ? pending.filter((_, pendingIndex) => pendingIndex !== index)
          : pending;
        return [
          matched,
          replaceMap(allExpected, (copy) => {
            if (nextPending.length === 0) copy.delete(tabId);
            else copy.set(tabId, nextPending);
          }),
        ] as const;
      });
    },
  );

  const expectAgentInput = Effect.fn("PreviewManager.expectAgentInput")(function* (
    tabId: string,
    signal: PreviewInputSignal,
  ) {
    const now = yield* currentMillis;
    yield* Ref.update(expectedAgentInputsRef, (allExpected) =>
      replaceMap(allExpected, (copy) => {
        const pending = (allExpected.get(tabId) ?? []).filter(
          (expected) => expected.expiresAt > now,
        );
        copy.set(tabId, [...pending, { signal, expiresAt: now + 1_000 }]);
      }),
    );
  });

  const attachListeners = Effect.fn("PreviewManager.attachListeners")(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const scope = yield* Scope.fork(parentScope, "sequential");
    const syncState = Effect.fn("PreviewManager.syncWebContentsState")(function* (
      preserveLoadFailure: boolean,
      loading?: boolean,
    ) {
      if (wc.isDestroyed()) return;
      const tabs = yield* SynchronizedRef.get(tabsRef);
      const currentTab = tabs.get(tabId);
      const zoomFactor = resolveZoomFactorForWebContents(tabs, tabId, wc);
      if (currentTab) {
        yield* attempt(
          { operation: "syncWebContentsState.restoreZoomFactor", tabId, webContentsId: wc.id },
          () => wc.setZoomFactor(zoomFactor),
        ).pipe(Effect.ignore);
      }
      const computedNavStatus = computeNavStatus(wc, loading);
      const canGoBack = wc.navigationHistory.canGoBack();
      const canGoForward = wc.navigationHistory.canGoForward();
      const updatedAt = yield* currentIso;
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);
        if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
        // Electron emits did-stop-loading after did-fail-load. At that point the
        // failed guest is no longer "loading", but it has not successfully
        // navigated anywhere. Keep the failure until a new load actually starts.
        const navStatus =
          preserveLoadFailure &&
          current.navStatus.kind === "LoadFailed" &&
          computedNavStatus.kind === "Success"
            ? current.navStatus
            : computedNavStatus;
        const state: PreviewTabState = {
          ...current,
          navStatus,
          canGoBack,
          canGoForward,
          zoomFactor,
          updatedAt,
        };
        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });
      if (Option.isSome(next)) yield* emit(tabId, next.value);
    });
    const sync = () => runFork(syncState(true));
    const syncNavigation = () => runFork(syncState(false));
    // Capture the event's load phase before the fork runs; reading isLoading()
    // later can observe a subsequent phase and leave the renderer stuck loading.
    const syncLoadStarted = () => runFork(syncState(false, true));
    const syncLoadFinished = () => runFork(syncState(false, false));
    const syncLoadStopped = () => runFork(syncState(true, false));
    const failed = (
      _event: Event,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      if (code === -3 || !isMainFrame) return;
      runFork(
        update(tabId, {
          navStatus: {
            kind: "LoadFailed",
            url: validatedUrl || wc.getURL(),
            title: wc.getTitle(),
            code,
            description,
          },
        }),
      );
    };
    const handleHumanInput = Effect.fn("PreviewManager.handleHumanInput")(function* (
      rawSignal?: unknown,
    ) {
      if (isPreviewInputSignal(rawSignal) && (yield* consumeExpectedAgentInput(tabId, rawSignal))) {
        return;
      }
      yield* Ref.update(controlEpochRef, (epochs) =>
        replaceMap(epochs, (copy) => {
          copy.set(tabId, (epochs.get(tabId) ?? 0) + 1);
        }),
      );
      yield* update(tabId, { controller: "human" });
      yield* Effect.sleep(750);
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (tabs.get(tabId)?.controller === "human") {
        yield* update(tabId, { controller: "none" });
      }
    });
    const humanInput = (_event: unknown, rawSignal?: unknown): void => {
      runFork(handleHumanInput(rawSignal));
    };
    const beforeInput = (event: Electron.Event, input: Electron.Input): void => {
      const zoom = previewZoomShortcut(input);
      if (zoom) {
        event.preventDefault();
        runFork(
          applyZoom(tabId, (current) =>
            zoom === "reset" ? DEFAULT_ZOOM_FACTOR : nextZoomLevel(current, zoom),
          ),
        );
        return;
      }
      if (isPreviewRefreshShortcut(input)) {
        event.preventDefault();
        runFork(
          attempt({ operation: "shortcut.refresh", tabId, webContentsId: wc.id }, () =>
            wc.reload(),
          ).pipe(Effect.ignore),
        );
        return;
      }
    };
    const popupWindows = new Set<Electron.BrowserWindow>();
    const windowCreated = (window: Electron.BrowserWindow): void => {
      popupWindows.add(window);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.once("closed", () => {
        popupWindows.delete(window);
      });
    };
    yield* Scope.addFinalizer(
      scope,
      attempt({ operation: "detachListeners", tabId, webContentsId: wc.id }, () => {
        wc.off("did-navigate", syncNavigation);
        wc.off("did-navigate-in-page", syncNavigation);
        wc.off("page-title-updated", sync);
        wc.off("did-start-loading", syncLoadStarted);
        wc.off("did-finish-load", syncLoadFinished);
        wc.off("did-stop-loading", syncLoadStopped);
        wc.off("did-fail-load", failed as never);
        wc.off("before-input-event", beforeInput);
        wc.off("did-create-window", windowCreated);
        wc.ipc.off(HUMAN_INPUT_CHANNEL, humanInput);
        for (const popup of popupWindows) {
          if (!popup.isDestroyed()) popup.close();
        }
        popupWindows.clear();
      }).pipe(Effect.ignore),
    );
    const install = Effect.fn("PreviewManager.installWebContentsListeners")(function* () {
      yield* attempt({ operation: "attachListeners", tabId, webContentsId: wc.id }, () => {
        // Preview input belongs to the page, including keys injected through CDP.
        // Never let it invoke the host application's menu accelerators.
        if (typeof wc.setIgnoreMenuShortcuts === "function") {
          wc.setIgnoreMenuShortcuts(true);
        }
        wc.on("did-navigate", syncNavigation);
        wc.on("did-navigate-in-page", syncNavigation);
        wc.on("page-title-updated", sync);
        wc.on("did-start-loading", syncLoadStarted);
        wc.on("did-finish-load", syncLoadFinished);
        wc.on("did-stop-loading", syncLoadStopped);
        wc.on("did-fail-load", failed as never);
        wc.ipc.on(HUMAN_INPUT_CHANNEL, humanInput);
        wc.setWindowOpenHandler((details) => {
          const action = previewWindowOpenAction(details);
          if (action === "deny") {
            runFork(Effect.logWarning("Preview popup URL rejected", { tabId }));
            return { action: "deny" };
          }
          if (action === "popup") {
            return { action: "allow", overrideBrowserWindowOptions: POPUP_WINDOW_OPTIONS };
          }
          runFork(
            attemptPromise({ operation: "openPreviewWindow", tabId, webContentsId: wc.id }, () =>
              wc.loadURL(details.url),
            ).pipe(Effect.ignore),
          );
          return { action: "deny" };
        });
        wc.on("did-create-window", windowCreated);
        wc.on("before-input-event", beforeInput);
      });
      yield* Ref.update(attachedRef, (attached) =>
        replaceMap(attached, (copy) => {
          copy.set(wc.id, { scope, webContents: wc });
        }),
      );
    });
    yield* install().pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  const setMainWindow = Effect.fn("PreviewManager.setMainWindow")(function* (
    window: BrowserWindow,
  ) {
    if (mainWindowCleanupFiber) {
      yield* Fiber.join(mainWindowCleanupFiber);
      mainWindowCleanupFiber = undefined;
    }
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) =>
      Effect.gen(function* () {
        if (sessions.size > 0) {
          yield* setWindowBackgroundThrottling(window, false);
        }
        yield* Ref.set(mainWindowRef, Option.some(window));
        currentMainWindow = window;
        frameCaptureWindowOpen = true;
        window.once("closed", () => {
          if (currentMainWindow !== window) return;
          currentMainWindow = undefined;
          frameCaptureWindowOpen = false;
          mainWindowCleanupFiber = runFork(
            Effect.all([closeAllPictureInPicture(), stopAllRecordings()], {
              concurrency: "unbounded",
              discard: true,
            }).pipe(Effect.ignore),
          );
        });
        return [undefined, sessions] as const;
      }),
    ).pipe(Effect.uninterruptible);
  });

  const createTabUnlocked = Effect.fn("PreviewManager.createTabUnlocked")(function* (
    tabId: string,
    defaults?: DesktopPreviewTabDefaults,
  ) {
    const updatedAt = yield* currentIso;
    const result = yield* SynchronizedRef.modify(
      tabsRef,
      (
        tabs,
      ): readonly [
        { readonly state: PreviewTabState; readonly created: boolean },
        ReadonlyMap<string, PreviewTabState>,
      ] => {
        const existing = tabs.get(tabId);
        if (existing) return [{ state: existing, created: false }, tabs] as const;
        const initial: PreviewTabState = {
          tabId,
          webContentsId: null,
          navStatus: { kind: "Idle" },
          canGoBack: false,
          canGoForward: false,
          zoomFactor: defaults?.zoomFactor ?? DEFAULT_ZOOM_FACTOR,
          pictureInPicture: false,
          colorScheme: defaults?.colorScheme ?? "system",
          controller: "none",
          updatedAt,
        };
        return [
          { state: initial, created: true },
          replaceMap(tabs, (copy) => {
            copy.set(tabId, initial);
          }),
        ] as const;
      },
    );
    if (result.created) {
      tabLifecycleGenerations.set(tabId, (tabLifecycleGenerations.get(tabId) ?? 0) + 1);
    }
    yield* emit(tabId, result.state);
    return result.state;
  });

  const createTab = Effect.fn("PreviewManager.createTab")(function* (
    tabId: string,
    defaults?: DesktopPreviewTabDefaults,
  ) {
    return yield* withTabLifecycleLock(tabId, createTabUnlocked(tabId, defaults));
  });

  const closeTabUnlocked = Effect.fn("PreviewManager.closeTabUnlocked")(function* (tabId: string) {
    if (!(yield* SynchronizedRef.get(tabsRef)).has(tabId)) return;
    clearPendingRecording(tabId);
    yield* Effect.all(
      [
        cancelPickElement(tabId),
        closePictureInPicture(tabId),
        stopFrameCapture(tabId, "recording"),
      ],
      { concurrency: 3, discard: true },
    );
    const tab = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      return [
        Option.some(current),
        replaceMap(tabs, (copy) => {
          copy.delete(tabId);
        }),
      ] as const;
    });
    if (Option.isNone(tab)) return;
    const closedTab = tab.value;
    if (closedTab.webContentsId != null) {
      yield* Effect.all(
        [detachControlSession(closedTab.webContentsId), detachListeners(closedTab.webContentsId)],
        { concurrency: 2, discard: true },
      );
    }
    const updatedAt = yield* currentIso;
    const closed: PreviewTabState = {
      ...closedTab,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      pictureInPicture: false,
      colorScheme: "system",
      controller: "none",
      updatedAt,
    };
    yield* emit(tabId, closed);
  });

  const closeTab = Effect.fn("PreviewManager.closeTab")(function* (tabId: string) {
    yield* Ref.update(closingTabIdsRef, (closingTabIds) => {
      const next = new Map(closingTabIds);
      next.set(tabId, (next.get(tabId) ?? 0) + 1);
      return next;
    });
    return yield* withTabLifecycleLock(tabId, closeTabUnlocked(tabId)).pipe(
      Effect.ensuring(
        Ref.update(closingTabIdsRef, (closingTabIds) => {
          if (!closingTabIds.has(tabId)) return closingTabIds;
          const next = new Map(closingTabIds);
          const pendingCloses = next.get(tabId) ?? 0;
          if (pendingCloses <= 1) {
            next.delete(tabId);
          } else {
            next.set(tabId, pendingCloses - 1);
          }
          return next;
        }),
      ),
    );
  });

  const registerWebviewUnlocked = Effect.fn("PreviewManager.registerWebviewUnlocked")(function* (
    tabId: string,
    webContentsId: number,
    expectedGeneration: number | undefined,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (
      !tab ||
      tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
      (yield* Ref.get(closingTabIdsRef)).has(tabId)
    ) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const wc = webContents.fromId(webContentsId);
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (
      !wc ||
      wc.getType() !== "webview" ||
      (Option.isSome(mainWindow) && wc.hostWebContents !== mainWindow.value.webContents)
    ) {
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId });
    }
    const attached = yield* Ref.get(attachedRef);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    yield* keepFrameCaptureWebContentsUnthrottled(tabId, wc);
    if (tab.webContentsId === webContentsId && attached.has(webContentsId)) {
      const tabs = yield* SynchronizedRef.get(tabsRef);
      const zoomFactor = resolveZoomFactorForWebContents(tabs, tabId, wc);
      yield* attempt({ operation: "registerWebview.restoreZoomFactor", tabId, webContentsId }, () =>
        wc.setZoomFactor(zoomFactor),
      );
      if (zoomFactor !== tab.zoomFactor) yield* update(tabId, { zoomFactor });
      yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () =>
        wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
      );
      return;
    }
    const replacedWebContentsId =
      tab.webContentsId != null && tab.webContentsId !== webContentsId ? tab.webContentsId : null;
    if (replacedWebContentsId !== null) {
      clearPendingRecording(tabId);
      yield* Effect.all(
        [
          closePictureInPicture(tabId),
          detachControlSession(replacedWebContentsId),
          detachListeners(replacedWebContentsId),
          cancelPickElement(tabId),
        ],
        { concurrency: 4, discard: true },
      );
    }
    const currentTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (
      !currentTab ||
      tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
      (yield* Ref.get(closingTabIdsRef)).has(tabId)
    ) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const zoomFactor = resolveZoomFactorForWebContents(
      yield* SynchronizedRef.get(tabsRef),
      tabId,
      wc,
    );
    yield* attempt({ operation: "registerWebview.restoreZoomFactor", tabId, webContentsId }, () =>
      wc.setZoomFactor(zoomFactor),
    );
    const registeredAt = yield* currentIso;
    yield* attachListeners(tabId, wc);
    const registration = yield* SynchronizedRef.modifyEffect(tabsRef, (tabs) =>
      Effect.gen(function* () {
        const current = tabs.get(tabId);
        if (
          !current ||
          tabLifecycleGenerations.get(tabId) !== expectedGeneration ||
          (yield* Ref.get(closingTabIdsRef)).has(tabId)
        ) {
          return [
            Option.none<{ readonly state: PreviewTabState; readonly pendingUrl: string | null }>(),
            tabs,
          ] as const;
        }
        const pendingUrl = current.navStatus.kind === "Loading" ? current.navStatus.url : null;
        const next: PreviewTabState = {
          ...current,
          webContentsId,
          navStatus: pendingUrl === null ? computeNavStatus(wc) : current.navStatus,
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          zoomFactor,
          updatedAt: registeredAt,
        };
        return [
          Option.some({
            state: next,
            pendingUrl,
          }),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, next);
          }),
        ] as const;
      }),
    );
    if (Option.isNone(registration)) {
      yield* Effect.all([detachControlSession(webContentsId), detachListeners(webContentsId)], {
        concurrency: 2,
        discard: true,
      });
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const { state: registered, pendingUrl } = registration.value;
    // Already holding the tab lifecycle lock — restore inline so guest swaps
    // cannot interleave, and so color-scheme re-apply finishes before return.
    yield* restoreControlSessionEffect(tabId, wc);
    yield* emit(tabId, registered);
    yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () =>
      wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
    );
    const latestNavStatus = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.navStatus;
    if (
      pendingUrl &&
      latestNavStatus?.kind === "Loading" &&
      latestNavStatus.url === pendingUrl &&
      wc.getURL() !== pendingUrl
    ) {
      runFork(
        attemptPromise({ operation: "registerWebview.loadPendingUrl", tabId, webContentsId }, () =>
          wc.loadURL(pendingUrl),
        ).pipe(Effect.ignore),
      );
    }
  });

  const registerWebview = Effect.fn("PreviewManager.registerWebview")(function* (
    tabId: string,
    webContentsId: number,
  ) {
    const expectedGeneration = tabLifecycleGenerations.get(tabId);
    return yield* withTabLifecycleLock(
      tabId,
      registerWebviewUnlocked(tabId, webContentsId, expectedGeneration),
    );
  });

  const navigate = Effect.fn("PreviewManager.navigate")(function* (tabId: string, rawUrl: string) {
    const url = yield* attempt({ operation: "navigate.normalizeUrl", tabId }, () =>
      normalizePreviewUrl(rawUrl),
    );
    const updatedAt = yield* currentIso;
    const pending = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      const next: PreviewTabState = {
        tabId,
        webContentsId: current?.webContentsId ?? null,
        navStatus: {
          kind: "Loading",
          url,
          title: current?.navStatus.kind === "Idle" || !current ? "" : current.navStatus.title,
        },
        canGoBack: current?.canGoBack ?? false,
        canGoForward: current?.canGoForward ?? false,
        zoomFactor: current?.zoomFactor ?? DEFAULT_ZOOM_FACTOR,
        pictureInPicture: current?.pictureInPicture ?? false,
        colorScheme: current?.colorScheme ?? "system",
        controller: current?.controller ?? "none",
        updatedAt,
      };
      return [
        next,
        replaceMap(tabs, (copy) => {
          copy.set(tabId, next);
        }),
      ] as const;
    });
    yield* emit(tabId, pending);
    if (pending.webContentsId == null) return;
    const wc = webContents.fromId(pending.webContentsId);
    if (!wc || wc.isDestroyed()) {
      yield* Effect.all(
        [
          detachControlSession(pending.webContentsId, wc),
          detachListeners(pending.webContentsId, wc),
        ],
        { concurrency: 2, discard: true },
      );
      const detached = { ...pending, webContentsId: null };
      yield* SynchronizedRef.update(tabsRef, (tabs) =>
        tabs.get(tabId)?.webContentsId !== pending.webContentsId
          ? tabs
          : replaceMap(tabs, (copy) => {
              copy.set(tabId, detached);
            }),
      );
      yield* emit(tabId, detached);
      return;
    }
    if (wc.getURL() === url) {
      yield* attempt({ operation: "navigate.reload", tabId, webContentsId: wc.id }, () =>
        wc.reload(),
      );
      return;
    }
    yield* attemptPromise({ operation: "navigate.loadURL", tabId, webContentsId: wc.id }, () =>
      wc.loadURL(url),
    );
  });

  const withWebContents = Effect.fn("PreviewManager.withWebContents")(function* (
    operation: string,
    tabId: string,
    use: (wc: Electron.WebContents) => void,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* attempt({ operation, tabId, webContentsId: wc.id }, () => use(wc));
  });

  const goBack = (tabId: string) =>
    withWebContents("goBack", tabId, (wc) => {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    });
  const goForward = (tabId: string) =>
    withWebContents("goForward", tabId, (wc) => {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    });
  const refresh = (tabId: string) => withWebContents("refresh", tabId, (wc) => wc.reload());
  const hardReload = (tabId: string) =>
    withWebContents("hardReload", tabId, (wc) => wc.reloadIgnoringCache());

  const openDevTools = Effect.fn("PreviewManager.openDevTools")(function* (tabId: string) {
    const wc = yield* requireWebContents(tabId);
    if (wc.isDevToolsOpened()) {
      yield* attempt({ operation: "openDevTools.focus", tabId, webContentsId: wc.id }, () =>
        wc.devToolsWebContents?.focus(),
      );
      return;
    }
    yield* detachControlSession(wc.id);
    yield* attempt({ operation: "openDevTools", tabId, webContentsId: wc.id }, () => {
      wc.once("devtools-closed", () => {
        if (!wc.isDestroyed()) runFork(restoreControlSession(tabId, wc));
      });
      wc.openDevTools({ mode: "detach" });
    });
  });

  const setAnnotationTheme = Effect.fn("PreviewManager.setAnnotationTheme")(function* (
    theme: DesktopPreviewAnnotationTheme,
  ) {
    yield* Ref.set(annotationThemeRef, theme);
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(
      tabs.values(),
      (tab) => {
        if (tab.webContentsId == null) return Effect.void;
        const wc = webContents.fromId(tab.webContentsId);
        return !wc || wc.isDestroyed()
          ? Effect.void
          : attempt(
              {
                operation: "setAnnotationTheme",
                tabId: tab.tabId,
                webContentsId: tab.webContentsId,
              },
              () => wc.send(ANNOTATION_THEME_CHANNEL, theme),
            ).pipe(Effect.ignore);
      },
      { discard: true },
    );
  });

  const pickElement = Effect.fn("PreviewManager.pickElement")(function* (tabId: string) {
    const wc = yield* requireWebContents(tabId);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    return yield* Effect.callback<PreviewAnnotationPayload | null, PreviewManagerError>(
      (resume) => {
        const session: PickSession = { cancel: Effect.suspend(() => cancelPickSession()) };
        const cleanup = Effect.fn("PreviewManager.cleanupPickElement")(function* () {
          yield* attempt({ operation: "pickElement.cleanup", tabId, webContentsId: wc.id }, () => {
            wc.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.off("destroyed", onDestroyed);
            wc.off("did-start-navigation", onNavigated);
          }).pipe(Effect.ignore);
          yield* Ref.update(pickSessionsRef, (sessions) =>
            sessions.get(tabId) === session
              ? replaceMap(sessions, (copy) => {
                  copy.delete(tabId);
                })
              : sessions,
          );
        });
        let settled = false;
        const claimSettle = (): boolean => {
          if (settled) return false;
          settled = true;
          return true;
        };
        const finishPick = Effect.fn("PreviewManager.finishPickElement")(function* (
          payload: PreviewAnnotationPayload | null,
        ) {
          yield* cleanup();
          resume(Effect.succeed(payload));
        });
        const settlePick = Effect.fn("PreviewManager.settlePickElement")(function* (
          payload: PreviewAnnotationPayload | null,
        ) {
          if (!claimSettle()) return;
          yield* finishPick(payload);
        });
        const settle = (payload: PreviewAnnotationPayload | null) => {
          runFork(settlePick(payload));
        };
        const cancelPickSession = Effect.fn("PreviewManager.cancelPickSession")(function* () {
          if (!claimSettle()) return;
          yield* cleanup();
          const tabs = yield* SynchronizedRef.get(tabsRef);
          const activeTab = tabs.get(tabId);
          if (activeTab?.webContentsId != null) {
            const activeWc = webContents.fromId(activeTab.webContentsId);
            if (activeWc && !activeWc.isDestroyed()) {
              yield* attempt(
                {
                  operation: "cancelPickElement",
                  tabId,
                  webContentsId: activeWc.id,
                },
                () => activeWc.send(CANCEL_PICK_CHANNEL),
              ).pipe(Effect.ignore);
            }
          }
          resume(Effect.succeed(null));
        });
        const onMessage = (_event: Electron.IpcMainEvent, ...args: unknown[]): void => {
          const payload = args[0];
          if (!isPreviewAnnotationPayload(payload)) {
            settle(null);
            return;
          }
          const cropRect = normalizeCaptureRect(args[1]);
          runFork(
            captureAnnotationScreenshot(
              tabId,
              wc,
              cropRect,
              capturePageWithRetry(
                {
                  operation: "captureAnnotationScreenshot",
                  tabId,
                  webContentsId: wc.id,
                },
                tabId,
                wc,
                cropRect
                  ? {
                      x: cropRect.x,
                      y: cropRect.y,
                      width: cropRect.width,
                      height: cropRect.height,
                    }
                  : undefined,
              ),
            ).pipe(
              Effect.match({
                onFailure: () => payload,
                onSuccess: (screenshot) =>
                  screenshot === null ? payload : { ...payload, screenshot },
              }),
              Effect.flatMap((result) => {
                if (!claimSettle()) return Effect.void;
                return attempt(
                  { operation: "pickElement.captureComplete", tabId, webContentsId: wc.id },
                  () => {
                    if (!wc.isDestroyed()) wc.send(ANNOTATION_CAPTURED_CHANNEL);
                  },
                ).pipe(Effect.ignore, Effect.andThen(finishPick(result)));
              }),
            ),
          );
        };
        const onDestroyed = () => settle(null);
        const onNavigated = (
          _event: Electron.Event,
          _url: string,
          _isInPlace: boolean,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame) settle(null);
        };
        const registerPickElement = Effect.fn("PreviewManager.registerPickElement")(function* () {
          const replaced = yield* Ref.modify(pickSessionsRef, (sessions) => [
            sessions.get(tabId) ?? null,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, session);
            }),
          ]);
          if (replaced) yield* replaced.cancel;
          if (settled) return;
          yield* attempt({ operation: "pickElement.register", tabId, webContentsId: wc.id }, () => {
            wc.ipc.on(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.once("destroyed", onDestroyed);
            wc.once("did-start-navigation", onNavigated);
            if (!wc.isFocused()) wc.focus();
            wc.send(START_PICK_CHANNEL, annotationTheme);
          });
        });
        runFork(
          registerPickElement().pipe(
            Effect.catch((error: PreviewManagerError) => {
              if (!claimSettle()) return Effect.void;
              resume(Effect.fail(error));
              return cleanup();
            }),
          ),
        );
        return session.cancel;
      },
    );
  });

  const applyZoom = Effect.fn("PreviewManager.applyZoom")(function* (
    tabId: string,
    transform: (current: number) => number,
  ) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    const tab = tabs.get(tabId);
    if (!tab) return;
    const wc = tab.webContentsId === null ? null : webContents.fromId(tab.webContentsId);
    const current = wc ? resolveZoomFactorForWebContents(tabs, tabId, wc) : tab.zoomFactor;
    const next = transform(current);
    if (Math.abs(next - current) < ZOOM_EPSILON) return;
    if (tab.webContentsId != null) {
      if (wc && !wc.isDestroyed()) {
        yield* attempt({ operation: "applyZoom", tabId, webContentsId: wc.id }, () =>
          wc.setZoomFactor(next),
        );
      }
    }
    const scopedTabIds = wc ? tabIdsInZoomScope(tabs, tabId, wc) : [tabId];
    yield* Effect.forEach(
      scopedTabIds,
      (scopedTabId) => update(scopedTabId, { zoomFactor: next }),
      {
        discard: true,
      },
    );
  });

  // Emulated media lives on the CDP debugger session, not the WebContents, so
  // it is lost whenever the session detaches (webview swap, DevTools
  // open/close) and must be re-applied after every (re)attach.
  const applyColorScheme = Effect.fn("PreviewManager.applyColorScheme")(function* (
    tabId: string,
    wc: Electron.WebContents,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    const control = yield* ensureControlSession(wc);
    yield* attemptPromise({ operation: "applyColorScheme", tabId, webContentsId: wc.id }, () =>
      control.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [
          {
            name: "prefers-color-scheme",
            // An empty value clears the override so the page follows the OS.
            value: colorScheme === "system" ? "" : colorScheme,
          },
        ],
      }),
    );
  });

  // Re-establish the control session after a detach, restoring any
  // color-scheme override the tab carries. Callers that are not already under
  // withTabLifecycleLock must use restoreControlSession (locked). Register
  // uses restoreControlSessionEffect while holding the lock. The scheme is read
  // after the session attaches so a concurrent setColorScheme is not overwritten
  // with a stale snapshot. Re-check webContents identity so a guest swap
  // mid-restore does not leave the debugger attached to a replaced contents.
  const restoreControlSessionEffect = (tabId: string, wc: Electron.WebContents) =>
    Effect.gen(function* () {
      const beforeAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (beforeAttach?.webContentsId !== wc.id) return;
      yield* ensureControlSession(wc);
      const afterAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (afterAttach?.webContentsId !== wc.id) {
        yield* detachControlSession(wc.id);
        return;
      }
      if (afterAttach.colorScheme !== "system") {
        yield* applyColorScheme(tabId, wc, afterAttach.colorScheme);
      }
    }).pipe(Effect.ignore);

  const restoreControlSession = (tabId: string, wc: Electron.WebContents) =>
    withTabLifecycleLock(tabId, restoreControlSessionEffect(tabId, wc));

  const setColorScheme = Effect.fn("PreviewManager.setColorScheme")(function* (
    tabId: string,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.colorScheme !== colorScheme) {
      // Record the choice even when the CDP call below can't run yet (no
      // webview, DevTools holding the debugger) — it is re-applied on the
      // next control-session (re)attach.
      yield* update(tabId, { colorScheme });
    }
    // Re-read after the update: registerWebview may have swapped the guest
    // in the meantime and the override must land on the current one.
    const webContentsId = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.webContentsId;
    if (webContentsId == null) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* applyColorScheme(tabId, wc, colorScheme);
  });

  const captureScreenshot = Effect.fn("PreviewManager.captureScreenshot")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);
    const [createdAt, millis, image] = yield* Effect.all([
      currentIso,
      currentMillis,
      capturePageWithRetry(
        {
          operation: "captureScreenshot.capturePage",
          tabId,
          webContentsId: wc.id,
        },
        tabId,
        wc,
      ),
    ]);
    const id = `browser-screenshot-${artifactSiteSlug(wc.getURL())}-${millis.toString(36)}`;
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.png`);
    const data = image.toPNG();
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "captureScreenshot.makeDirectory",
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "captureScreenshot.writeFile",
            tabId,
            webContentsId: wc.id,
            artifactPath,
            cause,
          }),
      ),
    );
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType: "image/png" as const,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const capturePreviewFrame = Effect.fn("PreviewManager.capturePreviewFrame")(function* (
    tabId: string,
  ) {
    const captureSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (!captureSession) return;
    const wc = yield* requireWebContents(tabId);
    const image = yield* capturePageWithRetry(
      {
        operation: "frameCapture.capturePage",
        tabId,
        webContentsId: wc.id,
      },
      tabId,
      wc,
    );
    const [captureSessions, tabs] = yield* Effect.all(
      [SynchronizedRef.get(frameCaptureSessionsRef), SynchronizedRef.get(tabsRef)],
      { concurrency: 2 },
    );
    const currentCaptureSession = captureSessions.get(tabId);
    if (
      currentCaptureSession?.scope !== captureSession.scope ||
      tabs.get(tabId)?.webContentsId !== wc.id ||
      wc.isDestroyed()
    ) {
      return;
    }
    const size = yield* attempt(
      {
        operation: "frameCapture.measureFrame",
        tabId,
        webContentsId: wc.id,
      },
      () => image.getSize(),
    );
    if (
      !Number.isFinite(size.width) ||
      !Number.isFinite(size.height) ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      return;
    }
    const frameScale = Math.min(
      1,
      RECORDING_MAX_FRAME_WIDTH / size.width,
      RECORDING_MAX_FRAME_HEIGHT / size.height,
    );
    const { frameSize, data } = yield* attempt(
      {
        operation: "frameCapture.encodeFrame",
        tabId,
        webContentsId: wc.id,
      },
      () => {
        const frameImage =
          frameScale < 1
            ? image.resize({
                width: Math.max(1, Math.round(size.width * frameScale)),
                height: Math.max(1, Math.round(size.height * frameScale)),
              })
            : image;
        return {
          frameSize: frameImage.getSize(),
          data: frameImage.toJPEG(RECORDING_JPEG_QUALITY).toString("base64"),
        };
      },
    );
    const receivedAt = yield* currentIso;
    const frame: DesktopPreviewRecordingFrame = {
      tabId,
      data,
      width: frameSize.width,
      height: frameSize.height,
      receivedAt,
    };
    const deliveries: Array<Effect.Effect<void>> = [];
    if (currentCaptureSession.consumers.has("picture-in-picture")) {
      const session = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
      if (session && !session.window.isDestroyed() && session.webContentsId === wc.id) {
        deliveries.push(
          Effect.gen(function* () {
            const live = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
            if (live !== session || session.window.isDestroyed()) return;

            const aspectRatio = frame.width / frame.height;
            const previousAspectRatio = session.aspectRatio;
            if (
              previousAspectRatio === undefined ||
              Math.abs(previousAspectRatio - aspectRatio) > PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON
            ) {
              yield* attempt(
                {
                  operation: "pictureInPicture.setAspectRatio",
                  tabId,
                  webContentsId: wc.id,
                },
                () => {
                  if (session.window.isDestroyed()) return;
                  const contentSize = fitPictureInPictureContentSize(
                    session.window.getContentSize(),
                    aspectRatio,
                  );
                  session.window.setAspectRatio(0);
                  session.window.setContentSize(contentSize[0], contentSize[1], false);
                  session.window.setAspectRatio(aspectRatio);
                },
              );
              // Bind ratio to this session object only while it remains current.
              if (
                (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId) === session
              ) {
                session.aspectRatio = aspectRatio;
              }
            }
            yield* attempt(
              {
                operation: "pictureInPicture.deliverFrame",
                tabId,
                webContentsId: wc.id,
              },
              () => {
                if (
                  session.window.isDestroyed() ||
                  // Session identity is checked again before send so a release
                  // mid-delivery cannot push frames into a closed window.
                  session.window.webContents.isDestroyed()
                ) {
                  return;
                }
                session.window.webContents.send("desktop:preview-pip-frame", frame);
              },
            );
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Picture-in-picture frame delivery failed.", { tabId, error }),
            ),
          ),
        );
      }
    }
    yield* Effect.all(deliveries, { concurrency: 2, discard: true });
  });

  const startFrameCapture = Effect.fn("PreviewManager.startFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) {
    const captureNextFrame = Effect.sleep(PICTURE_IN_PICTURE_FRAME_INTERVAL_MS).pipe(
      Effect.andThen(capturePreviewFrame(tabId)),
      Effect.catch((error) =>
        Effect.logWarning("Background preview frame capture failed.", {
          tabId,
          error,
        }),
      ),
    );
    const captureInitialFrame = yield* SynchronizedRef.modifyEffect(
      frameCaptureSessionsRef,
      (sessions) =>
        Effect.gen(function* () {
          if (!frameCaptureWindowOpen) {
            return yield* new PreviewMainWindowClosedError({ tabId });
          }
          const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          if (!tab || (yield* Ref.get(closingTabIdsRef)).has(tabId)) {
            return yield* new PreviewTabNotFoundError({ tabId });
          }
          const wc = yield* requireWebContents(tabId);
          const current = sessions.get(tabId);
          if (current) {
            if (current.consumers.has(consumer)) return [false, sessions] as const;
            if (!current.unthrottledWebContentsIds.has(wc.id)) {
              yield* setFrameCaptureWebContentsBackgroundThrottling(wc, false);
            }
            let scope = current.scope;
            if (consumer === "picture-in-picture" && scope === null) {
              scope = yield* Scope.fork(parentScope, "sequential");
              yield* Effect.forkIn(Effect.forever(captureNextFrame), scope);
            }
            return [
              consumer === "picture-in-picture",
              replaceMap(sessions, (copy) => {
                copy.set(tabId, {
                  ...current,
                  scope,
                  consumers: new Set([...current.consumers, consumer]),
                  unthrottledWebContentsIds: new Set([...current.unthrottledWebContentsIds, wc.id]),
                });
              }),
            ] as const;
          }
          if (sessions.size === 0) {
            yield* setFrameCaptureBackgroundThrottling(false);
          }
          yield* setFrameCaptureWebContentsBackgroundThrottling(wc, false).pipe(
            Effect.onError(() =>
              sessions.size === 0
                ? setFrameCaptureBackgroundThrottling(true).pipe(Effect.ignore)
                : Effect.void,
            ),
          );
          const scope =
            consumer === "picture-in-picture" ? yield* Scope.fork(parentScope, "sequential") : null;
          if (scope !== null) {
            yield* Effect.forkIn(Effect.forever(captureNextFrame), scope);
          }
          return [
            consumer === "picture-in-picture",
            replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                scope,
                consumers: new Set([consumer]),
                unthrottledWebContentsIds: new Set([wc.id]),
              });
            }),
          ] as const;
        }),
    ).pipe(Effect.uninterruptible);
    if (!captureInitialFrame) return;
    yield* capturePreviewFrame(tabId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Initial background preview frame was not ready; capture will retry.", {
          tabId,
          consumer,
          error,
        }),
      ),
    );
  });

  const releasePictureInPicture = Effect.fn("PreviewManager.releasePictureInPicture")(function* (
    tabId: string,
    expected: PictureInPictureSession,
    closeWindow: boolean,
  ) {
    const removed = yield* SynchronizedRef.modify(pictureInPictureSessionsRef, (sessions) => {
      if (sessions.get(tabId) !== expected) return [false, sessions] as const;
      return [
        true,
        replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        }),
      ] as const;
    });
    if (!removed) return;
    yield* Deferred.interrupt(expected.ready);
    yield* Scope.close(expected.initializationScope, Exit.void).pipe(Effect.ignore);
    yield* stopFrameCapture(tabId, "picture-in-picture");
    if ((yield* SynchronizedRef.get(tabsRef)).has(tabId)) {
      yield* update(tabId, { pictureInPicture: false });
    }
    if (closeWindow && !expected.window.isDestroyed()) {
      yield* attempt({ operation: "pictureInPicture.close", tabId }, () =>
        expected.window.close(),
      ).pipe(Effect.ignore);
    }
  });

  const closePictureInPicture = Effect.fn("PreviewManager.closePictureInPicture")(function* (
    tabId: string,
  ) {
    yield* pictureInPictureMutationSemaphore.withPermit(
      Effect.gen(function* () {
        const session = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
        if (!session) {
          yield* stopFrameCapture(tabId, "picture-in-picture");
          if ((yield* SynchronizedRef.get(tabsRef)).has(tabId)) {
            yield* update(tabId, { pictureInPicture: false });
          }
          return;
        }
        yield* releasePictureInPicture(tabId, session, true);
      }),
    );
  });

  const closeAllPictureInPicture = Effect.fn("PreviewManager.closeAllPictureInPicture")(
    function* () {
      const sessions = yield* SynchronizedRef.get(pictureInPictureSessionsRef);
      yield* Effect.forEach(sessions.keys(), closePictureInPicture, {
        concurrency: "unbounded",
        discard: true,
      });
    },
  );

  const openPictureInPicture = Effect.fn("PreviewManager.openPictureInPicture")(function* (
    tabId: string,
  ) {
    const claim = yield* withTabLifecycleLock(
      tabId,
      pictureInPictureMutationSemaphore.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const existing = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
            if (existing && !existing.window.isDestroyed()) {
              return { kind: "existing" as const, session: existing };
            }
            if (existing) yield* releasePictureInPicture(tabId, existing, false);
            const wc = yield* requireWebContents(tabId);
            const title = yield* attempt(
              { operation: "pictureInPicture.readTitle", tabId, webContentsId: wc.id },
              () => wc.getTitle().trim(),
            );
            const window = yield* attempt(
              { operation: "pictureInPicture.create", tabId, webContentsId: wc.id },
              () =>
                new BrowserWindow({
                  width: PICTURE_IN_PICTURE_INITIAL_WIDTH,
                  height: PICTURE_IN_PICTURE_INITIAL_HEIGHT,
                  minWidth: PICTURE_IN_PICTURE_MIN_WIDTH,
                  minHeight: PICTURE_IN_PICTURE_MIN_HEIGHT,
                  title: title ? `Preview · ${title}` : "Browser preview",
                  show: false,
                  alwaysOnTop: true,
                  autoHideMenuBar: true,
                  fullscreenable: false,
                  maximizable: false,
                  minimizable: false,
                  resizable: true,
                  skipTaskbar: true,
                  backgroundColor: "#111111",
                  ...(hostPlatform === "darwin" ? { type: "panel" as const } : {}),
                  webPreferences: {
                    preload: `${__dirname}/preview-pip-preload.cjs`,
                    backgroundThrottling: false,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                  },
                }),
            );
            const initializationScope = yield* Scope.fork(parentScope, "sequential");
            const ready = yield* Deferred.make<void, PreviewManagerError>();
            const session: PictureInPictureSession = {
              window,
              webContentsId: wc.id,
              ready,
              initializationScope,
              aspectRatio: undefined,
            };
            yield* attempt(
              { operation: "pictureInPicture.configure", tabId, webContentsId: wc.id },
              () => {
                window.once("closed", () => {
                  runFork(
                    pictureInPictureMutationSemaphore.withPermit(
                      releasePictureInPicture(tabId, session, false),
                    ),
                  );
                });
                if (hostPlatform === "darwin") {
                  window.setVisibleOnAllWorkspaces(true, {
                    visibleOnFullScreen: true,
                    skipTransformProcessType: true,
                  });
                }
              },
            ).pipe(
              Effect.onError(() =>
                Effect.all(
                  [
                    Scope.close(initializationScope, Exit.void).pipe(Effect.ignore),
                    attempt({ operation: "pictureInPicture.close", tabId }, () =>
                      window.close(),
                    ).pipe(Effect.ignore),
                  ],
                  { discard: true },
                ),
              ),
            );
            yield* SynchronizedRef.update(pictureInPictureSessionsRef, (sessions) =>
              replaceMap(sessions, (copy) => {
                copy.set(tabId, session);
              }),
            );
            return { kind: "created" as const, session };
          }),
        ),
      ),
    );
    const session = claim.session;
    if (claim.kind === "existing") {
      yield* Deferred.await(session.ready);
      return yield* withTabLifecycleLock(
        tabId,
        pictureInPictureMutationSemaphore.withPermit(
          Effect.gen(function* () {
            const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
            if (current !== session || session.window.isDestroyed()) {
              return yield* new PreviewOperationError({
                operation: "pictureInPicture.showExisting",
                tabId,
                webContentsId: session.webContentsId,
                cause: new Error("Picture-in-picture session closed before it became visible."),
              });
            }
            yield* attempt(
              {
                operation: "pictureInPicture.showExisting",
                tabId,
                webContentsId: session.webContentsId,
              },
              () => session.window.showInactive(),
            );
          }),
        ),
      );
    }

    const initialize = Effect.gen(function* () {
      yield* attemptPromise(
        {
          operation: "pictureInPicture.load",
          tabId,
          webContentsId: session.webContentsId,
        },
        () => session.window.loadURL(buildPreviewPictureInPictureDataUrl()),
      );
      const current = yield* requireWebContents(tabId);
      if (current.id !== session.webContentsId || current.isDestroyed()) {
        return yield* new PreviewOperationError({
          operation: "pictureInPicture.validateWebContents",
          tabId,
          webContentsId: session.webContentsId,
          cause: new Error("Preview webview changed while picture-in-picture was opening."),
        });
      }
      return yield* withTabLifecycleLock(
        tabId,
        Effect.gen(function* () {
          const currentWebContents = yield* requireWebContents(tabId);
          if (currentWebContents.id !== session.webContentsId || currentWebContents.isDestroyed()) {
            return yield* new PreviewOperationError({
              operation: "pictureInPicture.validateWebContents",
              tabId,
              webContentsId: session.webContentsId,
              cause: new Error("Preview webview changed while picture-in-picture was opening."),
            });
          }
          yield* startFrameCapture(tabId, "picture-in-picture");
          yield* pictureInPictureMutationSemaphore.withPermit(
            Effect.gen(function* () {
              const published = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(
                tabId,
              );
              if (published !== session || session.window.isDestroyed()) {
                return yield* new PreviewOperationError({
                  operation: "pictureInPicture.show",
                  tabId,
                  webContentsId: session.webContentsId,
                  cause: new Error("Picture-in-picture session closed before it became visible."),
                });
              }
              yield* attempt(
                { operation: "pictureInPicture.show", tabId, webContentsId: session.webContentsId },
                () => session.window.showInactive(),
              );
              yield* update(tabId, { pictureInPicture: true });
            }),
          );
        }),
      );
    });
    const awaitInitialization = Effect.gen(function* () {
      const initializationFiber = yield* Effect.forkIn(initialize, session.initializationScope);
      return yield* Fiber.await(initializationFiber);
    });
    const finalizeInitialization = (initializationExit: Exit.Exit<void, PreviewManagerError>) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (Exit.isSuccess(initializationExit)) {
            const published = yield* pictureInPictureMutationSemaphore.withPermit(
              Effect.gen(function* () {
                const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(
                  tabId,
                );
                if (current !== session || session.window.isDestroyed()) {
                  if (current === session) {
                    yield* releasePictureInPicture(tabId, session, false);
                  }
                  return false;
                }
                yield* Deferred.done(session.ready, initializationExit);
                return true;
              }),
            );
            if (published) return;
            return yield* Deferred.await(session.ready);
          }
          yield* Deferred.done(session.ready, initializationExit);
          const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
          if (current === session) {
            yield* pictureInPictureMutationSemaphore.withPermit(
              releasePictureInPicture(tabId, session, true),
            );
          }
          return yield* Effect.failCause(initializationExit.cause);
        }),
      );
    return yield* Effect.uninterruptibleMask((restore) =>
      restore(awaitInitialization).pipe(
        Effect.flatMap(finalizeInitialization),
        Effect.onInterrupt(() =>
          pictureInPictureMutationSemaphore.withPermit(
            releasePictureInPicture(tabId, session, true),
          ),
        ),
      ),
    );
  });

  const clearPendingRecording = (tabId: string) => {
    if (pendingRecording?.tabId === tabId) pendingRecording = null;
  };

  const armPendingRecording = Effect.fn("PreviewManager.armPendingRecording")(function* (
    tabId: string,
    wc: Electron.WebContents,
    requestingFrameTreeNodeId: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const previous = pendingRecording;
    if (
      previous !== null &&
      previous.tabId !== tabId &&
      !previous.webContents.isDestroyed() &&
      now - previous.armedAtMillis < RECORDING_ARM_GRACE_MS
    ) {
      return yield* new PreviewRecordingArmConflictError({
        tabId,
        webContentsId: wc.id,
        armedTabId: previous.tabId,
      });
    }
    const armed: PendingRecording = {
      tabId,
      webContents: wc,
      requestingFrameTreeNodeId,
      armedAtMillis: now,
    };
    pendingRecording = armed;
    yield* Effect.forkIn(
      Effect.sleep(RECORDING_ARM_GRACE_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (pendingRecording === armed) pendingRecording = null;
          }),
        ),
      ),
      parentScope,
    );
  });

  const installDisplayMediaRequestHandler = (session: Session) => {
    if (displayMediaHandlerSessions.has(session)) return;
    displayMediaHandlerSessions.add(session);
    session.setDisplayMediaRequestHandler((request, callback) => {
      const armed = pendingRecording;
      if (!armed) {
        callback({});
        return;
      }
      if (armed.webContents.isDestroyed()) {
        pendingRecording = null;
        callback({});
        return;
      }
      if (request.frame?.frameTreeNodeId !== armed.requestingFrameTreeNodeId) {
        callback({});
        return;
      }
      pendingRecording = null;
      callback({ video: armed.webContents.mainFrame });
    });
  };

  const startRecording = Effect.fn("PreviewManager.startRecording")(function* (tabId: string) {
    if ((yield* Ref.get(closingTabIdsRef)).has(tabId)) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    return yield* withTabLifecycleLock(
      tabId,
      Effect.gen(function* () {
        yield* startFrameCapture(tabId, "recording");
        const wc = yield* requireWebContents(tabId);
        const requestWebContents = wc.hostWebContents;
        if (requestWebContents === null) {
          return yield* new PreviewMainWindowClosedError({ tabId });
        }
        yield* capturePageWithRetry(
          {
            operation: "recording.warmSource",
            tabId,
            webContentsId: wc.id,
          },
          tabId,
          wc,
          undefined,
          2,
          0,
        ).pipe(Effect.asVoid, Effect.ignore);
        const currentWebContents = yield* requireWebContents(tabId);
        if (currentWebContents !== wc || wc.isDestroyed()) {
          return yield* new PreviewWebContentsNotFoundError({
            tabId,
            webContentsId: wc.id,
          });
        }
        if (!frameCaptureWindowOpen || requestWebContents.isDestroyed()) {
          return yield* new PreviewMainWindowClosedError({ tabId });
        }
        installDisplayMediaRequestHandler(requestWebContents.session);
        yield* armPendingRecording(tabId, wc, requestWebContents.mainFrame.frameTreeNodeId);
        const captureRequested = yield* attemptPromise(
          {
            operation: "recording.requestCapture",
            tabId,
            webContentsId: requestWebContents.id,
          },
          () =>
            requestWebContents.executeJavaScript(requestRecordingCaptureExpression(tabId), true),
        );
        if (captureRequested !== true) {
          return yield* new PreviewRecordingCaptureUnavailableError({
            tabId,
            webContentsId: requestWebContents.id,
          });
        }
      }).pipe(
        Effect.onError(() => {
          clearPendingRecording(tabId);
          return stopFrameCapture(tabId, "recording").pipe(Effect.ignore);
        }),
      ),
    );
  });

  const stopRecording = Effect.fn("PreviewManager.stopRecording")(function* (tabId: string) {
    yield* withTabLifecycleLock(
      tabId,
      Effect.suspend(() => {
        clearPendingRecording(tabId);
        return stopFrameCapture(tabId, "recording");
      }),
    );
  });

  const saveRecording = Effect.fn("PreviewManager.saveRecording")(function* (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    const [createdAt, millis] = yield* Effect.all([currentIso, currentMillis]);
    const id = `browser-recording-${millis.toString(36)}`;
    const extension = recordingFileExtension(mimeType);
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.${extension}`);
    yield* fileSystem.makeDirectory(resolvedArtifactDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "saveRecording.makeDirectory",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(artifactPath, data).pipe(
      Effect.mapError(
        (cause) =>
          new PreviewOperationError({
            operation: "saveRecording.writeFile",
            tabId,
            artifactPath,
            cause,
          }),
      ),
    );
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const automationStatus = Effect.fn("PreviewManager.automationStatus")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) {
      const navStatus = tab?.navStatus;
      return {
        available: false,
        visible: true,
        tabId,
        url: !navStatus || navStatus.kind === "Idle" ? null : navStatus.url,
        title: !navStatus || navStatus.kind === "Idle" ? null : navStatus.title,
        loading: navStatus?.kind === "Loading",
      };
    }
    const wc = webContents.fromId(tab.webContentsId);
    return !wc || wc.isDestroyed()
      ? {
          available: false,
          visible: true,
          tabId,
          url: null,
          title: null,
          loading: false,
        }
      : {
          available: true,
          visible: true,
          tabId,
          url: wc.getURL() || null,
          title: wc.getTitle() || null,
          loading: wc.isLoading(),
        };
  });

  const collectInteractiveElementsScript = (
    maxElements: number,
    maxVisibleText: number,
  ) => `(() => {
          const selectorFor = (element) => {
            if (element.id) return "#" + CSS.escape(element.id);
            for (const attribute of ["data-testid", "name"]) {
              const value = element.getAttribute(attribute);
              if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
            }
            const buildParts = (current, parts = []) => {
              if (!current || current.nodeType !== Node.ELEMENT_NODE || parts.length >= 8) {
                return parts;
              }
              const parent = current.parentElement;
              const siblings = parent
                ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
                : [];
              const base = current.tagName.toLowerCase();
              const part = siblings.length > 1
                ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")"
                : base;
              return buildParts(parent, [part, ...parts]);
            };
            return buildParts(element).join(" > ");
          };
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const elements = Array.from(document.querySelectorAll(
            "a[href],button,input,textarea,select,[role],[tabindex]"
          )).filter(visible).slice(0, ${maxElements}).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              name: element.getAttribute("aria-label") || element.innerText || element.getAttribute("name") || "",
              selector: selectorFor(element),
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            };
          });
          return {
            url: location.href,
            title: document.title,
            loading: document.readyState !== "complete",
            visibleText: (document.body?.innerText || "").slice(0, ${maxVisibleText}),
            interactiveElements: elements
          };
        })()`;

  const collectLocatorCandidates = Effect.fn("PreviewManager.collectLocatorCandidates")(function* (
    tabId: string,
    send: SendCommand,
  ) {
    const page = yield* evaluateWithDebugger<{
      interactiveElements: PreviewAutomationSnapshot["interactiveElements"];
    }>(tabId, send, collectInteractiveElementsScript(40, 0), true).pipe(
      Effect.catch(() => Effect.succeed({ interactiveElements: [] })),
    );
    return candidateLocatorsFromElements(page.interactiveElements);
  });

  const captureAutomationSnapshot = Effect.fn("PreviewManager.captureAutomationSnapshot")(
    function* (
      tabId: string,
      wc: Electron.WebContents,
      send: SendCommand,
      input?: PreviewAutomationSnapshotInput,
    ) {
      const budgets = resolveSnapshotBudgets(input ?? {});
      // Capture a bit more raw content than the final budget so host-side filters
      // still have material to prioritize (console/network modes).
      const captureMaxElements = Math.min(
        MAX_INTERACTIVE_ELEMENTS,
        Math.max(budgets.maxInteractiveElements, 40),
      );
      const captureMaxText = Math.min(
        MAX_VISIBLE_TEXT_LENGTH,
        Math.max(budgets.maxVisibleText, 2_000),
      );
      const captureMaxScreenshotEdge = Math.min(Math.max(1, budgets.maxScreenshotEdge), 3840);

      yield* Effect.all(
        [
          send("Runtime.enable"),
          send("Page.enable"),
          ...(budgets.includeAccessibilityTree ? [send("Accessibility.enable")] : []),
        ],
        {
          concurrency: 2,
          discard: true,
        },
      );
      const page = yield* evaluateWithDebugger<{
        url: string;
        title: string;
        loading: boolean;
        visibleText: string;
        interactiveElements: PreviewAutomationSnapshot["interactiveElements"];
      }>(tabId, send, collectInteractiveElementsScript(captureMaxElements, captureMaxText), true);

      const [accessibility, screenshotCapture, diagnostics, timelines] = yield* Effect.all(
        [
          budgets.includeAccessibilityTree
            ? send("Accessibility.getFullAXTree")
            : Effect.succeed(null),
          captureAutomationScreenshotWithRetry(tabId, wc, send).pipe(
            Effect.map(
              (
                image,
              ): {
                readonly image: Electron.NativeImage | null;
                readonly failure: PreviewAutomationScreenshotCaptureFailure | null;
              } => ({ image, failure: null }),
            ),
            Effect.catchTag("PreviewOperationError", () =>
              Effect.succeed({
                image: null,
                failure: SCREENSHOT_CAPTURE_FAILURE,
              }),
            ),
          ),
          Ref.get(diagnosticsRef),
          Ref.get(actionTimelineRef),
        ],
        { concurrency: 4 },
      );
      const { image: sourceImage, failure: screenshotCaptureFailure } = screenshotCapture;
      const sourceSize = sourceImage?.getSize();
      const longestEdge = sourceSize ? Math.max(sourceSize.width, sourceSize.height) : 0;
      const image =
        sourceImage && sourceSize
          ? longestEdge > captureMaxScreenshotEdge
            ? sourceSize.width >= sourceSize.height
              ? sourceImage.resize({ width: captureMaxScreenshotEdge })
              : sourceImage.resize({ height: captureMaxScreenshotEdge })
            : sourceImage
          : null;
      const size = image?.getSize() ?? { width: 0, height: 0 };
      const browserDiagnostics = diagnostics.get(wc.id);
      const raw: PreviewAutomationSnapshot = {
        ...page,
        accessibilityTree: accessibility,
        consoleEntries: [...(browserDiagnostics?.consoleEntries ?? [])],
        networkEntries: [...(browserDiagnostics?.networkEntries ?? [])],
        actionTimeline: [...(timelines.get(tabId) ?? [])],
        screenshot: {
          mimeType: "image/png" as const,
          data: image?.toPNG().toString("base64") ?? "",
          width: size.width,
          height: size.height,
        },
        ...(screenshotCaptureFailure ? { screenshotCaptureFailure } : {}),
      };
      return applySnapshotBudgets(raw, budgets);
    },
  );

  const automationSnapshot = Effect.fn("PreviewManager.automationSnapshot")(function* (
    tabId: string,
    input?: PreviewAutomationSnapshotInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    return yield* withControlSession(tabId, wc, "snapshot", (send) =>
      captureAutomationSnapshot(tabId, wc, send, input),
    );
  });

  const resolveClickPoint = Effect.fn("PreviewManager.resolveClickPoint")(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationClickInput,
  ) {
    if (!("selector" in input) && !("locator" in input)) {
      return { x: input.x!, y: input.y! };
    }
    const locator = automationLocator(input)!;
    yield* ensurePlaywrightInjected(tabId, send);
    const locatorJson = yield* encodeJson(
      { operation: "automationClick.encodeLocator", tabId },
      locator,
    );
    const point = yield* evaluateWithDebugger<
      { x: number; y: number } | { invalidSelector: true; message: string } | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
          try {
            const injected = globalThis.__t3PlaywrightInjected;
            const parsed = injected.parseSelector(${locatorJson});
            const element = injected.querySelector(parsed, document, true);
            if (!element) return { notFound: true };
            const visible = injected.elementState(element, "visible");
            const enabled = injected.elementState(element, "enabled");
            if (!visible.matches || !enabled.matches) return { notFound: true };
            element.scrollIntoView({ block: "center", inline: "center" });
            const rect = element.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      true,
    );
    if ("invalidSelector" in point) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "click",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: point.message.length,
        cause: point,
      });
    }
    if ("notFound" in point) {
      const candidateLocators = yield* collectLocatorCandidates(tabId, send);
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "click",
        tabId,
        ...automationSelectorDiagnostics(input),
        ...(candidateLocators.length > 0 ? { candidateLocators } : {}),
      });
    }
    return point;
  });

  const emitPointerEvent = Effect.fn("PreviewManager.emitPointerEvent")(function* (
    event: DesktopPreviewPointerEvent,
  ) {
    const listeners = yield* Ref.get(pointerEventListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("pointer-event", event.tabId, () => listener(event)),
      { discard: true },
    );
  });

  const performAutomationClick = Effect.fn("PreviewManager.performAutomationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
    send: SendCommand,
  ) {
    yield* prepareAutomationInput(send, true);
    const point = yield* resolveClickPoint(tabId, send, input);
    const viewport = yield* evaluateWithDebugger<{ width: number; height: number }>(
      tabId,
      send,
      "({ width: window.innerWidth, height: window.innerHeight })",
      true,
    );
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
      return yield* new PreviewAutomationCoordinatesOutsideViewportError({
        tabId,
        x: point.x,
        y: point.y,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
    }
    const moveSequence = yield* nextCounter(pointerSequenceRef);
    const moveCreatedAt = yield* currentIso;
    yield* emitPointerEvent({
      tabId,
      phase: "move",
      ...point,
      sequence: moveSequence,
      createdAt: moveCreatedAt,
    });
    yield* Effect.sleep(AGENT_CURSOR_MOVE_MS);
    const clickSequence = yield* nextCounter(pointerSequenceRef);
    const clickCreatedAt = yield* currentIso;
    yield* emitPointerEvent({
      tabId,
      phase: "click",
      ...point,
      sequence: clickSequence,
      createdAt: clickCreatedAt,
    });
    yield* Effect.sleep(AGENT_CURSOR_CLICK_LEAD_MS);
    yield* expectAgentInput(tabId, { kind: "pointer", ...point, button: 0 });
    yield* send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    yield* send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
  });

  const automationClick = Effect.fn("PreviewManager.automationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "click", (send) =>
      performAutomationClick(tabId, input, send),
    );
  });

  const typeIntoAutomationTarget = Effect.fn("PreviewManager.typeIntoAutomationTarget")(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationTypeInput,
  ) {
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(tabId, send);
    const locatorJson = locator
      ? yield* encodeJson({ operation: "automationType.encodeLocator", tabId }, locator)
      : null;
    const textJson = yield* encodeJson(
      { operation: "automationType.encodeText", tabId },
      input.text,
    );
    const result = yield* evaluateWithDebugger<
      | { ok: true }
      | { invalidSelector: true; message: string }
      | { notEditable: true }
      | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
          try {
            const element = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "document.activeElement"};
            if (!element) return { notFound: true };
            const textControl =
              element instanceof HTMLTextAreaElement ||
              (element instanceof HTMLInputElement &&
                !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]).has(element.type));
            const editable = textControl || element.isContentEditable;
            if (!editable || element.disabled || element.readOnly) return { notEditable: true };
            element.focus();
            if (document.activeElement !== element) return { notEditable: true };
            const clear = ${input.clear ?? false};
            if (clear) {
              if (textControl) {
                element.select();
              } else {
                const range = document.createRange();
                range.selectNodeContents(element);
                const selection = document.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
              }
            }
            const text = ${textJson};
            let inserted = true;
            if (text.length > 0) {
              inserted = document.execCommand("insertText", false, text);
            } else if (clear) {
              document.execCommand("delete", false);
              const cleared = textControl
                ? element.value.length === 0
                : (element.textContent ?? "").length === 0;
              if (!cleared) {
                if (textControl) {
                  const prototype = element instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
                  if (valueSetter) valueSetter.call(element, "");
                  else element.value = "";
                } else {
                  element.replaceChildren();
                }
                element.dispatchEvent(new InputEvent("input", {
                  bubbles: true,
                  inputType: "deleteContentBackward",
                }));
              }
            }
            if (!inserted) return { notEditable: true };
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      true,
    );
    if ("invalidSelector" in result) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "type",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      });
    }
    if ("notFound" in result) {
      const candidateLocators = yield* collectLocatorCandidates(tabId, send);
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "type",
        tabId,
        ...automationSelectorDiagnostics(input),
        ...(candidateLocators.length > 0 ? { candidateLocators } : {}),
      });
    }
    if ("notEditable" in result) {
      const candidateLocators = yield* collectLocatorCandidates(tabId, send);
      return yield* new PreviewAutomationTargetNotEditableError({
        tabId,
        ...automationSelectorDiagnostics(input),
        ...(candidateLocators.length > 0 ? { candidateLocators } : {}),
      });
    }
  });

  const performAutomationType = Effect.fn("PreviewManager.performAutomationType")(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
    send: SendCommand,
  ) {
    // CDP Input.insertText silently drops text until Electron has activated a hidden
    // guest WebContents with a pointer event. Editing in the page runtime keeps
    // background automation deterministic without stealing foreground app focus.
    yield* typeIntoAutomationTarget(tabId, send, input);
  });

  const automationType = Effect.fn("PreviewManager.automationType")(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "type", (send) =>
      performAutomationType(tabId, input, send),
    );
  });

  const performAutomationPress = Effect.fn("PreviewManager.performAutomationPress")(function* (
    tabId: string,
    wc: Electron.WebContents,
    input: PreviewAutomationPressInput,
    send: SendCommand,
    sendCleanup: SendCommand,
  ) {
    yield* prepareAutomationInput(send, false);
    const keySequence = makePreviewAutomationKeySequence(input, {
      isMac: hostPlatform === "darwin",
    });
    const previouslyFocused = yield* attempt(
      { operation: "automationPress.getFocusedWebContents", tabId, webContentsId: wc.id },
      () => webContents.getFocusedWebContents(),
    );
    let keyDownAttempted = false;
    const releaseInput = Effect.gen(function* () {
      if (keyDownAttempted) {
        yield* sendCleanup("Input.dispatchKeyEvent", keySequence.keyUp).pipe(Effect.ignore);
      }
      yield* sendCleanup("Emulation.setFocusEmulationEnabled", { enabled: false }).pipe(
        Effect.ignore,
      );
      if (previouslyFocused && previouslyFocused.id !== wc.id && !previouslyFocused.isDestroyed()) {
        yield* attempt(
          {
            operation: "automationPress.restoreFocusedWebContents",
            tabId,
            webContentsId: previouslyFocused.id,
          },
          () => previouslyFocused.focus(),
        ).pipe(Effect.ignore);
      }
    });

    // Focus the guest WebContents itself, not its containing BrowserWindow. This
    // activates native keyboard behavior for hidden/background previews without
    // changing which thread is mounted in the UI. Restore the previous renderer
    // after dispatch so automation never leaves the app's input focus behind.
    yield* Effect.gen(function* () {
      yield* attempt(
        { operation: "automationPress.focusWebContents", tabId, webContentsId: wc.id },
        () => wc.focus(),
      );
      yield* send("Page.bringToFront");
      yield* send("Emulation.setFocusEmulationEnabled", { enabled: true });
      yield* expectAgentInput(tabId, keySequence.signal);
      keyDownAttempted = true;
      yield* send("Input.dispatchKeyEvent", keySequence.keyDown);
    }).pipe(Effect.ensuring(releaseInput));
  });

  const automationPress = Effect.fn("PreviewManager.automationPress")(function* (
    tabId: string,
    input: PreviewAutomationPressInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "press", (send, sendCleanup) =>
      performAutomationPress(tabId, wc, input, send, sendCleanup),
    );
  });

  const performAutomationScroll = Effect.fn("PreviewManager.performAutomationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
    send: SendCommand,
  ) {
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(tabId, send);
    const locatorJson = locator
      ? yield* encodeJson({ operation: "automationScroll.encodeLocator", tabId }, locator)
      : null;
    const result = yield* evaluateWithDebugger<
      { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
        try {
          const target = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "window"};
          if (!target) return { notFound: true };
          target.scrollBy({ left: ${input.deltaX ?? 0}, top: ${input.deltaY ?? 0}, behavior: "instant" });
          return { ok: true };
        } catch (error) {
          return { invalidSelector: true, message: String(error) };
        }
      })()`,
      true,
    );
    if ("invalidSelector" in result) {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: "scroll",
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      });
    }
    if ("notFound" in result) {
      const candidateLocators = yield* collectLocatorCandidates(tabId, send);
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "scroll",
        tabId,
        ...automationSelectorDiagnostics(input),
        ...(candidateLocators.length > 0 ? { candidateLocators } : {}),
      });
    }
  });

  const automationScroll = Effect.fn("PreviewManager.automationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "scroll", (send) =>
      performAutomationScroll(tabId, input, send),
    );
  });

  const performAutomationEvaluate = Effect.fn("PreviewManager.performAutomationEvaluate")(
    function* (tabId: string, input: PreviewAutomationEvaluateInput, send: SendCommand) {
      yield* send("Runtime.enable");
      const value = yield* evaluateWithDebugger(
        tabId,
        send,
        input.expression,
        input.returnByValue ?? true,
        input.awaitPromise ?? true,
      );
      const serialized = yield* encodeJson(
        { operation: "automationEvaluate.encodeResult", tabId },
        value,
      );
      const actualBytes = Buffer.byteLength(serialized, "utf8");
      if (actualBytes > MAX_EVALUATION_BYTES) {
        return yield* new PreviewAutomationResultTooLargeError({
          tabId,
          actualBytes,
          maximumBytes: MAX_EVALUATION_BYTES,
        });
      }
      return value;
    },
  );

  const automationEvaluate = Effect.fn("PreviewManager.automationEvaluate")(function* (
    tabId: string,
    input: PreviewAutomationEvaluateInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    return yield* withControlSession(tabId, wc, "evaluate", (send) =>
      performAutomationEvaluate(tabId, input, send),
    );
  });

  const performAutomationWaitFor = Effect.fn("PreviewManager.performAutomationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
    send: SendCommand,
  ) {
    const timeoutMs = input.timeoutMs ?? 15_000;
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(tabId, send);
    const [locatorJson, textJson, urlIncludesJson] = yield* Effect.all([
      locator
        ? encodeJson({ operation: "automationWaitFor.encodeLocator", tabId }, locator)
        : Effect.succeed(null),
      input.text
        ? encodeJson({ operation: "automationWaitFor.encodeText", tabId }, input.text)
        : Effect.succeed(null),
      input.urlIncludes
        ? encodeJson({ operation: "automationWaitFor.encodeUrl", tabId }, input.urlIncludes)
        : Effect.succeed(null),
    ]);
    const deadline = (yield* currentMillis) + timeoutMs;
    while ((yield* currentMillis) <= deadline) {
      const result = yield* evaluateWithDebugger<
        { matched: boolean } | { invalidSelector: true; message: string }
      >(
        tabId,
        send,
        `(() => {
              try {
                const selectorMatched = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, false) !== null; })()` : "true"};
                const textMatched = ${
                  textJson ? `(document.body?.innerText || "").includes(${textJson})` : "true"
                };
                const urlMatched = ${
                  urlIncludesJson ? `location.href.includes(${urlIncludesJson})` : "true"
                };
                return { matched: selectorMatched && textMatched && urlMatched };
              } catch (error) {
                return { invalidSelector: true, message: String(error) };
              }
            })()`,
        true,
      );
      if ("invalidSelector" in result) {
        return yield* new PreviewAutomationInvalidSelectorError({
          operation: "waitFor",
          tabId,
          ...automationSelectorDiagnostics(input),
          reasonLength: result.message.length,
          cause: result,
        });
      }
      if (result.matched) return;
      yield* Effect.sleep(100);
    }
    return yield* new PreviewAutomationTimeoutError({
      tabId,
      timeoutMs,
    });
  });

  const automationWaitFor = Effect.fn("PreviewManager.automationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "waitFor", (send) =>
      performAutomationWaitFor(tabId, input, send),
    );
  });

  const revealArtifact = Effect.fn("PreviewManager.revealArtifact")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);
    yield* attempt({ operation: "revealArtifact", artifactPath: resolvedPath }, () =>
      shell.showItemInFolder(resolvedPath),
    );
  });

  const copyArtifactToClipboard = Effect.fn("PreviewManager.copyArtifactToClipboard")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);
    const image = yield* attempt(
      { operation: "copyArtifactToClipboard.load", artifactPath: resolvedPath },
      () => nativeImage.createFromPath(resolvedPath),
    );
    if (image.isEmpty()) {
      return yield* new PreviewArtifactImageLoadError({ artifactPath: resolvedPath });
    }
    yield* attempt({ operation: "copyArtifactToClipboard.write", artifactPath: resolvedPath }, () =>
      clipboard.writeImage(image),
    );
  });

  const subscribe = <A>(
    ref: Ref.Ref<ReadonlySet<A>>,
    listener: A,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Ref.update(ref, (listeners) => new Set([...listeners, listener])),
      () =>
        Ref.update(ref, (listeners) => {
          const next = new Set(listeners);
          next.delete(listener);
          return next;
        }),
    ).pipe(Effect.asVoid);

  const destroy = Effect.fn("PreviewManager.destroy")(function* () {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    yield* Effect.forEach(tabs.keys(), closeTab, { discard: true });
    yield* Effect.all(
      [
        Ref.set(listenersRef, new Set()),
        Ref.set(expectedAgentInputsRef, new Map()),
        Ref.set(pointerEventListenersRef, new Set()),
        Ref.set(recordingFrameListenersRef, new Set()),
      ],
      { discard: true },
    );
  });

  yield* Effect.addFinalizer(() => destroy().pipe(Effect.ignore));

  return {
    automationClick,
    automationEvaluate,
    automationPress,
    automationScroll,
    automationSnapshot,
    automationStatus,
    automationType,
    automationWaitFor,
    cancelPickElement,
    captureScreenshot,
    closeTab,
    copyArtifactToClipboard,
    createTab,
    goBack,
    goForward,
    hardReload,
    navigate,
    openDevTools,
    openPictureInPicture,
    pickElement,
    refresh,
    registerWebview,
    resetZoom: (tabId: string) => applyZoom(tabId, () => DEFAULT_ZOOM_FACTOR),
    revealArtifact,
    saveRecording,
    closePictureInPicture,
    setAnnotationTheme,
    setColorScheme,
    setMainWindow,
    startRecording,
    stopRecording,
    subscribePointerEvents: (listener: PointerEventListener) =>
      subscribe(pointerEventListenersRef, listener),
    subscribeRecordingFrames: (listener: RecordingFrameListener) =>
      subscribe(recordingFrameListenersRef, listener),
    subscribeStateChanges: (listener: Listener) => subscribe(listenersRef, listener),
    zoomIn: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, "in")),
    zoomOut: (tabId: string) => applyZoom(tabId, (current) => nextZoomLevel(current, "out")),
  };
});

export class PreviewTabNotFoundError extends Schema.TaggedErrorClass<PreviewTabNotFoundError>()(
  "PreviewTabNotFoundError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Preview tab not found: ${this.tabId}`;
  }
}

export class PreviewWebContentsNotFoundError extends Schema.TaggedErrorClass<PreviewWebContentsNotFoundError>()(
  "PreviewWebContentsNotFoundError",
  { tabId: Schema.String, webContentsId: Schema.Number },
) {
  override get message(): string {
    return `WebContents ${this.webContentsId} not found for preview tab ${this.tabId}`;
  }
}

export class PreviewWebviewNotInitializedError extends Schema.TaggedErrorClass<PreviewWebviewNotInitializedError>()(
  "PreviewWebviewNotInitializedError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Preview tab "${this.tabId}" has no webview registered`;
  }
}

export class PreviewMainWindowClosedError extends Schema.TaggedErrorClass<PreviewMainWindowClosedError>()(
  "PreviewMainWindowClosedError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Cannot start preview frame capture while the main window is closed: ${this.tabId}`;
  }
}

export class PreviewRecordingArmConflictError extends Schema.TaggedErrorClass<PreviewRecordingArmConflictError>()(
  "PreviewRecordingArmConflictError",
  {
    tabId: Schema.String,
    webContentsId: Schema.Number,
    armedTabId: Schema.String,
  },
) {
  override get message(): string {
    return `Preview tab ${this.armedTabId} is still claiming the capture stream, so recording could not start for tab ${this.tabId}`;
  }
}

export class PreviewRecordingCaptureUnavailableError extends Schema.TaggedErrorClass<PreviewRecordingCaptureUnavailableError>()(
  "PreviewRecordingCaptureUnavailableError",
  {
    tabId: Schema.String,
    webContentsId: Schema.Number,
  },
) {
  override get message(): string {
    return `Preview recording capture is unavailable for tab ${this.tabId} in WebContents ${this.webContentsId}`;
  }
}

export class PreviewOperationError extends Schema.TaggedErrorClass<PreviewOperationError>()(
  "PreviewOperationError",
  {
    operation: Schema.String,
    tabId: Schema.optional(Schema.String),
    webContentsId: Schema.optional(Schema.Number),
    artifactPath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewOperationError): string {
    return error.cause instanceof Error ? error.cause.message : String(error.cause);
  }

  override get message(): string {
    const context = [
      this.tabId === undefined ? undefined : `tab ${this.tabId}`,
      this.webContentsId === undefined ? undefined : `WebContents ${this.webContentsId}`,
      this.artifactPath === undefined ? undefined : `artifact ${this.artifactPath}`,
    ].filter((value): value is string => value !== undefined);
    return `Desktop preview operation failed: ${this.operation}${context.length === 0 ? "" : ` (${context.join(", ")})`}`;
  }
}

export const isPreviewOperationError = Schema.is(PreviewOperationError);

export class PreviewArtifactPathOutsideDirectoryError extends Schema.TaggedErrorClass<PreviewArtifactPathOutsideDirectoryError>()(
  "PreviewArtifactPathOutsideDirectoryError",
  {
    artifactPath: Schema.String,
    artifactDirectory: Schema.String,
  },
) {
  override get message(): string {
    return `Preview artifact path ${this.artifactPath} is outside ${this.artifactDirectory}`;
  }
}

export class PreviewArtifactImageLoadError extends Schema.TaggedErrorClass<PreviewArtifactImageLoadError>()(
  "PreviewArtifactImageLoadError",
  { artifactPath: Schema.String },
) {
  override get message(): string {
    return `Preview artifact could not be loaded as an image: ${this.artifactPath}`;
  }
}

export class PreviewAutomationDevToolsOpenError extends Schema.TaggedErrorClass<PreviewAutomationDevToolsOpenError>()(
  "PreviewAutomationDevToolsOpenError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `Close preview DevTools before using agent browser control for WebContents ${this.webContentsId}`;
  }
}

export class PreviewAutomationDebuggerAttachedError extends Schema.TaggedErrorClass<PreviewAutomationDebuggerAttachedError>()(
  "PreviewAutomationDebuggerAttachedError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `Preview control cannot attach to WebContents ${this.webContentsId} because another debugger owns it`;
  }
}

export class PreviewAutomationEvaluationError extends Schema.TaggedErrorClass<PreviewAutomationEvaluationError>()(
  "PreviewAutomationEvaluationError",
  {
    tabId: Schema.String,
    detailKind: PreviewAutomationEvaluationDetailKind,
    detailLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewAutomationEvaluationError): string {
    return previewAutomationEvaluationDetail(error.cause).detail ?? error.message;
  }

  override get message(): string {
    return `Preview JavaScript evaluation failed in tab ${this.tabId}`;
  }
}

export class PreviewAutomationTargetNotFoundError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotFoundError>()(
  "PreviewAutomationTargetNotFoundError",
  {
    operation: Schema.String,
    tabId: Schema.String,
    selectorKind: PreviewAutomationSelectorKind,
    selectorLength: Schema.optionalKey(Schema.Number),
    candidateLocators: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {
  override get message(): string {
    const target = previewAutomationTargetLabel(this.selectorKind, this.selectorLength);
    return `Preview automation ${this.operation} could not find ${target} in tab ${this.tabId}`;
  }
}

export class PreviewAutomationTargetNotEditableError extends Schema.TaggedErrorClass<PreviewAutomationTargetNotEditableError>()(
  "PreviewAutomationTargetNotEditableError",
  {
    tabId: Schema.String,
    selectorKind: PreviewAutomationSelectorKind,
    selectorLength: Schema.optionalKey(Schema.Number),
    candidateLocators: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {
  override get message(): string {
    const target = previewAutomationTargetLabel(this.selectorKind, this.selectorLength);
    return `Preview automation type found ${target}, but it is not editable in tab ${this.tabId}`;
  }
}

export class PreviewAutomationCoordinatesOutsideViewportError extends Schema.TaggedErrorClass<PreviewAutomationCoordinatesOutsideViewportError>()(
  "PreviewAutomationCoordinatesOutsideViewportError",
  {
    tabId: Schema.String,
    x: Schema.Number,
    y: Schema.Number,
    viewportWidth: Schema.Number,
    viewportHeight: Schema.Number,
  },
) {
  override get message(): string {
    return `Click coordinates (${this.x}, ${this.y}) are outside the ${this.viewportWidth}x${this.viewportHeight} preview viewport for tab ${this.tabId}`;
  }
}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedErrorClass<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  {
    operation: Schema.String,
    tabId: Schema.String,
    selectorKind: PreviewAutomationSelectorKind,
    selectorLength: Schema.optionalKey(Schema.Number),
    reasonLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static toTimelineMessage(error: PreviewAutomationInvalidSelectorError): string {
    if (typeof error.cause !== "object" || error.cause === null) return error.message;
    const reason = (error.cause as Record<string, unknown>)["message"];
    return typeof reason === "string" && reason.length > 0 ? reason : error.message;
  }

  get detail(): {
    readonly selectorKind: PreviewAutomationSelectorKind;
    readonly selectorLength?: number;
  } {
    return {
      selectorKind: this.selectorKind,
      ...(this.selectorLength === undefined ? {} : { selectorLength: this.selectorLength }),
    };
  }

  override get message(): string {
    const target = previewAutomationTargetLabel(this.selectorKind, this.selectorLength);
    return `Preview automation ${this.operation} rejected ${target} in tab ${this.tabId}`;
  }
}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedErrorClass<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  {
    tabId: Schema.String,
    actualBytes: Schema.Number,
    maximumBytes: Schema.Number,
  },
) {
  get detail(): { readonly maximumBytes: number } {
    return { maximumBytes: this.maximumBytes };
  }

  override get message(): string {
    return `Preview evaluation result in tab ${this.tabId} was ${this.actualBytes} bytes; maximum is ${this.maximumBytes} bytes`;
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  {
    tabId: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Preview condition did not match within ${this.timeoutMs}ms in tab ${this.tabId}`;
  }
}

export class PreviewAutomationControlInterruptedError extends Schema.TaggedErrorClass<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  {
    operation: Schema.String,
    tabId: Schema.String,
    webContentsId: Schema.Number,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} was interrupted by human input in tab ${this.tabId}`;
  }
}

export const PreviewManagerError = Schema.Union([
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
  PreviewMainWindowClosedError,
  PreviewRecordingArmConflictError,
  PreviewRecordingCaptureUnavailableError,
  PreviewOperationError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewArtifactImageLoadError,
  PreviewAutomationDevToolsOpenError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationEvaluationError,
  PreviewAutomationTargetNotFoundError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationCoordinatesOutsideViewportError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
]);
export type PreviewManagerError = typeof PreviewManagerError.Type;

export const isPreviewManagerError = Schema.is(PreviewManagerError);
export const isPreviewAutomationControlInterruptedError = Schema.is(
  PreviewAutomationControlInterruptedError,
);
export const isPreviewAutomationEvaluationError = Schema.is(PreviewAutomationEvaluationError);
export const isPreviewAutomationInvalidSelectorError = Schema.is(
  PreviewAutomationInvalidSelectorError,
);

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly setMainWindow: (window: BrowserWindow) => Effect.Effect<void, PreviewManagerError>;
    readonly getBrowserSession: (
      scope?: string,
      persistent?: boolean,
      namespace?: BrowserSession.BrowserSessionPartitionNamespace,
    ) => Effect.Effect<Session, PreviewManagerError>;
    readonly isBrowserPartition: (partition: string) => boolean;
    readonly createTab: (
      tabId: string,
      defaults?: DesktopPreviewTabDefaults,
    ) => Effect.Effect<PreviewTabState, PreviewManagerError>;
    readonly closeTab: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly registerWebview: (
      tabId: string,
      webContentsId: number,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly navigate: (tabId: string, url: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goBack: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goForward: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly refresh: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomIn: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomOut: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly resetZoom: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly hardReload: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly setColorScheme: (
      tabId: string,
      colorScheme: DesktopPreviewColorScheme,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly openDevTools: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly clearCookies: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly clearCache: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly getBrowserPartition: (
      scope?: string,
      persistent?: boolean,
      namespace?: BrowserSession.BrowserSessionPartitionNamespace,
    ) => Effect.Effect<string, PreviewManagerError>;
    readonly setAnnotationTheme: (
      theme: DesktopPreviewAnnotationTheme,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly pickElement: (
      tabId: string,
    ) => Effect.Effect<PreviewAnnotationPayload | null, PreviewManagerError>;
    readonly cancelPickElement: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly captureScreenshot: (
      tabId: string,
    ) => Effect.Effect<DesktopPreviewScreenshotArtifact, PreviewManagerError>;
    readonly revealArtifact: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly copyArtifactToClipboard: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly openPictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly closePictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly startRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly stopRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly saveRecording: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Effect.Effect<DesktopPreviewRecordingArtifact, PreviewManagerError>;
    readonly automationStatus: (
      tabId: string,
    ) => Effect.Effect<DesktopPreviewAutomationStatus, PreviewManagerError>;
    readonly automationSnapshot: (
      tabId: string,
      input?: PreviewAutomationSnapshotInput,
    ) => Effect.Effect<PreviewAutomationSnapshot, PreviewManagerError>;
    readonly automationClick: (
      tabId: string,
      input: PreviewAutomationClickInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationType: (
      tabId: string,
      input: PreviewAutomationTypeInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationPress: (
      tabId: string,
      input: PreviewAutomationPressInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationScroll: (
      tabId: string,
      input: PreviewAutomationScrollInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly automationEvaluate: (
      tabId: string,
      input: PreviewAutomationEvaluateInput,
    ) => Effect.Effect<unknown, PreviewManagerError>;
    readonly automationWaitFor: (
      tabId: string,
      input: PreviewAutomationWaitForInput,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly subscribeStateChanges: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribePointerEvents: (
      listener: PointerEventListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeRecordingFrames: (
      listener: RecordingFrameListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/preview/Manager/PreviewManager") {}

export const make = Effect.gen(function* PreviewManagerMake() {
  const environment = yield* PreviewEnvironment.PreviewEnvironment;
  const browserSession = yield* BrowserSession.BrowserSession;
  const operations = yield* makeNativeOperations(environment.browserArtifactsDir);

  return PreviewManager.of({
    setMainWindow: operations.setMainWindow,
    getBrowserSession: Effect.fn("PreviewManager.getBrowserSession")(
      function* (scope, persistent, namespace) {
        return yield* browserSession
          .getSession(scope, persistent, namespace)
          .pipe(
            Effect.mapError(
              (cause) => new PreviewOperationError({ operation: "getBrowserSession", cause }),
            ),
          );
      },
    ),
    isBrowserPartition: browserSession.isPartition,
    createTab: operations.createTab,
    closeTab: operations.closeTab,
    registerWebview: operations.registerWebview,
    navigate: operations.navigate,
    goBack: operations.goBack,
    goForward: operations.goForward,
    refresh: operations.refresh,
    zoomIn: operations.zoomIn,
    zoomOut: operations.zoomOut,
    resetZoom: operations.resetZoom,
    hardReload: operations.hardReload,
    setColorScheme: operations.setColorScheme,
    openDevTools: operations.openDevTools,
    clearCookies: Effect.fn("PreviewManager.clearCookies")(function* (partitions) {
      yield* browserSession
        .clearCookies(partitions)
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: "clearCookies", cause }),
          ),
        );
    }),
    clearCache: Effect.fn("PreviewManager.clearCache")(function* (partitions) {
      yield* browserSession
        .clearCache(partitions)
        .pipe(
          Effect.mapError((cause) => new PreviewOperationError({ operation: "clearCache", cause })),
        );
    }),
    getBrowserPartition: Effect.fn("PreviewManager.getBrowserPartition")(
      function* (scope, persistent, namespace) {
        return yield* browserSession
          .getPartition(scope, persistent, namespace)
          .pipe(
            Effect.mapError(
              (cause) => new PreviewOperationError({ operation: "getBrowserPartition", cause }),
            ),
          );
      },
    ),
    setAnnotationTheme: operations.setAnnotationTheme,
    pickElement: operations.pickElement,
    cancelPickElement: operations.cancelPickElement,
    captureScreenshot: operations.captureScreenshot,
    revealArtifact: operations.revealArtifact,
    copyArtifactToClipboard: operations.copyArtifactToClipboard,
    openPictureInPicture: operations.openPictureInPicture,
    closePictureInPicture: operations.closePictureInPicture,
    startRecording: operations.startRecording,
    stopRecording: operations.stopRecording,
    saveRecording: operations.saveRecording,
    automationStatus: operations.automationStatus,
    automationSnapshot: operations.automationSnapshot,
    automationClick: operations.automationClick,
    automationType: operations.automationType,
    automationPress: operations.automationPress,
    automationScroll: operations.automationScroll,
    automationEvaluate: operations.automationEvaluate,
    automationWaitFor: operations.automationWaitFor,
    subscribeStateChanges: operations.subscribeStateChanges,
    subscribePointerEvents: operations.subscribePointerEvents,
    subscribeRecordingFrames: operations.subscribeRecordingFrames,
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
