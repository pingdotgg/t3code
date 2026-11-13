import * as NodeZlib from "node:zlib";
import {
  DesktopPreviewRecordingInputSchema,
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
} from "@t3tools/contracts";
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewFavicon,
  DesktopPreviewOpenLinkEvent,
  DesktopPreviewPointerEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  PreviewAnnotationSubmissionResult,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewRecordingInputEvent,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabDefaults,
  PreviewForwardedShortcut,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { matchesKeybindingShortcut } from "@t3tools/shared/keybindings";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import {
  BrowserWindow,
  ClipboardItem,
  app,
  type Session,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from "electron";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import { MENU_ACTION_CHANNEL, PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from "../ipc/channels.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewPasskeys from "./Passkeys.ts";
import * as BrowserSession from "./BrowserSession.ts";
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_SEND_ENABLED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  MOUSE_NAVIGATE_CHANNEL,
  RECORDING_CURSOR_CHANNEL,
  RECORDING_INPUT_CHANNEL,
  RECORDING_CONTROLLER_CHANNEL,
  RECORDING_POINTER_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
import { isPreviewAnnotationPayload } from "./PickedElementPayload.ts";
import { captureFavicon, safeHttpOrigin, selectFaviconCandidates } from "./FaviconCapture.ts";
import { DEFAULT_RECORDING_INPUT_OPTIONS, type RecordingInputOptions } from "./RecordingInput.ts";


import { createOperationsState } from "./operations/state.ts";
import { makeWindowOps } from "./operations/window.ts";
import { makeListenersOps } from "./operations/listeners.ts";
import { makeSessionOps } from "./operations/session.ts";
import { makeAttachOps } from "./operations/attach.ts";
import { makeCaptureOps } from "./operations/capture.ts";
import { makePipOps } from "./operations/pip.ts";
import { makeTabsOps } from "./operations/tabs.ts";
import { makeWebviewsOps } from "./operations/webviews.ts";
import { makeRecordingOps } from "./operations/recording.ts";
import { makeArtifactsOps } from "./operations/artifacts.ts";
import { makeDestroyOps } from "./operations/destroy.ts";
import { makeOperations } from "./operations/runtime.ts";
import type {
  BrowserControlSession,
  FrameCaptureSession,
  Listener,
  ManagedListeners,
  OpenLinkListener,
  PendingRecording,
  PickSession,
  PictureInPictureSession,
  PointerEventListener,
  PreviewInputSignal,
  PreviewNavStatus,
  PreviewOperationContext,
  PreviewTabState,
  RecordingInputListener,
} from "./types.ts";
import {
  PreviewManagerError,
  PreviewOperationError,
  isPreviewOperationError,
} from "./errors.ts";

export { fitPictureInPictureContentSize } from "./geometry.ts";
export { isPreviewEditingShortcut, previewWindowOpenAction } from "./predicates.ts";
export type { PreviewNavStatus, PreviewTabState } from "./types.ts";
export {
  PreviewArtifactImageLoadError,
  PreviewArtifactPathOutsideDirectoryError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationDevToolsOpenError,
  PreviewMainWindowClosedError,
  PreviewManagerError,
  PreviewOperationError,
  PreviewRecordingArmConflictError,
  PreviewRecordingCaptureUnavailableError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
} from "./errors.ts";


const makeNativeOperations = Effect.fn("PreviewManager.makeOperations")(function* (
  artifactDirectory: string,
  pictureInPicturePreloadPath: string,
) {
  const state = yield* createOperationsState({ artifactDirectory, pictureInPicturePreloadPath });

  // Installed in dependency order; each layer may call every layer above it.
  const withWindow = Object.assign(state, makeWindowOps(state));
  const withListeners = Object.assign(withWindow, makeListenersOps(withWindow));
  const withSession = Object.assign(withListeners, makeSessionOps(withListeners));
  const withAttach = Object.assign(withSession, makeAttachOps(withSession));
  const withCapture = Object.assign(withAttach, makeCaptureOps(withAttach));
  const withPip = Object.assign(withCapture, makePipOps(withCapture));
  const withTabs = Object.assign(withPip, makeTabsOps(withPip));
  const withWebviews = Object.assign(withTabs, makeWebviewsOps(withTabs));
  const withRecording = Object.assign(withWebviews, makeRecordingOps(withWebviews));
  const withArtifacts = Object.assign(withRecording, makeArtifactsOps(withRecording));
  const withDestroy = Object.assign(withArtifacts, makeDestroyOps(withArtifacts));

  return yield* makeOperations(withDestroy);
});


export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly setMainWindow: (window: BrowserWindow) => Effect.Effect<void, PreviewManagerError>;
    readonly setForwardedShortcuts: (
      shortcuts: ReadonlyArray<PreviewForwardedShortcut>,
    ) => Effect.Effect<void>;
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
    readonly prepareWebview: (webContents: Electron.WebContents) => Effect.Effect<void>;
    readonly navigate: (tabId: string, url: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goBack: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly goForward: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly refresh: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomIn: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly zoomOut: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly resetZoom: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly reapplyZoom: () => Effect.Effect<void>;
    readonly hardReload: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly setColorScheme: (
      tabId: string,
      colorScheme: DesktopPreviewColorScheme,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly setZoomFactor: (
      tabId: string,
      zoomFactor: number,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly setAudioMuted: (
      tabId: string,
      audioMuted: boolean,
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
    readonly setAnnotationSendEnabled: (
      tabId: string,
      enabled: boolean,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly pickElement: (
      tabId: string,
    ) => Effect.Effect<PreviewAnnotationSubmissionResult | null, PreviewManagerError>;
    readonly cancelPickElement: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly captureScreenshot: (
      tabId: string,
    ) => Effect.Effect<DesktopPreviewScreenshotArtifact, PreviewManagerError>;
    readonly revealArtifact: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly copyArtifactToClipboard: (path: string) => Effect.Effect<void, PreviewManagerError>;
    readonly openPictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly closePictureInPicture: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly startRecording: (
      tabId: string,
      options?: RecordingInputOptions,
    ) => Effect.Effect<void, PreviewManagerError>;
    readonly stopRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
    readonly saveRecording: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Effect.Effect<DesktopPreviewRecordingArtifact, PreviewManagerError>;
    readonly subscribeStateChanges: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribePointerEvents: (
      listener: PointerEventListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeOpenLinks: (
      listener: OpenLinkListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly subscribeRecordingInputs: (
      listener: RecordingInputListener,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/preview/Manager/PreviewManager") {}

/** @public */
export const make = Effect.gen(function* PreviewManagerMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const browserSession = yield* BrowserSession.BrowserSession;
  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
  const downloadSessions = new WeakSet<Electron.Session>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runForkDownload = Effect.runForkWith(yield* Effect.context<never>());
  const copyToDownloads = Effect.fn("PreviewManager.copyToDownloads")(function* (
    source: string,
    fileName: string,
  ) {
    const directory = app.getPath("downloads");
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension) || "download";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const target = path.join(
        directory,
        attempt === 0 ? `${stem}${extension}` : `${stem} (${attempt})${extension}`,
      );
      if (yield* fileSystem.exists(target)) continue;
      yield* fileSystem.copyFile(source, target);
      shell.showItemInFolder(target);
      return;
    }
  });
  const placeServerDownloads = (session: Electron.Session) => {
    if (downloadSessions.has(session)) return;
    downloadSessions.add(session);
    session.on("will-download", (_event, item, source) => {
      // Decided before the server's path is set: placing it consumes the guid.
      const human = browserHost.humanStartedDownload(source);
      if (!browserHost.placeDownload(source, item) || !human) return;
      item.once("done", (_doneEvent, state) => {
        if (state !== "completed") return;
        runForkDownload(
          copyToDownloads(item.getSavePath(), item.getFilename()).pipe(
            Effect.catch((error) =>
              Effect.logWarning("preview download copy failed", { cause: error }),
            ),
          ),
        );
      });
    });
  };

  const operations = yield* makeNativeOperations(
    environment.browserArtifactsDir,
    environment.path.join(environment.dirname, "preview-pip-preload.cjs"),
  );

  return PreviewManager.of({
    setMainWindow: operations.setMainWindow,
    setForwardedShortcuts: operations.setForwardedShortcuts,
    getBrowserSession: Effect.fn("PreviewManager.getBrowserSession")(
      function* (scope, persistent, namespace) {
        const session = yield* browserSession
          .getSession(scope, persistent, namespace)
          .pipe(
            Effect.mapError(
              (cause) => new PreviewOperationError({ operation: "getBrowserSession", cause }),
            ),
          );
        placeServerDownloads(session);
        passkeys.installSessionHandlers(session);
        return session;
      },
    ),
    isBrowserPartition: browserSession.isPartition,
    createTab: operations.createTab,
    closeTab: operations.closeTab,
    registerWebview: operations.registerWebview,
    prepareWebview: operations.prepareWebview,
    navigate: operations.navigate,
    goBack: operations.goBack,
    goForward: operations.goForward,
    refresh: operations.refresh,
    zoomIn: operations.zoomIn,
    zoomOut: operations.zoomOut,
    resetZoom: operations.resetZoom,
    reapplyZoom: operations.reapplyZoom,
    hardReload: operations.hardReload,
    setColorScheme: operations.setColorScheme,
    setZoomFactor: operations.setZoomFactor,
    setAudioMuted: operations.setAudioMuted,
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
    setAnnotationSendEnabled: operations.setAnnotationSendEnabled,
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
    subscribeStateChanges: operations.subscribeStateChanges,
    subscribePointerEvents: operations.subscribePointerEvents,
    subscribeOpenLinks: operations.subscribeOpenLinks,
    subscribeRecordingInputs: operations.subscribeRecordingInputs,
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
