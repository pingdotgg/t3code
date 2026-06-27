/**
 * Desktop side of the in-app browser preview.
 *
 * Owns one native Chromium WebContentsView per preview tab. The renderer only
 * reports presentation bounds; navigation, automation, capture, and teardown
 * all operate on the desktop-owned WebContents.
 */
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewPointerEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewSurfaceFrame,
  EnvironmentId,
  PreviewAutomationClickInput,
  PreviewAutomationActionEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationNetworkEntry,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import {
  BrowserWindow as ElectronBrowserWindow,
  type BrowserWindow,
  type Session,
  WebContentsView,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserSession from "./BrowserSession.ts";
import {
  AGENT_POINTER_CHANNEL,
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
  focused: boolean;
  controller: "human" | "agent" | "none";
  updatedAt: string;
}

/** Discrete zoom levels mirroring Chrome's preset list. */
const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

const DEFAULT_ZOOM_FACTOR = 1.0;
const ZOOM_EPSILON = 0.001;
const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_SCREENSHOT_WIDTH = 1280;
const DIAGNOSTIC_BUFFER_LIMIT = 200;
const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80;
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
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
): Effect.Effect<PreviewAnnotationPayload["screenshot"], PreviewManagerError> =>
  Effect.tryPromise({
    try: () =>
      wc.capturePage(
        cropRect
          ? {
              x: cropRect.x,
              y: cropRect.y,
              width: cropRect.width,
              height: cropRect.height,
            }
          : undefined,
        { stayHidden: false, stayAwake: true },
      ),
    catch: (cause) =>
      new PreviewOperationError({
        operation: "captureAnnotationScreenshot",
        tabId,
        webContentsId: wc.id,
        cause,
      }),
  }).pipe(
    Effect.map((image) => {
      const size = image.getSize();
      return {
        dataUrl: image.toDataURL(),
        width: size.width,
        height: size.height,
        cropRect: cropRect ?? { x: 0, y: 0, width: size.width, height: size.height },
      };
    }),
  );

const findZoomStep = (current: number): number => {
  const index = ZOOM_LEVELS.findIndex(
    (level) => Math.abs(level - current) < ZOOM_EPSILON || level > current,
  );
  if (index < 0) return ZOOM_LEVELS.length - 1;
  return Math.abs(ZOOM_LEVELS[index]! - current) < ZOOM_EPSILON ? index : index - 1;
};

const nextZoomLevel = (current: number, direction: "in" | "out"): number => {
  const step = findZoomStep(current);
  if (direction === "in") {
    return ZOOM_LEVELS[Math.min(step + 1, ZOOM_LEVELS.length - 1)] ?? current;
  }
  return ZOOM_LEVELS[Math.max(step - 1, 0)] ?? current;
};

type Listener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>;
type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => Effect.Effect<void>;

type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

interface ManagedListeners {
  readonly scope: Scope.Closeable;
}

interface ManagedPreviewView {
  readonly environmentId: EnvironmentId;
  readonly view: WebContentsView;
  host: "main" | "capture";
  presented: boolean;
  bounds: Electron.Rectangle;
  surfaceScale: number;
}

interface PickSession {
  readonly cancel: Effect.Effect<void>;
}

