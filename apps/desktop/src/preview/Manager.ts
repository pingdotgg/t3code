/**
 * Desktop side of the in-app browser preview.
 *
 * Hosts per-tab Chromium WebContents references (the actual <webview>
 * elements live in the renderer; we only attach listeners and forward state
 * here). Single layer-scoped browser session partition.
 */
import type {
  DesktopPreviewAnnotationTheme,
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
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import {
  type BrowserWindow,
  type Session,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
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
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
import { isPreviewAnnotationPayload } from "./PickedElementPayload.ts";
import { playwrightInjectedRuntimeInstallExpression } from "./PlaywrightInjectedRuntime.ts";

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

const automationError = (
  tag:
    | "PreviewAutomationExecutionError"
    | "PreviewAutomationInvalidSelectorError"
    | "PreviewAutomationResultTooLargeError"
    | "PreviewAutomationTimeoutError"
    | "PreviewAutomationControlInterruptedError",
  message: string,
  detail?: unknown,
): Error & { detail?: unknown } => {
  const error = new Error(message) as Error & { detail?: unknown };
  error.name = tag;
  if (detail !== undefined) error.detail = detail;
  return error;
};

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
      ),
    catch: (cause) => new PreviewManagerError({ operation: "captureAnnotationScreenshot", cause }),
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

type Listener = (tabId: string, state: PreviewTabState) => void;
type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => void;

type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

interface ManagedListeners {
  readonly scope: Scope.Closeable;
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

type PointerEventListener = (event: DesktopPreviewPointerEvent) => void;

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
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parentScope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const resolvedArtifactDirectory = path.resolve(artifactDirectory);
  const playwrightInstallExpression = yield* Effect.cached(
    playwrightInjectedRuntimeInstallExpression().pipe(
      Effect.mapError(
        (cause) =>
          new PreviewManagerError({
            operation: "ensurePlaywrightInjected",
            cause,
          }),
      ),
    ),
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
  const recordingTabIdRef = yield* Ref.make<Option.Option<string>>(Option.none());

  const fail = (operation: string, cause: unknown): PreviewManagerError =>
    new PreviewManagerError({ operation, cause });
  const attempt = <A>(operation: string, evaluate: () => A) =>
    Effect.try({ try: evaluate, catch: (cause) => fail(operation, cause) });
  const attemptPromise = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
    Effect.tryPromise({ try: evaluate, catch: (cause) => fail(operation, cause) });
  const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const currentMillis = Clock.currentTimeMillis;
  const encodeJson = (operation: string, value: unknown) =>
    encodeUnknownJson(value).pipe(Effect.mapError((cause) => fail(operation, cause)));
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

  const emit = Effect.fn("PreviewManager.emit")(function* (tabId: string, state: PreviewTabState) {
    const listeners = yield* Ref.get(listenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => Effect.sync(() => listener(tabId, state)).pipe(Effect.ignore),
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
    if (!tab) return yield* fail("requireWebContents", new PreviewTabNotFoundError(tabId));
    if (tab.webContentsId == null) {
      return yield* fail("requireWebContents", new PreviewWebviewNotInitializedError(tabId));
    }
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc) {
      return yield* fail(
        "requireWebContents",
        new PreviewWebContentsNotFoundError(tabId, tab.webContentsId),
      );
    }
    return wc;
  });

  const resolveArtifactPath = (artifactPath: string) =>
    attempt("resolveArtifactPath", () => {
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
              fail(
                "resolveArtifactPath",
                new Error("Preview artifact path is outside the configured artifact directory."),
              ),
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

  const ensureControlSession = Effect.fn("PreviewManager.ensureControlSession")(function* (
    wc: Electron.WebContents,
  ) {
    return yield* SynchronizedRef.modifyEffect(controlSessionsRef, (sessions) => {
      const existing = sessions.get(wc.id);
      if (existing) return Effect.succeed([existing, sessions] as const);
      if (wc.isDevToolsOpened()) {
        return Effect.fail(
          fail(
            "ensureControlSession",
            automationError(
              "PreviewAutomationExecutionError",
              "Close preview DevTools before using agent browser control.",
            ),
          ),
        );
      }
      if (wc.debugger.isAttached()) {
        return Effect.fail(
          fail(
            "ensureControlSession",
            automationError(
              "PreviewAutomationExecutionError",
              "Preview control cannot attach because another debugger owns this page.",
            ),
          ),
        );
      }
      const createControlSession = Effect.fn("PreviewManager.createControlSession")(function* () {
        const semaphore = yield* Semaphore.make(1);
        const scope = yield* Scope.fork(parentScope, "sequential");
        const handleDebuggerMessage = Effect.fn("PreviewManager.handleDebuggerMessage")(function* (
          method: string,
          params: Record<string, unknown>,
        ) {
          if (method === "Page.screencastFrame") {
            const sessionId = params["sessionId"];
            if (typeof sessionId === "number") {
              yield* attemptPromise("ackScreencastFrame", () =>
                wc.debugger.sendCommand("Page.screencastFrameAck", { sessionId }),
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
                width: typeof metadata["deviceWidth"] === "number" ? metadata["deviceWidth"] : 0,
                height: typeof metadata["deviceHeight"] === "number" ? metadata["deviceHeight"] : 0,
                receivedAt,
              };
              yield* Effect.forEach(
                listeners,
                (listener) => Effect.sync(() => listener(frame)).pipe(Effect.ignore),
                { discard: true },
              );
            }
          }
          yield* captureDiagnosticMessage(wc.id, method, params);
        });
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
              attempt("detachControlSession", () => {
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
          yield* attempt("attachDebuggerListeners", () => {
            wc.debugger.on("message", onMessage);
            wc.debugger.attach("1.3");
          });
          yield* Effect.all(
            ["Runtime.enable", "Accessibility.enable", "Network.enable", "Log.enable"].map(
              (method) =>
                attemptPromise("initializeDebugger", () => wc.debugger.sendCommand(method)),
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
    });
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

  const withControlSession = Effect.fn("PreviewManager.withControlSession")(function* <A>(
    tabId: string,
    wc: Electron.WebContents,
    action: string,
    use: (send: SendCommand) => Effect.Effect<A, PreviewManagerError>,
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
            return yield* fail(
              action,
              automationError(
                "PreviewAutomationControlInterruptedError",
                "Browser control was interrupted by human input.",
              ),
            );
          }
          const result = yield* attemptPromise(action, () =>
            wc.debugger.sendCommand(method, commandParams),
          );
          const after = (yield* Ref.get(controlEpochRef)).get(tabId) ?? 0;
          if (after !== epoch) {
            return yield* fail(
              action,
              automationError(
                "PreviewAutomationControlInterruptedError",
                "Browser control was interrupted by human input.",
              ),
            );
          }
          return result;
        },
      );
      return yield* use(send);
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
        const underlying = error instanceof PreviewManagerError ? error.cause : error;
        const interrupted =
          underlying instanceof Error &&
          underlying.name === "PreviewAutomationControlInterruptedError";
        yield* replaceAction(tabId, {
          ...actionEvent,
          status: interrupted ? "interrupted" : "failed",
          completedAt,
          error: underlying instanceof Error ? underlying.message : String(underlying),
        });
      }
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (tabs.has(tabId)) yield* update(tabId, { controller: "none" });
    });
    return yield* control.semaphore.withPermit(execute().pipe(Effect.onExit(finalize)));
  });

  const evaluateWithDebugger = <A = unknown>(
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
        return response.exceptionDetails
          ? Effect.fail(
              fail(
                "evaluate",
                automationError(
                  "PreviewAutomationExecutionError",
                  response.exceptionDetails.exception?.description ??
                    response.exceptionDetails.text ??
                    "JavaScript evaluation failed.",
                ),
              ),
            )
          : Effect.succeed(response.result?.value as A);
      }),
    );

  const automationLocator = (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): string | null => input.locator ?? (input.selector ? `css=${input.selector}` : null);

  const ensurePlaywrightInjected = Effect.fn("PreviewManager.ensurePlaywrightInjected")(function* (
    send: SendCommand,
  ) {
    const installed = yield* evaluateWithDebugger<boolean>(
      send,
      "Boolean(globalThis.__t3PlaywrightInjected)",
      true,
    );
    if (installed) return;
    const expression = yield* playwrightInstallExpression;
    yield* evaluateWithDebugger(send, expression, true);
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
    const syncState = Effect.fn("PreviewManager.syncWebContentsState")(function* () {
      if (wc.isDestroyed()) return;
      yield* update(tabId, {
        navStatus: computeNavStatus(wc),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    });
    const sync = () => runFork(syncState());
    const failed = (_event: Event, code: number, description: string): void => {
      if (code === -3) return;
      runFork(
        update(tabId, {
          navStatus: {
            kind: "LoadFailed",
            url: wc.getURL(),
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
      attempt("detachListeners", () => {
        wc.off("did-navigate", sync);
        wc.off("did-navigate-in-page", sync);
        wc.off("page-title-updated", sync);
        wc.off("did-start-loading", sync);
        wc.off("did-stop-loading", sync);
        wc.off("did-fail-load", failed as never);
        wc.off("before-input-event", beforeInput);
        wc.ipc.off(HUMAN_INPUT_CHANNEL, humanInput);
      }).pipe(Effect.ignore),
    );
    const install = Effect.fn("PreviewManager.installWebContentsListeners")(function* () {
      yield* attempt("attachListeners", () => {
        wc.on("did-navigate", sync);
        wc.on("did-navigate-in-page", sync);
        wc.on("page-title-updated", sync);
        wc.on("did-start-loading", sync);
        wc.on("did-stop-loading", sync);
        wc.on("did-fail-load", failed as never);
        wc.ipc.on(HUMAN_INPUT_CHANNEL, humanInput);
        wc.setWindowOpenHandler(({ url }) => {
          runFork(attemptPromise("openPreviewWindow", () => wc.loadURL(url)).pipe(Effect.ignore));
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

  const closeTab = Effect.fn("PreviewManager.closeTab")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) return;
    yield* cancelPickElement(tabId);
    if (tab.webContentsId != null) {
      yield* Effect.all(
        [detachControlSession(tab.webContentsId), detachListeners(tab.webContentsId)],
        { concurrency: 2, discard: true },
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

  const registerWebview = Effect.fn("PreviewManager.registerWebview")(function* (
    tabId: string,
    webContentsId: number,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return yield* fail("registerWebview", new PreviewTabNotFoundError(tabId));
    }
    const wc = webContents.fromId(webContentsId);
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (
      !wc ||
      wc.getType() !== "webview" ||
      (Option.isSome(mainWindow) && wc.hostWebContents !== mainWindow.value.webContents)
    ) {
      return yield* fail(
        "registerWebview",
        new PreviewWebContentsNotFoundError(tabId, webContentsId),
      );
    }
    const attached = yield* Ref.get(attachedRef);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    if (tab.webContentsId === webContentsId && attached.has(webContentsId)) {
      yield* attempt("registerWebview.sendTheme", () =>
        wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
      );
      return;
    }
    if (tab.webContentsId != null && tab.webContentsId !== webContentsId) {
      yield* Effect.all(
        [
          detachControlSession(tab.webContentsId),
          detachListeners(tab.webContentsId),
          cancelPickElement(tabId),
        ],
        { concurrency: 3, discard: true },
      );
    }
    yield* attachListeners(tabId, wc);
    runFork(ensureControlSession(wc).pipe(Effect.ignore));
    if (Math.abs(tab.zoomFactor - DEFAULT_ZOOM_FACTOR) > ZOOM_EPSILON) {
      yield* attempt("registerWebview.restoreZoom", () => wc.setZoomFactor(tab.zoomFactor)).pipe(
        Effect.ignore,
      );
    }
    yield* update(tabId, {
      webContentsId,
      navStatus: computeNavStatus(wc),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      zoomFactor: tab.zoomFactor,
    });
    yield* attempt("registerWebview.sendTheme", () =>
      wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme),
    );
  });

  const navigate = Effect.fn("PreviewManager.navigate")(function* (tabId: string, rawUrl: string) {
    const wc = yield* requireWebContents(tabId);
    const url = yield* attempt("navigate.normalizeUrl", () => normalizePreviewUrl(rawUrl));
    if (wc.getURL() === url) {
      yield* attempt("navigate.reload", () => wc.reload());
      return;
    }
    yield* attemptPromise("navigate.loadURL", () => wc.loadURL(url));
  });

  const withWebContents = Effect.fn("PreviewManager.withWebContents")(function* (
    operation: string,
    tabId: string,
    use: (wc: Electron.WebContents) => void,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* attempt(operation, () => use(wc));
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
      yield* attempt("openDevTools.focus", () => wc.devToolsWebContents?.focus());
      return;
    }
    yield* detachControlSession(wc.id);
    yield* attempt("openDevTools", () => {
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
          : attempt("setAnnotationTheme", () => wc.send(ANNOTATION_THEME_CHANNEL, theme)).pipe(
              Effect.ignore,
            );
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
          yield* attempt("pickElement.cleanup", () => {
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
              yield* attempt("cancelPickElement", () => activeWc.send(CANCEL_PICK_CHANNEL)).pipe(
                Effect.ignore,
              );
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
            captureAnnotationScreenshot(wc, cropRect).pipe(
              Effect.matchEffect({
                onFailure: () => Effect.sync(() => settle(payload)),
                onSuccess: (screenshot) => Effect.sync(() => settle({ ...payload, screenshot })),
              }),
              Effect.ensuring(
                attempt("pickElement.captureComplete", () => {
                  if (!wc.isDestroyed()) wc.send(ANNOTATION_CAPTURED_CHANNEL);
                }).pipe(Effect.ignore),
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
          yield* attempt("pickElement.register", () => {
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
        yield* attempt("applyZoom", () => wc.setZoomFactor(next));
      }
    }
    yield* update(tabId, { zoomFactor: next });
  });

  const captureScreenshot = Effect.fn("PreviewManager.captureScreenshot")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);
    const [createdAt, millis, image] = yield* Effect.all([
      currentIso,
      currentMillis,
      attemptPromise("captureScreenshot.capturePage", () => wc.capturePage()),
    ]);
    const id = `browser-screenshot-${artifactSiteSlug(wc.getURL())}-${millis.toString(36)}`;
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.png`);
    const data = image.toPNG();
    yield* fileSystem
      .makeDirectory(resolvedArtifactDirectory, { recursive: true })
      .pipe(Effect.mapError((cause) => fail("captureScreenshot.makeDirectory", cause)));
    yield* fileSystem
      .writeFile(artifactPath, data)
      .pipe(Effect.mapError((cause) => fail("captureScreenshot.writeFile", cause)));
    return {
      id,
      tabId,
      path: artifactPath,
      mimeType: "image/png" as const,
      sizeBytes: data.byteLength,
      createdAt,
    };
  });

  const startScreencast = Effect.fn("PreviewManager.startScreencast")(function* (
    send: SendCommand,
  ) {
    yield* send("Page.enable");
    yield* send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    });
  });

  const startRecording = Effect.fn("PreviewManager.startRecording")(function* (tabId: string) {
    const recordingTabId = yield* Ref.get(recordingTabIdRef);
    if (Option.isSome(recordingTabId) && recordingTabId.value !== tabId) {
      return yield* fail(
        "startRecording",
        new Error("Only one browser recording can be active per window."),
      );
    }
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "recording.start", startScreencast);
    yield* Ref.set(recordingTabIdRef, Option.some(tabId));
  });

  const stopRecording = Effect.fn("PreviewManager.stopRecording")(function* (tabId: string) {
    const recordingTabId = yield* Ref.get(recordingTabIdRef);
    if (Option.isNone(recordingTabId) || recordingTabId.value !== tabId) return;
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "recording.stop", (send) =>
      send("Page.stopScreencast").pipe(Effect.asVoid),
    );
    yield* Ref.set(recordingTabIdRef, Option.none());
  });

  const saveRecording = Effect.fn("PreviewManager.saveRecording")(function* (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    const [createdAt, millis] = yield* Effect.all([currentIso, currentMillis]);
    const id = `browser-recording-${millis.toString(36)}`;
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const artifactPath = path.join(resolvedArtifactDirectory, `${id}.${extension}`);
    yield* fileSystem
      .makeDirectory(resolvedArtifactDirectory, { recursive: true })
      .pipe(Effect.mapError((cause) => fail("saveRecording.makeDirectory", cause)));
    yield* fileSystem
      .writeFile(artifactPath, data)
      .pipe(Effect.mapError((cause) => fail("saveRecording.writeFile", cause)));
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
      const [accessibility, sourceImage, diagnostics, timelines] = yield* Effect.all([
        send("Accessibility.getFullAXTree"),
        attemptPromise("automationSnapshot.capturePage", () => wc.capturePage()),
        Ref.get(diagnosticsRef),
        Ref.get(actionTimelineRef),
      ]);
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
    return yield* withControlSession(tabId, wc, "snapshot", (send) =>
      captureAutomationSnapshot(tabId, wc, send),
    );
  });

  const resolveClickPoint = Effect.fn("PreviewManager.resolveClickPoint")(function* (
    send: SendCommand,
    input: PreviewAutomationClickInput,
  ) {
    if (!("selector" in input) && !("locator" in input)) {
      return { x: input.x!, y: input.y! };
    }
    const locator = automationLocator(input)!;
    yield* ensurePlaywrightInjected(send);
    const locatorJson = yield* encodeJson("automationClick.encodeLocator", locator);
    const point = yield* evaluateWithDebugger<
      { x: number; y: number } | { invalidSelector: true; message: string } | { notFound: true }
    >(
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
      return yield* fail(
        "automationClick",
        automationError("PreviewAutomationInvalidSelectorError", point.message, {
          selector: locator,
        }),
      );
    }
    if ("notFound" in point) {
      return yield* fail(
        "automationClick",
        automationError(
          "PreviewAutomationExecutionError",
          `No element matches locator ${locator}.`,
        ),
      );
    }
    return point;
  });

  const emitPointerEvent = Effect.fn("PreviewManager.emitPointerEvent")(function* (
    event: DesktopPreviewPointerEvent,
  ) {
    const listeners = yield* Ref.get(pointerEventListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => Effect.sync(() => listener(event)).pipe(Effect.ignore),
      { discard: true },
    );
  });

  const performAutomationClick = Effect.fn("PreviewManager.performAutomationClick")(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
    send: SendCommand,
  ) {
    yield* Effect.all(
      [send("Runtime.enable"), send("Input.setIgnoreInputEvents", { ignore: false })],
      { concurrency: 2, discard: true },
    );
    const point = yield* resolveClickPoint(send, input);
    const viewport = yield* evaluateWithDebugger<{ width: number; height: number }>(
      send,
      "({ width: window.innerWidth, height: window.innerHeight })",
      true,
    );
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
      return yield* fail(
        "automationClick",
        automationError(
          "PreviewAutomationExecutionError",
          `Click coordinates (${point.x}, ${point.y}) are outside the preview viewport.`,
        ),
      );
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

  const focusAutomationTarget = Effect.fn("PreviewManager.focusAutomationTarget")(function* (
    send: SendCommand,
    input: PreviewAutomationTypeInput,
  ) {
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(send);
    const locatorJson = locator ? yield* encodeJson("automationType.encodeLocator", locator) : null;
    const result = yield* evaluateWithDebugger<
      { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
    >(
      send,
      `(() => {
          try {
            const element = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : "document.activeElement"};
            if (!element) return { notFound: true };
            element.focus();
            if (${input.clear ?? false}) {
              if ("value" in element) element.value = "";
              else if (element.isContentEditable) element.textContent = "";
              element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
            }
            return { ok: true };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      true,
    );
    if ("invalidSelector" in result) {
      return yield* fail(
        "automationType",
        automationError("PreviewAutomationInvalidSelectorError", result.message, {
          selector: input.selector ?? "",
        }),
      );
    }
    if ("notFound" in result) {
      return yield* fail(
        "automationType",
        automationError(
          "PreviewAutomationExecutionError",
          locator
            ? `No element matches locator ${locator}.`
            : "No element is focused in the preview.",
        ),
      );
    }
  });

  const performAutomationType = Effect.fn("PreviewManager.performAutomationType")(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
    send: SendCommand,
  ) {
    yield* send("Runtime.enable");
    yield* focusAutomationTarget(send, input);
    yield* send("Input.insertText", { text: input.text });
    const textJson = yield* encodeJson("automationType.encodeText", input.text);
    yield* evaluateWithDebugger(
      send,
      `(() => {
        const element = document.activeElement;
        element?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${textJson} }));
        element?.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
      false,
    );
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
  ) {
    const modifiers = (input.modifiers ?? []).reduce((value, modifier) => {
      switch (modifier) {
        case "Alt":
          return value | 1;
        case "Control":
          return value | 2;
        case "Meta":
          return value | 4;
        case "Shift":
          return value | 8;
      }
    }, 0);
    const key = input.key;
    const text = key.length === 1 ? key : undefined;
    const params = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      modifiers,
      ...(text ? { text, unmodifiedText: text } : {}),
    };
    yield* expectAgentInput(tabId, { kind: "key", key, code: params.code });
    yield* send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
    yield* send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  });

  const automationPress = Effect.fn("PreviewManager.automationPress")(function* (
    tabId: string,
    input: PreviewAutomationPressInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "press", (send) =>
      performAutomationPress(tabId, input, send),
    );
  });

  const performAutomationScroll = Effect.fn("PreviewManager.performAutomationScroll")(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
    send: SendCommand,
  ) {
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(send);
    const locatorJson = locator
      ? yield* encodeJson("automationScroll.encodeLocator", locator)
      : null;
    const result = yield* evaluateWithDebugger<
      { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
    >(
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
      return yield* fail(
        "automationScroll",
        automationError("PreviewAutomationInvalidSelectorError", result.message, {
          selector: input.selector ?? "",
        }),
      );
    }
    if ("notFound" in result) {
      return yield* fail(
        "automationScroll",
        automationError(
          "PreviewAutomationExecutionError",
          `No element matches locator ${locator}.`,
        ),
      );
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
    function* (input: PreviewAutomationEvaluateInput, send: SendCommand) {
      yield* send("Runtime.enable");
      const value = yield* evaluateWithDebugger(
        send,
        input.expression,
        input.returnByValue ?? true,
        input.awaitPromise ?? true,
      );
      const serialized = yield* encodeJson("automationEvaluate.encodeResult", value);
      if (Buffer.byteLength(serialized, "utf8") > MAX_EVALUATION_BYTES) {
        return yield* fail(
          "automationEvaluate",
          automationError(
            "PreviewAutomationResultTooLargeError",
            `Evaluation result exceeds ${MAX_EVALUATION_BYTES} bytes.`,
            { maximumBytes: MAX_EVALUATION_BYTES },
          ),
        );
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
      performAutomationEvaluate(input, send),
    );
  });

  const performAutomationWaitFor = Effect.fn("PreviewManager.performAutomationWaitFor")(function* (
    input: PreviewAutomationWaitForInput,
    send: SendCommand,
  ) {
    const timeoutMs = input.timeoutMs ?? 15_000;
    yield* send("Runtime.enable");
    const locator = automationLocator(input);
    if (locator) yield* ensurePlaywrightInjected(send);
    const [locatorJson, textJson, urlIncludesJson] = yield* Effect.all([
      locator ? encodeJson("automationWaitFor.encodeLocator", locator) : Effect.succeed(null),
      input.text ? encodeJson("automationWaitFor.encodeText", input.text) : Effect.succeed(null),
      input.urlIncludes
        ? encodeJson("automationWaitFor.encodeUrl", input.urlIncludes)
        : Effect.succeed(null),
    ]);
    const deadline = (yield* currentMillis) + timeoutMs;
    while ((yield* currentMillis) <= deadline) {
      const result = yield* evaluateWithDebugger<
        { matched: boolean } | { invalidSelector: true; message: string }
      >(
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
        return yield* fail(
          "automationWaitFor",
          automationError("PreviewAutomationInvalidSelectorError", result.message, {
            selector: input.selector ?? "",
          }),
        );
      }
      if (result.matched) return;
      yield* Effect.sleep(100);
    }
    return yield* fail(
      "automationWaitFor",
      automationError(
        "PreviewAutomationTimeoutError",
        `Preview condition did not match within ${timeoutMs}ms.`,
      ),
    );
  });

  const automationWaitFor = Effect.fn("PreviewManager.automationWaitFor")(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
  ) {
    const wc = yield* requireWebContents(tabId);
    yield* withControlSession(tabId, wc, "waitFor", (send) =>
      performAutomationWaitFor(input, send),
    );
  });

  const revealArtifact = Effect.fn("PreviewManager.revealArtifact")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);
    yield* attempt("revealArtifact", () => shell.showItemInFolder(resolvedPath));
  });

  const copyArtifactToClipboard = Effect.fn("PreviewManager.copyArtifactToClipboard")(function* (
    artifactPath: string,
  ) {
    const resolvedPath = yield* resolveArtifactPath(artifactPath);
    const image = yield* attempt("copyArtifactToClipboard.load", () =>
      nativeImage.createFromPath(resolvedPath),
    );
    if (image.isEmpty()) {
      return yield* fail(
        "copyArtifactToClipboard",
        new Error("Preview artifact could not be loaded as an image."),
      );
    }
    yield* attempt("copyArtifactToClipboard.write", () => clipboard.writeImage(image));
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
    pickElement,
    refresh,
    registerWebview,
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

export class PreviewTabNotFoundError extends Error {
  readonly tabId: string;
  constructor(tabId: string) {
    super(`Preview tab not found: ${tabId}`);
    this.name = "PreviewTabNotFoundError";
    this.tabId = tabId;
  }
}

export class PreviewWebContentsNotFoundError extends Error {
  readonly tabId: string;
  readonly webContentsId: number;
  constructor(tabId: string, webContentsId: number) {
    super(`WebContents ${webContentsId} not found for preview tab ${tabId}`);
    this.name = "PreviewWebContentsNotFoundError";
    this.tabId = tabId;
    this.webContentsId = webContentsId;
  }
}

export class PreviewWebviewNotInitializedError extends Error {
  readonly tabId: string;
  constructor(tabId: string) {
    super(`Preview tab "${tabId}" has no webview registered`);
    this.name = "PreviewWebviewNotInitializedError";
    this.tabId = tabId;
  }
}

export class PreviewManagerError extends Data.TaggedError("PreviewManagerError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Desktop preview operation failed: ${this.operation}`;
  }
}

export interface PreviewManagerShape {
  readonly setMainWindow: (window: BrowserWindow) => Effect.Effect<void, PreviewManagerError>;
  readonly getBrowserSession: (scope?: string) => Effect.Effect<Session, PreviewManagerError>;
  readonly isBrowserPartition: (partition: string) => boolean;
  readonly createTab: (tabId: string) => Effect.Effect<PreviewTabState, PreviewManagerError>;
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
  readonly openDevTools: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly clearCookies: () => Effect.Effect<void, PreviewManagerError>;
  readonly clearCache: () => Effect.Effect<void, PreviewManagerError>;
  readonly getBrowserPartition: (scope?: string) => Effect.Effect<string, PreviewManagerError>;
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

export class PreviewManager extends Context.Service<PreviewManager, PreviewManagerShape>()(
  "@t3tools/desktop/preview/Manager/PreviewManager",
) {}

const make = Effect.gen(function* PreviewManagerMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const browserSession = yield* BrowserSession.BrowserSession;
  const operations = yield* makeNativeOperations(environment.browserArtifactsDir);
  const browserSessionEffect = <A>(
    operation: string,
    effect: Effect.Effect<A, BrowserSession.BrowserSessionError>,
  ): Effect.Effect<A, PreviewManagerError> =>
    effect.pipe(Effect.mapError((cause) => new PreviewManagerError({ operation, cause })));

  return PreviewManager.of({
    setMainWindow: operations.setMainWindow,
    getBrowserSession: Effect.fn("PreviewManager.getBrowserSession")(function* (scope) {
      return yield* browserSessionEffect("getBrowserSession", browserSession.getSession(scope));
    }),
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
    openDevTools: operations.openDevTools,
    clearCookies: Effect.fn("PreviewManager.clearCookies")(function* () {
      yield* browserSessionEffect("clearCookies", browserSession.clearCookies());
    }),
    clearCache: Effect.fn("PreviewManager.clearCache")(function* () {
      yield* browserSessionEffect("clearCache", browserSession.clearCache());
    }),
    getBrowserPartition: Effect.fn("PreviewManager.getBrowserPartition")(function* (scope) {
      return yield* browserSessionEffect("getBrowserPartition", browserSession.getPartition(scope));
    }),
    setAnnotationTheme: operations.setAnnotationTheme,
    pickElement: operations.pickElement,
    cancelPickElement: operations.cancelPickElement,
    captureScreenshot: operations.captureScreenshot,
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
