/**
 * Desktop preview operations surface returned to the manager.
 */
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
import * as Effect from "effect/Effect";
import {
  DEFAULT_ZOOM_FACTOR,
  nextZoomLevel,
  normalizeZoomFactor,
} from "../geometry.ts";
import type {
  Listener,
  OpenLinkListener,
  PointerEventListener,
  RecordingInputListener,
} from "../types.ts";
import type { WindowOps } from "./window.ts";
import type { ListenersOps } from "./listeners.ts";
import type { SessionOps } from "./session.ts";
import type { AttachOps } from "./attach.ts";
import type { CaptureOps } from "./capture.ts";
import type { PipOps } from "./pip.ts";
import type { TabsOps } from "./tabs.ts";
import type { WebviewsOps } from "./webviews.ts";
import type { RecordingOps } from "./recording.ts";
import type { ArtifactsOps } from "./artifacts.ts";
import type { DestroyOps } from "./destroy.ts";
import type { State } from "./state.ts";

export const makeOperations = Effect.fnUntraced(function* (deps: State & WindowOps & ListenersOps & SessionOps & AttachOps & CaptureOps & PipOps & TabsOps & WebviewsOps & RecordingOps & ArtifactsOps & DestroyOps) {
  const {
    listenersRef,
    pointerEventListenersRef,
    openLinkListenersRef,
    recordingInputListenersRef,
  } = deps;
  const m = deps.mutable;
  yield* Effect.addFinalizer(() => deps.destroy().pipe(Effect.ignore));

  return {
    cancelPickElement: deps.cancelPickElement,
    captureScreenshot: deps.captureScreenshot,
    closeTab: deps.closeTab,
    copyArtifactToClipboard: deps.copyArtifactToClipboard,
    createTab: deps.createTab,
    goBack: deps.goBack,
    goForward: deps.goForward,
    hardReload: deps.hardReload,
    navigate: deps.navigate,
    openPictureInPicture: deps.openPictureInPicture,
    openDevTools: deps.openDevTools,
    pickElement: deps.pickElement,
    prepareWebview: deps.prepareWebview,
    reapplyZoom: deps.reapplyZoom,
    refresh: deps.refresh,
    registerWebview: deps.registerWebview,
    resetZoom: (tabId: string) => deps.applyZoom(tabId, () => DEFAULT_ZOOM_FACTOR),
    setZoomFactor: (tabId: string, zoomFactor: number) =>
      deps.applyZoom(tabId, () => normalizeZoomFactor(zoomFactor)),
    revealArtifact: deps.revealArtifact,
    saveRecording: deps.saveRecording,
    setAnnotationTheme: deps.setAnnotationTheme,
    setAnnotationSendEnabled: deps.setAnnotationSendEnabled,
    setAudioMuted: deps.setAudioMuted,
    setColorScheme: deps.setColorScheme,
    setMainWindow: deps.setMainWindow,
    setForwardedShortcuts: (shortcuts: ReadonlyArray<PreviewForwardedShortcut>) =>
      Effect.sync(() => {
        m.forwardedShortcuts = shortcuts;
      }),
    startRecording: deps.startRecording,
    closePictureInPicture: deps.closePictureInPicture,
    stopRecording: deps.stopRecording,
    subscribePointerEvents: (listener: PointerEventListener) =>
      deps.subscribe(pointerEventListenersRef, listener),
    subscribeOpenLinks: (listener: OpenLinkListener) => deps.subscribe(openLinkListenersRef, listener),
    subscribeRecordingInputs: (listener: RecordingInputListener) =>
      deps.subscribe(recordingInputListenersRef, listener),
    subscribeStateChanges: (listener: Listener) => deps.subscribe(listenersRef, listener),
    zoomIn: (tabId: string) => deps.applyZoom(tabId, (current) => nextZoomLevel(current, "in")),
    zoomOut: (tabId: string) => deps.applyZoom(tabId, (current) => nextZoomLevel(current, "out")),
  };
});