interface BrowserControlSession {
  readonly webContentsId: number;
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

const APP_FORWARDED_SHORTCUTS: ReadonlyArray<{
  key: string;
  meta: boolean;
  shift: boolean;
  control: boolean;
}> = Object.freeze([
  // mod+shift+J → preview.toggle
  { key: "j", meta: true, shift: true, control: false },
  // mod+K → command palette
  { key: "k", meta: true, shift: false, control: false },
  // mod+, → settings (macOS convention)
  { key: ",", meta: true, shift: false, control: false },
  // mod+W → close tab/panel
  { key: "w", meta: true, shift: false, control: false },
  // mod+R → preview.refresh while the native page owns focus
  { key: "r", meta: true, shift: false, control: false },
  // mod+L → preview.focusUrl while the native page owns focus
  { key: "l", meta: true, shift: false, control: false },
]);

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
  getBrowserSession: (scope: string) => Effect.Effect<Session, PreviewManagerError>,
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
  const captureWindowRef = yield* Ref.make<Option.Option<BrowserWindow>>(Option.none());
  const nativeViewsRef = yield* SynchronizedRef.make<ReadonlyMap<string, ManagedPreviewView>>(
    new Map(),
  );
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
  const recordingTabIdRef = yield* Ref.make<Option.Option<string>>(Option.none());
  const recordingLifecycle = yield* Semaphore.make(1);
  const nativeViewLifecycle = yield* Semaphore.make(1);

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
  const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const currentMillis = Clock.currentTimeMillis;
  const requireCaptureWindow = Effect.fn("PreviewManager.requireCaptureWindow")(function* () {
    const current = yield* Ref.get(captureWindowRef);
    if (Option.isSome(current) && !current.value.isDestroyed()) return current.value;
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) {
      return yield* new PreviewOperationError({
        operation: "createCaptureWindow.requireMainWindow",
        cause: new Error("The main BrowserWindow is unavailable"),
      });
    }
    const captureWindow = yield* attempt({ operation: "createCaptureWindow" }, () => {
      const window = new ElectronBrowserWindow({
        parent: mainWindow.value,
        show: false,
        width: 1280,
        height: 800,
        x: 0,
        y: 0,
        opacity: 0,
        transparent: true,
        backgroundColor: "#00000000",
        focusable: false,
        skipTaskbar: true,
        ...(hostPlatform === "linux" ? { type: "desktop" as const } : {}),
        webPreferences: {
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window.setIgnoreMouseEvents(true);
      window.showInactive();
      return window;
    });
    yield* Ref.set(captureWindowRef, Option.some(captureWindow));
    return captureWindow;
  });
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
      return yield* new PreviewNativeViewNotInitializedError({ tabId });
    }
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc) {
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
  ) {
    const control = yield* SynchronizedRef.modify(controlSessionsRef, (sessions) => [
      sessions.get(webContentsId),
      replaceMap(sessions, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);
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

  const emitRecordingFrame = Effect.fn("PreviewManager.emitRecordingFrame")(function* (
    tabId: string,
    data: string,
    width = 0,
    height = 0,
  ) {
    const receivedAt = yield* currentIso;
    const listeners = yield* Ref.get(recordingFrameListenersRef);
    const frame: DesktopPreviewRecordingFrame = { tabId, data, width, height, receivedAt };
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("recording-frame", tabId, () => listener(frame)),
      { discard: true },
    );
  });

  const tabIdForWebContents = Effect.fn("PreviewManager.tabIdForWebContents")(function* (
    webContentsId: number,
  ) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    return (
      Array.from(tabs.entries()).find(([, tab]) => tab.webContentsId === webContentsId)?.[0] ?? null
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
        if (wc.isDevToolsOpened()) {
          return Effect.fail(
            new PreviewAutomationDevToolsOpenError({
              webContentsId: wc.id,
            }),
          );
        }
        if (wc.debugger.isAttached()) {
          return Effect.fail(
            new PreviewAutomationDebuggerAttachedError({
              webContentsId: wc.id,
            }),
          );
        }
        const createControlSession = Effect.fn("PreviewManager.createControlSession")(function* () {
          const semaphore = yield* Semaphore.make(1);
          const scope = yield* Scope.fork(parentScope, "sequential");
          const handleDebuggerMessage = Effect.fn("PreviewManager.handleDebuggerMessage")(
            function* (method: string, params: Record<string, unknown>) {
              if (method === "Page.screencastFrame") {
                const sessionId = params["sessionId"];
                if (typeof sessionId === "number") {
                  yield* attemptPromise(
                    {
                      operation: "recording.ackScreencastFrame",
                      webContentsId: wc.id,
                    },
                    () => wc.debugger.sendCommand("Page.screencastFrameAck", { sessionId }),
                  ).pipe(Effect.ignore);
                }
                const tabId = yield* tabIdForWebContents(wc.id);
                const metadata =
                  typeof params["metadata"] === "object" && params["metadata"] !== null
                    ? (params["metadata"] as Record<string, unknown>)
                    : {};
                if (tabId && typeof params["data"] === "string") {
                  yield* emitRecordingFrame(
                    tabId,
                    params["data"],
                    typeof metadata["deviceWidth"] === "number" ? metadata["deviceWidth"] : 0,
                    typeof metadata["deviceHeight"] === "number" ? metadata["deviceHeight"] : 0,
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
                  wc.debugger.off("message", onMessage);
                  if (wc.debugger.isAttached()) wc.debugger.detach();
                }).pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          );
          const control: BrowserControlSession = {
            webContentsId: wc.id,
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
              wc.debugger.on("message", onMessage);
              wc.debugger.attach("1.3");
            });
            yield* Effect.all(
              ["Runtime.enable", "Accessibility.enable", "Network.enable", "Log.enable"].map(
                (method) =>
                  attemptPromise(
                    { operation: `initializeDebugger.${method}`, webContentsId: wc.id },
                    () => wc.debugger.sendCommand(method),
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

  const withCapturableSurface = Effect.fn("PreviewManager.withCapturableSurface")(function* <A>(
    tabId: string,
    use: Effect.Effect<A, PreviewManagerError>,
  ) {
    return yield* nativeViewLifecycle.withPermit(
      Effect.gen(function* () {
        const managed = (yield* SynchronizedRef.get(nativeViewsRef)).get(tabId);
        if (!managed) return yield* new PreviewNativeViewNotInitializedError({ tabId });
        if (managed.host === "capture") {
          const captureWindow = yield* requireCaptureWindow();
          yield* attempt(
            {
              operation: "prepareCaptureSurface",
              tabId,
              webContentsId: managed.view.webContents.id,
            },
            () => {
              captureWindow.setBounds({
                x: 0,
                y: 0,
                width: Math.max(1, managed.bounds.width),
                height: Math.max(1, managed.bounds.height),
              });
              captureWindow.contentView.addChildView(managed.view);
              managed.view.setBounds({
                x: 0,
                y: 0,
                width: managed.bounds.width,
                height: managed.bounds.height,
              });
              managed.view.setVisible(true);
            },
          );
        }
        return yield* use;
      }),
    );
  });

  const capturePngWithDebugger = Effect.fn("PreviewManager.capturePngWithDebugger")(function* (
    tabId: string,
    wc: Electron.WebContents,
    operation: string,
    send: SendCommand,
  ) {
    const response = yield* send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    }).pipe(
      Effect.timeout("3 seconds"),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.gen(function* () {
          // A timed-out CDP promise cannot be cancelled. Detach the session so
          // the late command cannot poison the per-tab command lane.
          yield* detachControlSession(wc.id);
          return yield* new PreviewOperationError({
            operation: `${operation}.timeout`,
            tabId,
            webContentsId: wc.id,
            cause,
          });
        }),
      ),
    );
    const encoded =
      typeof response === "object" && response !== null && "data" in response
        ? response.data
        : undefined;
    if (typeof encoded !== "string" || encoded.length === 0) {
      return yield* new PreviewOperationError({
        operation,
        tabId,
        webContentsId: wc.id,
        cause: new Error("Chromium returned an empty screenshot"),
      });
    }
    return Buffer.from(encoded, "base64");
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
            () => wc.debugger.sendCommand(method, commandParams),
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
            () => wc.debugger.sendCommand(method, commandParams),
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
  ) {
    const managed = yield* Ref.modify(attachedRef, (attached) => [
      attached.get(webContentsId),
      replaceMap(attached, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);
    if (managed) yield* Scope.close(managed.scope, Exit.void).pipe(Effect.ignore);
  });

  const isAppShortcut = (input: Electron.Input): boolean =>
    input.type === "keyDown" &&
    APP_FORWARDED_SHORTCUTS.some(
      (shortcut) =>
        shortcut.key.toLowerCase() === input.key.toLowerCase() &&
        shortcut.meta === input.meta &&
        shortcut.shift === input.shift &&
        shortcut.control === input.control,
    );

  const computeNavStatus = (wc: Electron.WebContents): PreviewNavStatus => {
    const url = wc.getURL();
    const title = wc.getTitle();
    if (url === "" || url === "about:blank") return { kind: "Idle" };
    if (wc.isLoading()) return { kind: "Loading", url, title };
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
    ) {
      if (wc.isDestroyed()) return;
      const computedNavStatus = computeNavStatus(wc);
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
    const focus = () => runFork(update(tabId, { focused: true }));
    const blur = () => runFork(update(tabId, { focused: false }));
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
    const forwardShortcut = Effect.fn("PreviewManager.forwardShortcut")(function* (
      event: Electron.Event,
      input: Electron.Input,
    ) {
      const mainWindow = yield* Ref.get(mainWindowRef);
      if (!isAppShortcut(input) || Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) {
        return;
      }
      event.preventDefault();
      mainWindow.value.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: input.key,
        modifiers: [
          ...(input.meta ? (["meta"] as const) : []),
          ...(input.shift ? (["shift"] as const) : []),
          ...(input.control ? (["control"] as const) : []),
          ...(input.alt ? (["alt"] as const) : []),
        ],
      });
    });
    const beforeInput = (event: Electron.Event, input: Electron.Input): void => {
      runFork(forwardShortcut(event, input));
    };
    yield* Scope.addFinalizer(
      scope,
      attempt({ operation: "detachListeners", tabId, webContentsId: wc.id }, () => {
        wc.off("did-navigate", syncNavigation);
        wc.off("did-navigate-in-page", syncNavigation);
        wc.off("page-title-updated", sync);
        wc.off("did-start-loading", sync);
        wc.off("did-stop-loading", sync);
        wc.off("did-fail-load", failed as never);
        wc.off("focus", focus);
        wc.off("blur", blur);
        wc.off("before-input-event", beforeInput);
        wc.ipc.off(HUMAN_INPUT_CHANNEL, humanInput);
      }).pipe(Effect.ignore),
    );
    const install = Effect.fn("PreviewManager.installWebContentsListeners")(function* () {
      yield* attempt({ operation: "attachListeners", tabId, webContentsId: wc.id }, () => {
        wc.on("did-navigate", syncNavigation);
        wc.on("did-navigate-in-page", syncNavigation);
        wc.on("page-title-updated", sync);
        wc.on("did-start-loading", sync);
        wc.on("did-stop-loading", sync);
        wc.on("did-fail-load", failed as never);
        wc.on("focus", focus);
        wc.on("blur", blur);
        wc.ipc.on(HUMAN_INPUT_CHANNEL, humanInput);
        wc.setWindowOpenHandler(({ url }) => {
          runFork(
            attemptPromise({ operation: "openPreviewWindow", tabId, webContentsId: wc.id }, () =>
              wc.loadURL(url),
            ).pipe(Effect.ignore),
          );
          return { action: "deny" };
        });
        wc.on("before-input-event", beforeInput);
      });
      yield* Ref.update(attachedRef, (attached) =>
        replaceMap(attached, (copy) => {
          copy.set(wc.id, { scope });
        }),
      );
    });
    yield* install().pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  const setMainWindow = Effect.fn("PreviewManager.setMainWindow")(function* (
    window: BrowserWindow,
  ) {
    yield* Ref.set(mainWindowRef, Option.some(window));
  });

  const createTab = Effect.fn("PreviewManager.createTab")(function* (tabId: string) {
    const updatedAt = yield* currentIso;
    const state = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const existing = tabs.get(tabId);
      if (existing) return [existing, tabs] as const;
      const initial: PreviewTabState = {
        tabId,
        webContentsId: null,
        navStatus: { kind: "Idle" },
        canGoBack: false,
        canGoForward: false,
        zoomFactor: DEFAULT_ZOOM_FACTOR,
        focused: false,
        controller: "none",
        updatedAt,
      };
      return [
        initial,
        replaceMap(tabs, (copy) => {
          copy.set(tabId, initial);
        }),
      ] as const;
    });
    yield* emit(tabId, state);
    return state;
  });

  const getTabState = Effect.fn("PreviewManager.getTabState")(function* (tabId: string) {
    return (yield* SynchronizedRef.get(tabsRef)).get(tabId) ?? null;
  });

  const closeTab = Effect.fn("PreviewManager.closeTab")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) return;
    yield* recordingLifecycle.withPermit(
      Effect.gen(function* () {
        const recordingTabId = yield* Ref.get(recordingTabIdRef);
        if (Option.isNone(recordingTabId) || recordingTabId.value !== tabId) return;
        yield* Ref.set(recordingTabIdRef, Option.none());
      }),
    );
    const managed = yield* SynchronizedRef.modify(nativeViewsRef, (views) => [
      views.get(tabId),
      replaceMap(views, (copy) => {
        copy.delete(tabId);
      }),
    ]);
    yield* cancelPickElement(tabId);
    if (tab.webContentsId != null) {
      yield* Effect.all(
        [detachControlSession(tab.webContentsId), detachListeners(tab.webContentsId)],
        { concurrency: 2, discard: true },
      );
    }
    if (managed) {
      const mainWindow = yield* Ref.get(mainWindowRef);
      const captureWindow = yield* Ref.get(captureWindowRef);
      yield* nativeViewLifecycle.withPermit(
        attempt(
          {
            operation: "closeTab.nativeView",
            tabId,
            webContentsId: managed.view.webContents.id,
          },
          () => {
            managed.view.setVisible(false);
            if (
              managed.host === "main" &&
              Option.isSome(mainWindow) &&
              !mainWindow.value.isDestroyed()
            ) {
              mainWindow.value.contentView.removeChildView(managed.view);
            }
            if (
              managed.host === "capture" &&
              Option.isSome(captureWindow) &&
              !captureWindow.value.isDestroyed()
            ) {
              captureWindow.value.contentView.removeChildView(managed.view);
            }
            if (!managed.view.webContents.isDestroyed()) managed.view.webContents.close();
          },
        ).pipe(Effect.ignore),
      );
    }
    const updatedAt = yield* currentIso;
    const closed: PreviewTabState = {
      ...tab,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      focused: false,
      controller: "none",
      updatedAt,
    };
    yield* SynchronizedRef.update(tabsRef, (tabs) =>
      replaceMap(tabs, (copy) => {
        copy.delete(tabId);
      }),
    );
    yield* emit(tabId, closed);
  });

  const createNativeView = Effect.fn("PreviewManager.createNativeView")(function* (
    tabId: string,
    environmentId: EnvironmentId,
    initialUrl: string | null,
  ) {
    yield* nativeViewLifecycle.withPermit(
      Effect.gen(function* () {
        const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        if (!tab) return yield* new PreviewTabNotFoundError({ tabId });
        const requestedUrl =
          initialUrl ?? (tab.navStatus.kind === "Loading" ? tab.navStatus.url : null);

        const existing = (yield* SynchronizedRef.get(nativeViewsRef)).get(tabId);
        if (existing) {
          if (existing.environmentId !== environmentId) {
            return yield* new PreviewOperationError({
              operation: "createNativeView.environmentMismatch",
              tabId,
              webContentsId: existing.view.webContents.id,
              cause: new Error(
                `Preview tab ${tabId} already belongs to environment ${existing.environmentId}`,
              ),
            });
          }
          return;
        }

        const mainWindow = yield* Ref.get(mainWindowRef);
        if (Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) {
          return yield* new PreviewOperationError({
            operation: "createNativeView.requireMainWindow",
            tabId,
            cause: new Error("The main BrowserWindow is unavailable"),
          });
        }
        const browserSession = yield* getBrowserSession(environmentId);
        const captureWindow = yield* requireCaptureWindow();
        const view = yield* attempt(
          { operation: "createNativeView.construct", tabId },
          () =>
            new WebContentsView({
              webPreferences: {
                session: browserSession,
                preload: `${__dirname}/preview-pick-preload.cjs`,
                contextIsolation: false,
                sandbox: true,
                nodeIntegration: false,
                backgroundThrottling: false,
              },
            }),
        );
        const wc = view.webContents;
        const cleanupView = attempt(
          { operation: "createNativeView.cleanup", tabId, webContentsId: wc.id },
          () => {
            view.setVisible(false);
            if (!captureWindow.isDestroyed()) {
              captureWindow.contentView.removeChildView(view);
            }
            if (!wc.isDestroyed()) wc.close();
          },
        ).pipe(Effect.ignore);

        yield* Effect.gen(function* () {
          yield* attempt(
            { operation: "createNativeView.attach", tabId, webContentsId: wc.id },
            () => {
              view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
              view.setVisible(true);
              captureWindow.contentView.addChildView(view);
              wc.setBackgroundThrottling(false);
              wc.setZoomFactor(tab.zoomFactor);
            },
          );
          yield* attachListeners(tabId, wc);
          yield* SynchronizedRef.update(nativeViewsRef, (views) =>
            replaceMap(views, (copy) => {
              copy.set(tabId, {
                environmentId,
                view,
                host: "capture",
                presented: false,
                bounds: { x: 0, y: 0, width: 1280, height: 800 },
                surfaceScale: 1,
              });
            }),
          );
          const registeredAt = yield* currentIso;
          const registered = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
            const current = tabs.get(tabId);
            if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
            const next: PreviewTabState = {
              ...current,
              webContentsId: wc.id,
              navStatus: requestedUrl === null ? computeNavStatus(wc) : current.navStatus,
              canGoBack: wc.navigationHistory.canGoBack(),
              canGoForward: wc.navigationHistory.canGoForward(),
              updatedAt: registeredAt,
            };
            return [
              Option.some(next),
              replaceMap(tabs, (copy) => {
                copy.set(tabId, next);
              }),
            ] as const;
          });
          if (Option.isNone(registered)) return yield* new PreviewTabNotFoundError({ tabId });
          yield* emit(tabId, registered.value);
          const annotationTheme = yield* Ref.get(annotationThemeRef);
          yield* attempt(
            { operation: "createNativeView.sendTheme", tabId, webContentsId: wc.id },
            () => wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
          ).pipe(Effect.ignore);
          runFork(ensureControlSession(wc).pipe(Effect.ignore));
          if (requestedUrl && requestedUrl !== "about:blank") {
            yield* navigate(tabId, requestedUrl);
          }
        }).pipe(
          Effect.onError(() =>
            Effect.all(
              [
                detachControlSession(wc.id),
                detachListeners(wc.id),
                SynchronizedRef.update(nativeViewsRef, (views) =>
                  replaceMap(views, (copy) => {
                    copy.delete(tabId);
                  }),
                ),
                cleanupView,
              ],
              { concurrency: "unbounded", discard: true },
            ),
          ),
        );
      }),
    );
  });

  const setSurface = Effect.fn("PreviewManager.setSurface")(function* (
    tabId: string,
    bounds: Electron.Rectangle,
    visible: boolean,
    scale: number,
  ) {
    yield* nativeViewLifecycle.withPermit(
      Effect.gen(function* () {
        const managed = (yield* SynchronizedRef.get(nativeViewsRef)).get(tabId);
        if (!managed) return yield* new PreviewNativeViewNotInitializedError({ tabId });
        const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        if (!tab) return yield* new PreviewTabNotFoundError({ tabId });
        const mainWindow = yield* Ref.get(mainWindowRef);
        if (Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) {
          return yield* new PreviewOperationError({
            operation: "setSurface.requireMainWindow",
            tabId,
            webContentsId: managed.view.webContents.id,
            cause: new Error("The main BrowserWindow is unavailable"),
          });
        }
        const captureWindow = yield* requireCaptureWindow();
        const allViews = yield* SynchronizedRef.get(nativeViewsRef);
        yield* attempt(
          { operation: "setSurface", tabId, webContentsId: managed.view.webContents.id },
          () => {
            if (visible) {
              for (const [otherTabId, other] of allViews) {
                if (otherTabId === tabId || !other.presented) continue;
                mainWindow.value.contentView.removeChildView(other.view);
                captureWindow.contentView.addChildView(other.view);
                other.view.setBounds({
                  x: 0,
                  y: 0,
                  width: other.bounds.width,
                  height: other.bounds.height,
                });
                other.view.setVisible(true);
                other.host = "capture";
                other.presented = false;
              }
            }

            managed.surfaceScale = scale;
            managed.bounds = bounds;
            managed.presented = visible;
            managed.view.webContents.setZoomFactor(tab.zoomFactor * scale);
            if (visible) {
              if (managed.host === "capture") {
                captureWindow.contentView.removeChildView(managed.view);
              }
              mainWindow.value.contentView.addChildView(managed.view);
              managed.view.setBounds(bounds);
              managed.host = "main";
            } else {
              if (managed.host === "main") {
                mainWindow.value.contentView.removeChildView(managed.view);
              }
              captureWindow.setBounds({
                x: 0,
                y: 0,
                width: Math.max(1, bounds.width),
                height: Math.max(1, bounds.height),
              });
              captureWindow.contentView.addChildView(managed.view);
              managed.view.setBounds({
                x: 0,
                y: 0,
                width: bounds.width,
                height: bounds.height,
              });
              managed.host = "capture";
            }
            managed.view.setVisible(true);
          },
        );
      }),
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
        focused: current?.focused ?? false,
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
    if (!wc) {
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
    // Starting a navigation must not hold the renderer IPC request open until
    // the destination finishes loading. A slow or unreachable page would
    // otherwise monopolize the tab's request lane and make status, stop, and
    // follow-up automation appear hung. Navigation events remain the source of
    // truth for success/failure after the load has been initiated.
    yield* attempt({ operation: "navigate.loadURL", tabId, webContentsId: wc.id }, () => {
      runFork(
        attemptPromise({ operation: "navigate.loadURL.settle", tabId, webContentsId: wc.id }, () =>
          wc.loadURL(url),
        ).pipe(Effect.ignore),
      );
    });
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
        if (!wc.isDestroyed()) runFork(ensureControlSession(wc).pipe(Effect.ignore));
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
    yield* cancelPickElement(tabId);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    return yield* Effect.callback<PreviewAnnotationPayload | null, PreviewManagerError>(
      (resume) => {
        const cleanup = Effect.fn("PreviewManager.cleanupPickElement")(function* () {
          yield* attempt({ operation: "pickElement.cleanup", tabId, webContentsId: wc.id }, () => {
            wc.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.off("destroyed", onDestroyed);
            wc.off("did-start-navigation", onNavigated);
          }).pipe(Effect.ignore);
          yield* Ref.update(pickSessionsRef, (sessions) =>
            replaceMap(sessions, (copy) => {
              copy.delete(tabId);
            }),
          );
        });
        const settlePick = Effect.fn("PreviewManager.settlePickElement")(function* (
          payload: PreviewAnnotationPayload | null,
        ) {
          const active = (yield* Ref.get(pickSessionsRef)).get(tabId);
          if (!active || active.cancel !== cancel) return;
          yield* cleanup();
          resume(Effect.succeed(payload));
        });
        const settle = (payload: PreviewAnnotationPayload | null) => {
          runFork(settlePick(payload));
        };
        const cancelPickSession = Effect.fn("PreviewManager.cancelPickSession")(function* () {
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
        const cancel = cancelPickSession();
        const onMessage = (_event: Electron.IpcMainEvent, ...args: unknown[]): void => {
          const payload = args[0];
          if (!isPreviewAnnotationPayload(payload)) {
            settle(null);
            return;
          }
          const cropRect = normalizeCaptureRect(args[1]);
          runFork(
            captureAnnotationScreenshot(tabId, wc, cropRect).pipe(
              Effect.matchEffect({
                onFailure: () => Effect.sync(() => settle(payload)),
                onSuccess: (screenshot) => Effect.sync(() => settle({ ...payload, screenshot })),
              }),
              Effect.ensuring(
                attempt(
                  { operation: "pickElement.captureComplete", tabId, webContentsId: wc.id },
                  () => {
                    if (!wc.isDestroyed()) wc.send(ANNOTATION_CAPTURED_CHANNEL);
                  },
                ).pipe(Effect.ignore),
              ),
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
          yield* attempt({ operation: "pickElement.register", tabId, webContentsId: wc.id }, () => {
            wc.ipc.on(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.once("destroyed", onDestroyed);
            wc.once("did-start-navigation", onNavigated);
            if (!wc.isFocused()) wc.focus();
            wc.send(START_PICK_CHANNEL, annotationTheme);
          });
          yield* Ref.update(pickSessionsRef, (sessions) =>
            replaceMap(sessions, (copy) => {
              copy.set(tabId, { cancel });
            }),
          );
        });
        runFork(
          registerPickElement().pipe(
            Effect.catch((error: PreviewManagerError) => {
              resume(Effect.fail(error));
              return cleanup();
            }),
          ),
        );
        return cancel;
      },
    );
  });

  const applyZoom = Effect.fn("PreviewManager.applyZoom")(function* (
    tabId: string,
    transform: (current: number) => number,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) return;
    const next = transform(tab.zoomFactor);
    if (Math.abs(next - tab.zoomFactor) < ZOOM_EPSILON) return;
    if (tab.webContentsId != null) {
      const wc = webContents.fromId(tab.webContentsId);
      if (wc && !wc.isDestroyed()) {
        const scale = (yield* SynchronizedRef.get(nativeViewsRef)).get(tabId)?.surfaceScale ?? 1;
        yield* attempt({ operation: "applyZoom", tabId, webContentsId: wc.id }, () =>
          wc.setZoomFactor(next * scale),
        );
      }
    }
    yield* update(tabId, { zoomFactor: next });
  });

  const captureScreenshot = Effect.fn("PreviewManager.captureScreenshot")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);
    const [createdAt, millis, data] = yield* Effect.all([
      currentIso,
      currentMillis,
      withCapturableSurface(
        tabId,
        withControlSession(tabId, wc, "capture-screenshot", (send) =>
          capturePngWithDebugger(tabId, wc, "captureScreenshot.captureCdpScreenshot", send),
        ),
      ),
    ]);
    const id = `browser-screenshot-${artifactSiteSlug(wc.getURL())}-${millis.toString(36)}`;
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.png`);
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

  const captureSurfaceFrame = Effect.fn("PreviewManager.captureSurfaceFrame")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);
    const data = yield* withCapturableSurface(
      tabId,
      Effect.gen(function* () {
        const control = yield* ensureControlSession(wc);
        return yield* control.semaphore.withPermit(
          capturePngWithDebugger(
            tabId,
            wc,
            "captureSurfaceFrame.captureCdpScreenshot",
            (method, commandParams) =>
              attemptPromise(
                {
                  operation: `captureSurfaceFrame.${method}`,
                  tabId,
                  webContentsId: wc.id,
                },
                () => wc.debugger.sendCommand(method, commandParams),
              ),
          ),
        );
      }),
    );
    const image = nativeImage.createFromBuffer(data);
    const size = image.getSize();
    return {
      mimeType: "image/png" as const,
      data: data.toString("base64"),
      width: size.width,
      height: size.height,
    };
  });

  const startRecording = Effect.fn("PreviewManager.startRecording")(function* (tabId: string) {
    yield* recordingLifecycle.withPermit(
      Effect.gen(function* () {
        const recordingTabId = yield* Ref.get(recordingTabIdRef);
        if (Option.isSome(recordingTabId)) {
          if (recordingTabId.value === tabId) return;
          return yield* new PreviewRecordingAlreadyActiveError({
            requestedTabId: tabId,
            activeTabId: recordingTabId.value,
          });
        }
        const wc = yield* requireWebContents(tabId);
        yield* withCapturableSurface(
          tabId,
          Effect.gen(function* () {
            const control = yield* ensureControlSession(wc);
            yield* control.semaphore.withPermit(
              Effect.gen(function* () {
                yield* attemptPromise(
                  { operation: "recording.Page.enable", tabId, webContentsId: wc.id },
                  () => wc.debugger.sendCommand("Page.enable"),
                );
                yield* attemptPromise(
                  { operation: "recording.Page.startScreencast", tabId, webContentsId: wc.id },
                  () =>
                    wc.debugger.sendCommand("Page.startScreencast", {
                      format: "jpeg",
                      quality: 80,
                      maxWidth: 1600,
                      maxHeight: 1200,
                      everyNthFrame: 1,
                    }),
                );
              }).pipe(
                Effect.timeout("3 seconds"),
                Effect.catchTag("TimeoutError", (cause) =>
                  Effect.gen(function* () {
                    yield* detachControlSession(wc.id);
                    return yield* new PreviewOperationError({
                      operation: "recording.startScreencast.timeout",
                      tabId,
                      webContentsId: wc.id,
                      cause,
                    });
                  }),
                ),
              ),
            );
          }),
        );
        yield* Ref.set(recordingTabIdRef, Option.some(tabId));
      }),
    );
  });

  const stopRecording = Effect.fn("PreviewManager.stopRecording")(function* (tabId: string) {
    yield* recordingLifecycle.withPermit(
      Effect.gen(function* () {
        const recordingTabId = yield* Ref.get(recordingTabIdRef);
        if (Option.isNone(recordingTabId) || recordingTabId.value !== tabId) return;
        const wc = yield* requireWebContents(tabId);
        const control = yield* ensureControlSession(wc);
        yield* control.semaphore
          .withPermit(
            attemptPromise(
              { operation: "recording.Page.stopScreencast", tabId, webContentsId: wc.id },
              () => wc.debugger.sendCommand("Page.stopScreencast"),
            ).pipe(
              Effect.timeout("3 seconds"),
              Effect.catchTag("TimeoutError", (cause) =>
                Effect.gen(function* () {
                  yield* detachControlSession(wc.id);
                  return yield* new PreviewOperationError({
                    operation: "recording.stopScreencast.timeout",
                    tabId,
                    webContentsId: wc.id,
                    cause,
                  });
                }),
              ),
            ),
          )
          .pipe(Effect.ensuring(Ref.set(recordingTabIdRef, Option.none())));
      }),
    );
  });

  const saveRecording = Effect.fn("PreviewManager.saveRecording")(function* (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    if (data.byteLength === 0) {
      return yield* new PreviewOperationError({
        operation: "saveRecording.validateData",
        tabId,
        cause: new Error("Cannot save an empty browser recording"),
      });
    }
    const [createdAt, millis] = yield* Effect.all([currentIso, currentMillis]);
    const id = `browser-recording-${millis.toString(36)}`;
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
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
    const managed = (yield* SynchronizedRef.get(nativeViewsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) {
      const navStatus = tab?.navStatus;
      return {
        available: false,
        visible: managed?.presented ?? false,
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
          visible: managed?.presented ?? false,
          tabId,
          url: null,
          title: null,
          loading: false,
        }
      : {
          available: true,
          visible: managed?.presented ?? false,
          tabId,
          url: wc.getURL() || null,
          title: wc.getTitle() || null,
          loading: wc.isLoading(),
        };
  });

  const captureAutomationSnapshot = Effect.fn("PreviewManager.captureAutomationSnapshot")(
    function* (tabId: string, wc: Electron.WebContents, send: SendCommand) {
      yield* Effect.all([send("Runtime.enable"), send("Accessibility.enable")], {
        concurrency: 2,
        discard: true,
      });
      const page = yield* evaluateWithDebugger<{
        url: string;
        title: string;
        loading: boolean;
        visibleText: string;
        interactiveElements: PreviewAutomationSnapshot["interactiveElements"];
      }>(
        tabId,
        send,
        `(() => {
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
          )).filter(visible).slice(0, ${MAX_INTERACTIVE_ELEMENTS}).map((element) => {
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
            visibleText: (document.body?.innerText || "").slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
            interactiveElements: elements
          };
        })()`,
        true,
      );
      const [accessibility, screenshotData, diagnostics, timelines] = yield* Effect.all([
        send("Accessibility.getFullAXTree"),
        capturePngWithDebugger(tabId, wc, "automationSnapshot.captureCdpScreenshot", send),
        Ref.get(diagnosticsRef),
        Ref.get(actionTimelineRef),
      ]);
      const sourceImage = nativeImage.createFromBuffer(screenshotData);
      const sourceSize = sourceImage.getSize();
      const image =
        sourceSize.width > MAX_SCREENSHOT_WIDTH
          ? sourceImage.resize({ width: MAX_SCREENSHOT_WIDTH })
          : sourceImage;
      const size = image.getSize();
      const browserDiagnostics = diagnostics.get(wc.id);
      return {
        ...page,
        accessibilityTree: accessibility,
        consoleEntries: [...(browserDiagnostics?.consoleEntries ?? [])],
        networkEntries: [...(browserDiagnostics?.networkEntries ?? [])],
        actionTimeline: [...(timelines.get(tabId) ?? [])],
        screenshot: {
          mimeType: "image/png" as const,
          data: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height,
        },
      };
    },
  );

  const automationSnapshot = Effect.fn("PreviewManager.automationSnapshot")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);
    return yield* withCapturableSurface(
      tabId,
      withControlSession(tabId, wc, "snapshot", (send) =>
        captureAutomationSnapshot(tabId, wc, send),
      ),
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
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "click",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
    return point;
  });

  const emitPointerEvent = Effect.fn("PreviewManager.emitPointerEvent")(function* (
    event: DesktopPreviewPointerEvent,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(event.tabId);
    const wc = tab?.webContentsId == null ? null : webContents.fromId(tab.webContentsId);
    if (wc && !wc.isDestroyed()) {
      yield* attempt(
        {
          operation: "emitPointerEvent.sendToNativeView",
          tabId: event.tabId,
          webContentsId: wc.id,
        },
        () => wc.send(AGENT_POINTER_CHANNEL, event),
      ).pipe(Effect.ignore);
    }
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
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "type",
        tabId,
        ...automationSelectorDiagnostics(input),
      });
    }
    if ("notEditable" in result) {
      return yield* new PreviewAutomationTargetNotEditableError({
        tabId,
        ...automationSelectorDiagnostics(input),
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
    input: PreviewAutomationPressInput,
    send: SendCommand,
    sendCleanup: SendCommand,
  ) {
    yield* prepareAutomationInput(send, false);
    const keySequence = makePreviewAutomationKeySequence(input, {
      isMac: hostPlatform === "darwin",
    });
    let keyDownAttempted = false;
    const releaseInput = Effect.gen(function* () {
      if (keyDownAttempted) {
        yield* sendCleanup("Input.dispatchKeyEvent", keySequence.keyUp).pipe(Effect.ignore);
      }
      yield* sendCleanup("Emulation.setFocusEmulationEnabled", { enabled: false }).pipe(
        Effect.ignore,
      );
    });

    // CDP focus emulation targets this page without moving native focus away from
    // the human's currently presented preview or the app renderer.
    yield* Effect.gen(function* () {
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
      performAutomationPress(tabId, input, send, sendCleanup),
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
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: "scroll",
        tabId,
        ...automationSelectorDiagnostics(input),
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
    const captureWindow = yield* Ref.get(captureWindowRef);
    if (Option.isSome(captureWindow) && !captureWindow.value.isDestroyed()) {
      yield* attempt({ operation: "destroyCaptureWindow" }, () =>
        captureWindow.value.destroy(),
      ).pipe(Effect.ignore);
    }
    yield* Ref.set(captureWindowRef, Option.none());
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
    captureSurfaceFrame,
    closeTab,
    copyArtifactToClipboard,
    createTab,
    createNativeView,
    getTabState,
    goBack,
    goForward,
    hardReload,
    navigate,
    openDevTools,
    pickElement,
    refresh,
    setSurface,
    resetZoom: (tabId: string) => applyZoom(tabId, () => DEFAULT_ZOOM_FACTOR),
    revealArtifact,
    saveRecording,
    setAnnotationTheme,
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

export class PreviewNativeViewNotInitializedError extends Schema.TaggedErrorClass<PreviewNativeViewNotInitializedError>()(
  "PreviewNativeViewNotInitializedError",
  { tabId: Schema.String },
) {
  override get message(): string {
    return `Preview tab "${this.tabId}" has no native browser view`;
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

export class PreviewRecordingAlreadyActiveError extends Schema.TaggedErrorClass<PreviewRecordingAlreadyActiveError>()(
  "PreviewRecordingAlreadyActiveError",
  {
    requestedTabId: Schema.String,
    activeTabId: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot record preview tab ${this.requestedTabId} while tab ${this.activeTabId} is already recording`;
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
  PreviewNativeViewNotInitializedError,
  PreviewOperationError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewArtifactImageLoadError,
  PreviewRecordingAlreadyActiveError,
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
    readonly createTab: (tabId: string) => Effect.Effect<PreviewTabState, PreviewManagerError>;
    readonly getTabState: (tabId: string) => Effect.Effect<PreviewTabState | null>;
    readonly createNativeView: (
      tabId: string,
      environmentId: EnvironmentId,
      initialUrl: string | null,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly closeTab: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly setSurface: (
      tabId: string,
      bounds: Electron.Rectangle,
      visible: boolean,
      scale: number,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly navigate: (tabId: string, url: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goBack: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goForward: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly refresh: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomIn: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomOut: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly resetZoom: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly hardReload: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly openDevTools: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly clearCookies: () => Effect.Effect<void, PreviewManagerError>;
    readonly clearCache: () => Effect.Effect<void, PreviewManagerError>;
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
    readonly captureSurfaceFrame: (
      tabId: string,
    ) => Effect.Effect<DesktopPreviewSurfaceFrame, PreviewManagerError>;
    readonly revealArtifact: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly copyArtifactToClipboard: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly startRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly stopRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly saveRecording: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Effect.Effect<DesktopPreviewRecordingArtifact, PreviewManagerError>;
    readonly automationStatus: (
      tabId: string,
    ) => Effect.Effect<PreviewAutomationStatus, PreviewManagerError>;
    readonly automationSnapshot: (
      tabId: string,
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
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const browserSession = yield* BrowserSession.BrowserSession;
  const getBrowserSession = Effect.fn("PreviewManager.getNativeViewBrowserSession")(function* (
    scope: string,
  ) {
    return yield* browserSession
      .getSession(scope)
      .pipe(
        Effect.mapError(
          (cause) => new PreviewOperationError({ operation: "getBrowserSession", cause }),
        ),
      );
  });
  const operations = yield* makeNativeOperations(
    environment.browserArtifactsDir,
    getBrowserSession,
  );

  return PreviewManager.of({
    setMainWindow: operations.setMainWindow,
    createTab: operations.createTab,
    createNativeView: operations.createNativeView,
    getTabState: operations.getTabState,
    closeTab: operations.closeTab,
    setSurface: operations.setSurface,
    navigate: operations.navigate,
    goBack: operations.goBack,
    goForward: operations.goForward,
    refresh: operations.refresh,
    zoomIn: operations.zoomIn,
    zoomOut: operations.zoomOut,
    resetZoom: operations.resetZoom,
    hardReload: operations.hardReload,
    openDevTools: operations.openDevTools,
    clearCookies: Effect.fn("PreviewManager.clearCookies")(function* () {
      yield* browserSession
        .clearCookies()
        .pipe(
          Effect.mapError(
            (cause) => new PreviewOperationError({ operation: "clearCookies", cause }),
          ),
        );
    }),
    clearCache: Effect.fn("PreviewManager.clearCache")(function* () {
      yield* browserSession
        .clearCache()
        .pipe(
          Effect.mapError((cause) => new PreviewOperationError({ operation: "clearCache", cause })),
        );
    }),
    setAnnotationTheme: operations.setAnnotationTheme,
    pickElement: operations.pickElement,
    cancelPickElement: operations.cancelPickElement,
    captureScreenshot: operations.captureScreenshot,
    captureSurfaceFrame: operations.captureSurfaceFrame,
    revealArtifact: operations.revealArtifact,
    copyArtifactToClipboard: operations.copyArtifactToClipboard,
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
