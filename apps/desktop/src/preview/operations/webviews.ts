/**
 * Preview webview registration, navigation, devtools and element picking.
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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SynchronizedRef from "effect/SynchronizedRef";
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
} from "../GuestProtocol.ts";
import { isPreviewAnnotationPayload } from "../PickedElementPayload.ts";
import {
  PreviewManagerError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
} from "../errors.ts";
import {
  DEFAULT_ZOOM_FACTOR,
  cropAnnotationScreenshot,
  normalizeCaptureRect,
} from "../geometry.ts";
import type {
  PickSession,
  PreviewTabState,
} from "../types.ts";
import type { WindowOps } from "./window.ts";
import type { ListenersOps } from "./listeners.ts";
import type { SessionOps } from "./session.ts";
import type { AttachOps } from "./attach.ts";
import type { TabsOps } from "./tabs.ts";
import type { State } from "./state.ts";

export const makeWebviewsOps = (deps: State & WindowOps & ListenersOps & SessionOps & AttachOps & TabsOps) => {
  const {
    rendererHistory,
    runFork,
    annotationThemeRef,
    annotationSendEnabled,
    mainWindowRef,
    tabsRef,
    attachedRef,
    pickSessionsRef,
    closingTabIdsRef,
    tabLifecycleGenerations,
    attempt,
    attemptPromise,
    capturePageWithRetry,
    currentIso,
    replaceMap,
    update,
    emitIfCurrent,
    withTabLifecycleLock,
  } = deps;
  const m = deps.mutable;
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
      wc.isDestroyed() ||
      wc.getType() !== "webview" ||
      (Option.isSome(mainWindow) && wc.hostWebContents !== mainWindow.value.webContents)
    ) {
      return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId });
    }
    yield* rendererHistory.register(wc, { surface: "preview", tabId });
    const attached = yield* Ref.get(attachedRef);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    const currentAttachment = attached.get(webContentsId);
    yield* deps.keepFrameCaptureWebContentsUnthrottled(tabId, wc);
    if (tab.webContentsId === webContentsId && currentAttachment?.webContents === wc) {
      yield* deps.assertTabZoom(tabId);
      yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () => {
        wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme);
        wc.send(ANNOTATION_SEND_ENABLED_CHANNEL, annotationSendEnabled.get(tabId) === true);
      });
      return;
    }
    const replacedWebContentsId =
      tab.webContentsId != null &&
      (tab.webContentsId !== webContentsId || currentAttachment?.webContents !== wc)
        ? tab.webContentsId
        : null;
    if (replacedWebContentsId !== null) {
      deps.clearPendingRecording(tabId);
      yield* Effect.all(
        [
          deps.detachControlSession(replacedWebContentsId),
          deps.detachListeners(replacedWebContentsId),
          deps.cancelPickElement(tabId),
        ],
        { concurrency: 3, discard: true },
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
    // Restore the tab's zoom before publishing the guest so it never paints at inherited app zoom.
    yield* attempt({ operation: "registerWebview.restoreZoomFactor", tabId, webContentsId }, () =>
      wc.setZoomFactor(currentTab.zoomFactor),
    );
    // Replacement guests start unmuted; restore mute before publishing them.
    yield* attempt({ operation: "registerWebview.restoreAudioMuted", tabId, webContentsId }, () =>
      wc.setAudioMuted(currentTab.audioMuted),
    );
    yield* deps.attachListeners(tabId, wc);
    const readAudible = attempt(
      { operation: "registerWebview.readAudible", tabId, webContentsId },
      () => wc.isCurrentlyAudible(),
    ).pipe(Effect.orElseSucceed(() => false));
    const attachedAudible = yield* readAudible;
    const registeredAt = yield* currentIso;
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
        const { favicon: _favicon, ...currentWithoutFavicon } = current;
        const next: PreviewTabState = {
          ...currentWithoutFavicon,
          webContentsId,
          navStatus: pendingUrl === null ? deps.computeNavStatus(wc) : current.navStatus,
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          audible: attachedAudible,
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
      yield* Effect.all([deps.detachControlSession(webContentsId), deps.detachListeners(webContentsId)], {
        concurrency: 2,
        discard: true,
      });
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    const { state: registered, pendingUrl } = registration.value;
    // Concurrent actions targeted the previous guest; reconcile this one with committed zoom and mute.
    yield* deps.assertTabZoom(tabId);
    yield* deps.assertTabAudioMuted(tabId).pipe(Effect.ignore);
    runFork(deps.restoreControlSession(tabId, wc));
    yield* emitIfCurrent(tabId, registered);
    // Ownership checks dropped pre-attach audibility events; reconcile through the event path.
    yield* deps.syncTabAudible(tabId, wc, yield* readAudible);
    yield* attempt({ operation: "registerWebview.sendTheme", tabId, webContentsId }, () => {
      wc.send(ANNOTATION_THEME_CHANNEL, annotationTheme);
      wc.send(ANNOTATION_SEND_ENABLED_CHANNEL, annotationSendEnabled.get(tabId) === true);
    });
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

  // URL tabs can paint before registerWebview; set the background at attach time.

  const prepareWebview = Effect.fn("PreviewManager.prepareWebview")(function* (
    wc: Electron.WebContents,
  ) {
    yield* rendererHistory.register(wc, { surface: "preview" });
    const webContentsId = wc.id;
    wc.once("destroyed", () => {
      runFork(deps.detachControlSession(webContentsId));
    });
    yield* deps.ensureControlSession(wc).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("Preview webview control session was not opened on attach.", {
          webContentsId,
          cause,
        }),
      ),
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
        // Keep audibility until Chromium replaces the document; clearing it here can lose the final transition.
        audioMuted: current?.audioMuted ?? false,
        audible: current?.audible ?? false,
        controller: current?.controller ?? "none",
        capturing: current?.capturing ?? false,
        ...(current?.favicon ? { favicon: current.favicon } : {}),
        ...(current?.serverTab ? { serverTab: current.serverTab } : {}),
        updatedAt,
      };
      return [
        next,
        replaceMap(tabs, (copy) => {
          copy.set(tabId, next);
        }),
      ] as const;
    });
    yield* emitIfCurrent(tabId, pending);
    if (pending.webContentsId == null) return;
    const webContentsId = pending.webContentsId;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      const expectedAttachment = (yield* Ref.get(attachedRef)).get(webContentsId);
      yield* withTabLifecycleLock(
        tabId,
        Effect.gen(function* () {
          const currentTab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          const currentAttachment = (yield* Ref.get(attachedRef)).get(webContentsId);
          const currentWebContents = webContents.fromId(webContentsId);
          if (
            currentTab?.webContentsId !== webContentsId ||
            currentAttachment !== expectedAttachment ||
            (currentWebContents && !currentWebContents.isDestroyed())
          ) {
            return;
          }
          yield* Effect.all(
            [
              deps.detachControlSession(webContentsId),
              deps.detachListeners(webContentsId),
              deps.cancelPickElement(tabId),
            ],
            { concurrency: 3, discard: true },
          );
          const detached = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
            const current = tabs.get(tabId);
            if (current?.webContentsId !== webContentsId) {
              return [Option.none<PreviewTabState>(), tabs] as const;
            }
            const { favicon: _favicon, ...currentWithoutFavicon } = current;
            const next: PreviewTabState = { ...currentWithoutFavicon, webContentsId: null };
            return [
              Option.some(next),
              replaceMap(tabs, (copy) => {
                copy.set(tabId, next);
              }),
            ] as const;
          });
          if (Option.isSome(detached)) yield* emitIfCurrent(tabId, detached.value);
        }),
      );
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

  const openDevTools = Effect.fn("PreviewManager.openDevTools")(function* (tabId: string) {
    const wc = yield* deps.requireWebContents(tabId);
    if (wc.isDevToolsOpened()) {
      yield* attempt({ operation: "openDevTools.focus", tabId, webContentsId: wc.id }, () =>
        wc.devToolsWebContents?.focus(),
      );
      return;
    }
    yield* deps.detachControlSession(wc.id);
    yield* attempt({ operation: "openDevTools", tabId, webContentsId: wc.id }, () => {
      wc.once("devtools-closed", () => {
        if (!wc.isDestroyed()) runFork(deps.restoreControlSession(tabId, wc));
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

  const setAnnotationSendEnabled = Effect.fn("PreviewManager.setAnnotationSendEnabled")(function* (
    tabId: string,
    enabled: boolean,
  ) {
    const wc = yield* deps.requireWebContents(tabId);
    yield* attempt({ operation: "setAnnotationSendEnabled", tabId, webContentsId: wc.id }, () => {
      annotationSendEnabled.set(tabId, enabled);
      wc.send(ANNOTATION_SEND_ENABLED_CHANNEL, enabled);
    });
  });

  const pickElement = Effect.fn("PreviewManager.pickElement")(function* (tabId: string) {
    const wc = yield* deps.requireWebContents(tabId);
    yield* deps.cancelPickElement(tabId);
    const annotationTheme = yield* Ref.get(annotationThemeRef);
    return yield* Effect.callback<PreviewAnnotationSubmissionResult | null, PreviewManagerError>(
      (resume) => {
        const session: PickSession = { cancel: Effect.suspend(() => cancelPickSession()) };
        const cleanup = Effect.fn("PreviewManager.cleanupPickElement")(function* () {
          yield* attempt({ operation: "pickElement.cleanup", tabId, webContentsId: wc.id }, () => {
            wc.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.off("destroyed", onDestroyed);
            wc.off("did-start-navigation", onNavigated);
          }).pipe(Effect.ignore);
          // A newer session may already own the slot when this one is cancelled.
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
          payload: PreviewAnnotationSubmissionResult | null,
        ) {
          yield* cleanup();
          resume(Effect.succeed(payload));
        });
        const settlePick = Effect.fn("PreviewManager.settlePickElement")(function* (
          payload: PreviewAnnotationSubmissionResult | null,
        ) {
          if (!claimSettle()) return;
          yield* finishPick(payload);
        });
        const settle = (payload: PreviewAnnotationSubmissionResult | null) => {
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
          const submission =
            args[2] === "send" && annotationSendEnabled.get(tabId) === true ? "send" : "attach";
          const devicePixelRatio = typeof args[3] === "number" ? args[3] : 1;
          const targetRects = [
            ...payload.elements.map((target) => target.rect),
            ...payload.regions.map((target) => target.rect),
            ...payload.strokes.map((target) => target.bounds),
          ];
          runFork(
            capturePageWithRetry(
              { operation: "captureAnnotationScreenshot", tabId, webContentsId: wc.id },
              tabId,
              wc,
            ).pipe(
              Effect.map((image) =>
                cropAnnotationScreenshot(image, cropRect, devicePixelRatio, targetRects),
              ),
              Effect.tapError((error) =>
                Effect.logWarning("preview annotation screenshot failed").pipe(
                  Effect.annotateLogs({ tabId, webContentsId: wc.id, error: error.message }),
                ),
              ),
              Effect.withSpan("PreviewManager.captureAnnotationScreenshot"),
              Effect.match({
                onFailure: (): PreviewAnnotationSubmissionResult => ({
                  annotation: payload,
                  submission,
                  screenshotFailed: true,
                }),
                onSuccess: (screenshot): PreviewAnnotationSubmissionResult =>
                  screenshot === null
                    ? { annotation: payload, submission, screenshotFailed: true }
                    : { annotation: { ...payload, screenshot }, submission },
              }),
              Effect.flatMap((result) => {
                // Late captures must not signal an overlay that may now belong to a newer pick.
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
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame) settle(null);
        };
        const registerPickElement = Effect.fn("PreviewManager.registerPickElement")(function* () {
          // Atomically swap/cancel overlapping picks so another pick cannot claim a transient empty slot.
          const replaced = yield* Ref.modify(pickSessionsRef, (sessions) => [
            sessions.get(tabId) ?? null,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, session);
            }),
          ]);
          if (replaced) yield* replaced.cancel;
          // A newer pick may cancel during teardown; do not leak listeners or start an abandoned overlay.
          if (settled) return;
          yield* attempt({ operation: "pickElement.register", tabId, webContentsId: wc.id }, () => {
            wc.ipc.on(ELEMENT_PICKED_CHANNEL, onMessage);
            wc.once("destroyed", onDestroyed);
            wc.on("did-start-navigation", onNavigated);
            if (!wc.isFocused()) wc.focus();
            wc.send(START_PICK_CHANNEL, annotationTheme, annotationSendEnabled.get(tabId) === true);
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

  return { registerWebviewUnlocked, registerWebview, prepareWebview, navigate, openDevTools, setAnnotationTheme, setAnnotationSendEnabled, pickElement };
};

export type WebviewsOps = ReturnType<typeof makeWebviewsOps>;
