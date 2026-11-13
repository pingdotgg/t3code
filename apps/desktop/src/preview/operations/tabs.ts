/**
 * Preview tab lifecycle: create, close, zoom and the main window reference.
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
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  DEFAULT_ZOOM_FACTOR,
  ZOOM_EPSILON,
  normalizeZoomFactor,
} from "../geometry.ts";
import type {
  PreviewTabState,
} from "../types.ts";
import type { WindowOps } from "./window.ts";
import type { SessionOps } from "./session.ts";
import type { PipOps } from "./pip.ts";
import type { State } from "./state.ts";

export const makeTabsOps = (deps: State & WindowOps & SessionOps & PipOps) => {
  const {
    runFork,
    annotationSendEnabled,
    mainWindowRef,
    tabsRef,
    frameCaptureSessionsRef,
    closingTabIdsRef,
    tabLifecycleGenerations,
    attempt,
    currentIso,
    replaceMap,
    update,
    emit,
    withTabLifecycleLock,
  } = deps;
  const m = deps.mutable;
  const setMainWindow = Effect.fn("PreviewManager.setMainWindow")(function* (
    window: BrowserWindow,
  ) {
    if (m.mainWindowCleanupFiber) {
      yield* Fiber.join(m.mainWindowCleanupFiber);
      m.mainWindowCleanupFiber = undefined;
    }
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) =>
      Effect.gen(function* () {
        // Cleanup or lock acquisition can outlive the replacement window.
        if (window.isDestroyed()) return [undefined, sessions] as const;
        if (sessions.size > 0) {
          yield* deps.setWindowBackgroundThrottling(window, false);
        }
        yield* Ref.set(mainWindowRef, Option.some(window));
        m.currentMainWindow = window;
        m.frameCaptureWindowOpen = true;
        window.once("closed", () => {
          if (m.currentMainWindow !== window) return;
          m.currentMainWindow = undefined;
          m.frameCaptureWindowOpen = false;
          m.mainWindowCleanupFiber = runFork(
            Effect.all([deps.closeAllPictureInPicture(), deps.stopAllRecordings()], {
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
          zoomFactor: normalizeZoomFactor(defaults?.zoomFactor),
          pictureInPicture: false,
          colorScheme: defaults?.colorScheme ?? "system",
          ...(defaults?.serverTab === undefined ? {} : { serverTab: defaults.serverTab }),
          audioMuted: false,
          audible: false,
          controller: "none",
          capturing: false,
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

  const clearPendingRecording = (tabId: string) => {
    if (m.pendingRecording?.tabId === tabId) m.pendingRecording = null;
  };

  /** Display-media requests lack tab identity; only one tab may arm a recording to prevent stream redirection. */

  const closeTabUnlocked = Effect.fn("PreviewManager.closeTabUnlocked")(function* (tabId: string) {
    if (!(yield* SynchronizedRef.get(tabsRef)).has(tabId)) return;
    clearPendingRecording(tabId);
    annotationSendEnabled.delete(tabId);
    yield* Effect.all(
      [
        deps.cancelPickElement(tabId),
        deps.closePictureInPicture(tabId),
        deps.stopFrameCapture(tabId, "recording"),
      ],
      {
        concurrency: 3,
        discard: true,
      },
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
        [
          deps.detachControlSession(closedTab.webContentsId, closedTab.serverTab),
          deps.detachListeners(closedTab.webContentsId),
        ],
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
      audioMuted: false,
      audible: false,
      controller: "none",
      capturing: false,
      updatedAt,
    };
    yield* emit(tabId, closed);
  });

  const closeTab = Effect.fn("PreviewManager.closeTab")(function* (tabId: string) {
    const claimed = yield* Ref.modify(closingTabIdsRef, (closingTabIds) => {
      if (closingTabIds.has(tabId)) return [false, closingTabIds] as const;
      return [true, new Set([...closingTabIds, tabId])] as const;
    });
    if (!claimed) return;
    return yield* withTabLifecycleLock(tabId, closeTabUnlocked(tabId)).pipe(
      Effect.ensuring(
        Ref.update(closingTabIdsRef, (closingTabIds) => {
          if (!closingTabIds.has(tabId)) return closingTabIds;
          const next = new Set(closingTabIds);
          next.delete(tabId);
          return next;
        }),
      ),
    );
  });

  const reapplyZoom = Effect.fn("PreviewManager.reapplyZoom")(function* () {
    const tabIds = Array.from((yield* SynchronizedRef.get(tabsRef)).keys());
    yield* Effect.forEach(tabIds, deps.assertTabZoom, { discard: true });
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
        yield* attempt({ operation: "applyZoom", tabId, webContentsId: wc.id }, () =>
          wc.setZoomFactor(next),
        );
      }
    }
    yield* update(tabId, { zoomFactor: next });
  });

  // Media emulation belongs to the debugger session and must be restored after every reattach.

  return { setMainWindow, createTabUnlocked, createTab, clearPendingRecording, closeTabUnlocked, closeTab, reapplyZoom, applyZoom };
};

export type TabsOps = ReturnType<typeof makeTabsOps>;
