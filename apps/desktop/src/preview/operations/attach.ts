/**
 * Preview tab webContents listener wiring.
 */
import { matchesKeybindingShortcut } from "@t3tools/shared/keybindings";
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
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { MENU_ACTION_CHANNEL, PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from "../../ipc/channels.ts";
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
import { captureFavicon, safeHttpOrigin, selectFaviconCandidates } from "../FaviconCapture.ts";
import {
  PreviewOperationError,
} from "../errors.ts";
import {
  POPUP_WINDOW_OPTIONS,
  isPreviewEditingShortcut,
  isPreviewInputSignal,
  isPreviewRefreshShortcut,
  previewWindowOpenAction,
} from "../predicates.ts";
import type {
  PreviewTabState,
} from "../types.ts";
import {
  isRecordingInput,
} from "../types.ts";
import type { ListenersOps } from "./listeners.ts";
import type { SessionOps } from "./session.ts";
import type { State } from "./state.ts";

export const makeAttachOps = (deps: State & ListenersOps & SessionOps) => {
  const {
    hostPlatform,
    parentScope,
    passkeys,
    runFork,
    tabsRef,
    attachedRef,
    recordingInputListenersRef,
    frameCaptureSessionsRef,
    attempt,
    attemptPromise,
    currentIso,
    currentMillis,
    replaceMap,
    update,
    deliverEvent,
    emitIfCurrent,
  } = deps;
  const m = deps.mutable;
  const attachListeners = Effect.fn("PreviewManager.attachListeners")(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const scope = yield* Scope.fork(parentScope, "sequential");
    const attachmentId = Symbol();
    let detachPasskeys = () => {};
    let documentId = 0;
    let nextRequestId = 0;
    let activeCapture: {
      readonly controller: AbortController;
      readonly documentId: number;
      readonly eventKey: string;
      readonly requestId: number;
    } | null = null;
    const cancelFaviconCapture = () => {
      documentId += 1;
      activeCapture?.controller.abort();
      activeCapture = null;
    };
    const syncState = Effect.fn("PreviewManager.syncWebContentsState")(function* (
      preserveLoadFailure: boolean,
      confirmedNavigation = false,
    ) {
      if (wc.isDestroyed()) return;
      const computedNavStatus = deps.computeNavStatus(wc);
      const canGoBack = wc.navigationHistory.canGoBack();
      const canGoForward = wc.navigationHistory.canGoForward();
      const updatedAt = yield* currentIso;
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);
        if (!current || current.webContentsId !== wc.id || webContents.fromId(wc.id) !== wc) {
          return [Option.none<PreviewTabState>(), tabs] as const;
        }
        // did-stop-loading follows did-fail-load without proving successful navigation.
        const navStatus =
          preserveLoadFailure &&
          current.navStatus.kind === "LoadFailed" &&
          computedNavStatus.kind === "Success"
            ? current.navStatus
            : computedNavStatus;
        const clearFavicon =
          confirmedNavigation &&
          current.favicon !== undefined &&
          safeHttpOrigin(current.favicon.pageUrl) !==
            safeHttpOrigin(navStatus.kind === "Idle" ? wc.getURL() : navStatus.url);
        const { favicon: _favicon, ...currentWithoutFavicon } = current;
        const state: PreviewTabState = {
          ...(clearFavicon ? currentWithoutFavicon : current),
          navStatus,
          canGoBack,
          canGoForward,
          // Guest zoom inherits app zoom; mirroring it would overwrite the tab's own setting.
          updatedAt,
        };
        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });
      if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
    });
    const sync = () => runFork(syncState(true));
    const syncNavigation = () => runFork(syncState(false, true));
    const syncInPageNavigation = () => runFork(syncState(false));
    const restoreRecordingCursor = () =>
      runFork(
        Effect.gen(function* () {
          const session = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
          if (!wc.isDestroyed()) {
            const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
            wc.send(
              RECORDING_CURSOR_CHANNEL,
              session?.consumers.has("recording") ?? false,
              session?.recordingInputOptions,
              tab?.controller,
            );
          }
        }),
      );
    const navigationStarted = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) cancelFaviconCapture();
    };
    const audioStateChanged = (
      event: Electron.Event<Electron.WebContentsAudioStateChangedEventParams>,
    ) => runFork(deps.syncTabAudible(tabId, wc, event.audible));
    const publishFavicon = Effect.fn("PreviewManager.publishFavicon")(function* (input: {
      readonly captureDocumentId: number;
      readonly dataUrl: string;
      readonly pageUrl: string;
      readonly requestId: number;
    }) {
      const pageOrigin = safeHttpOrigin(input.pageUrl);
      const managed = (yield* Ref.get(attachedRef)).get(wc.id);
      if (
        !pageOrigin ||
        wc.isDestroyed() ||
        webContents.fromId(wc.id) !== wc ||
        managed?.attachmentId !== attachmentId ||
        activeCapture?.documentId !== input.captureDocumentId ||
        activeCapture.requestId !== input.requestId ||
        safeHttpOrigin(wc.getURL()) !== pageOrigin
      ) {
        return;
      }
      const capturedAt = yield* currentMillis;
      const updatedAt = yield* currentIso;
      const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
        const current = tabs.get(tabId);
        if (
          !current ||
          current.webContentsId !== wc.id ||
          webContents.fromId(wc.id) !== wc ||
          activeCapture?.documentId !== input.captureDocumentId ||
          activeCapture.requestId !== input.requestId
        ) {
          return [Option.none<PreviewTabState>(), tabs] as const;
        }
        const state: PreviewTabState = {
          ...current,
          favicon: { dataUrl: input.dataUrl, pageUrl: pageOrigin, capturedAt },
          updatedAt,
        };
        return [
          Option.some(state),
          replaceMap(tabs, (copy) => {
            copy.set(tabId, state);
          }),
        ] as const;
      });
      if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
    });
    const faviconUpdated = (_event: Event, rawCandidates: ReadonlyArray<string>): void => {
      const pageUrl = wc.getURL();
      if (!safeHttpOrigin(pageUrl)) return;
      const candidates = selectFaviconCandidates(rawCandidates);
      if (candidates.length === 0) return;
      const eventKey = JSON.stringify([pageUrl, ...candidates]);
      if (activeCapture?.eventKey === eventKey) return;
      activeCapture?.controller.abort();
      const captureDocumentId = documentId;
      const requestId = ++nextRequestId;
      const controller = new AbortController();
      activeCapture = { controller, documentId: captureDocumentId, eventKey, requestId };
      runFork(
        Effect.tryPromise({
          try: () =>
            captureFavicon({ webContents: wc, pageUrl, candidates, signal: controller.signal }),
          catch: (cause) =>
            new PreviewOperationError({
              operation: "captureFavicon",
              tabId,
              webContentsId: wc.id,
              cause,
            }),
        }).pipe(
          Effect.flatMap((result) =>
            result.kind === "captured"
              ? publishFavicon({
                  captureDocumentId,
                  dataUrl: result.dataUrl,
                  pageUrl,
                  requestId,
                })
              : Effect.void,
          ),
          Effect.catch((error) =>
            controller.signal.aborted
              ? Effect.void
              : Effect.logDebug("Favicon capture failed.", { error, tabId, webContentsId: wc.id }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (activeCapture?.requestId === requestId) activeCapture = null;
            }),
          ),
        ),
      );
    };
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
      yield* update(
        tabId,
        { controller: "human" },
        isPreviewInputSignal(rawSignal) && rawSignal.kind === "pointer"
          ? { x: rawSignal.x, y: rawSignal.y }
          : undefined,
      );
      yield* Effect.sleep(750);
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (tabs.get(tabId)?.controller === "human") {
        yield* update(tabId, { controller: "none" });
      }
    });
    const recordingInput = (_event: unknown, input: unknown) => {
      if (!isRecordingInput(input)) return;
      return runFork(
        Effect.gen(function* () {
          const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          const capture = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
          if (tab?.webContentsId !== wc.id || !capture?.consumers.has("recording")) return;
          if (input.type === "key" && !capture.recordingInputOptions?.showKeyPresses) return;
          if (input.type === "pointer" && !capture.recordingInputOptions?.showMousePresses) return;
          const listeners = yield* Ref.get(recordingInputListenersRef);
          yield* Effect.forEach(
            listeners,
            (listener) => deliverEvent("recording-input", tabId, () => listener({ tabId, input })),
            { discard: true },
          );
        }),
      );
    };
    const humanInput = (_event: unknown, rawSignal?: unknown): void => {
      runFork(handleHumanInput(rawSignal));
    };
    const mouseNavigate = (_event: unknown, payload?: unknown): void => {
      const direction =
        typeof payload === "object" && payload !== null && "direction" in payload
          ? (payload as { direction?: unknown }).direction
          : undefined;
      if (direction !== "back" && direction !== "forward") return;
      runFork(
        attempt({ operation: "mouseNavigate", tabId, webContentsId: wc.id }, () => {
          if (direction === "back") {
            if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
          } else if (wc.navigationHistory.canGoForward()) {
            wc.navigationHistory.goForward();
          }
        }).pipe(Effect.ignore),
      );
    };
    // Every guest of a focused window reports focus; GuestInput handles guests without a focused frame.
    const holdsKeyboardFocus = (contents: Electron.WebContents) =>
      contents.isFocused() && contents.focusedFrame !== null;
    const syncMenuShortcuts = (contents: Electron.WebContents, input: Electron.Input): void => {
      if (input.type !== "keyDown") return;
      contents.setIgnoreMenuShortcuts(
        !isPreviewEditingShortcut(input, hostPlatform) || !holdsKeyboardFocus(contents),
      );
    };
    // Popups inherit Electron's unrestricted window handler; block nested popups to bound the chain.
    const windowCreated = (window: Electron.BrowserWindow): void => {
      window.webContents.setIgnoreMenuShortcuts(true);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("before-input-event", (_event, input) => {
        syncMenuShortcuts(window.webContents, input);
      });
    };
    const beforeInput = (event: Electron.Event, input: Electron.Input): void => {
      syncMenuShortcuts(wc, input);
      const host = wc.hostWebContents;
      const forwarded =
        input.type === "keyDown" &&
        !input.isComposing &&
        host &&
        !host.isDestroyed() &&
        holdsKeyboardFocus(wc) &&
        !(
          hostPlatform !== "darwin" &&
          input.control &&
          input.alt &&
          /^(?:[^a-zA-Z0-9]|Dead)$/u.test(input.key)
        ) &&
        m.forwardedShortcuts.find(({ shortcut }) =>
          matchesKeybindingShortcut(
            {
              key: input.key,
              code: input.code,
              metaKey: input.meta,
              ctrlKey: input.control,
              shiftKey: input.shift,
              altKey: input.alt,
            },
            shortcut,
            hostPlatform === "darwin" ? "MacIntel" : hostPlatform,
          ),
        );
      if (forwarded && host) {
        event.preventDefault();
        if (!input.isAutoRepeat) {
          if (
            forwarded.command === "workspace.focusNext" ||
            forwarded.command === "workspace.focusPrevious" ||
            forwarded.command === "preview.focusUrl"
          ) {
            // DOM focus in the renderer cannot by itself release the guest's native keyboard focus.
            host.focus();
          }
          host.send(MENU_ACTION_CHANNEL, forwarded.command);
        }
        return;
      }
      if (isPreviewRefreshShortcut(input, hostPlatform)) {
        event.preventDefault();
        runFork(
          attempt({ operation: "shortcut.refresh", tabId, webContentsId: wc.id }, () =>
            wc.reload(),
          ).pipe(Effect.ignore),
        );
        return;
      }
    };
    yield* Scope.addFinalizer(
      scope,
      attempt({ operation: "detachListeners", tabId, webContentsId: wc.id }, () => {
        cancelFaviconCapture();
        wc.off("did-start-navigation", navigationStarted);
        wc.off("did-navigate", syncNavigation);
        wc.off("did-navigate-in-page", syncInPageNavigation);
        wc.off("page-title-updated", sync);
        wc.off("page-favicon-updated", faviconUpdated as never);
        wc.off("did-start-loading", sync);
        wc.off("did-stop-loading", sync);
        wc.off("dom-ready", restoreRecordingCursor);
        wc.off("did-fail-load", failed as never);
        wc.off("audio-state-changed", audioStateChanged);
        wc.off("did-create-window", windowCreated);
        wc.off("before-input-event", beforeInput);
        wc.ipc.off(HUMAN_INPUT_CHANNEL, humanInput);
        wc.ipc.off(RECORDING_INPUT_CHANNEL, recordingInput);
        wc.ipc.off(MOUSE_NAVIGATE_CHANNEL, mouseNavigate);
        detachPasskeys();
      }).pipe(Effect.ignore),
    );
    const install = Effect.fn("PreviewManager.installWebContentsListeners")(function* () {
      yield* attempt({ operation: "attachListeners", tabId, webContentsId: wc.id }, () => {
        wc.setIgnoreMenuShortcuts(true);
        wc.on("did-start-navigation", navigationStarted);
        wc.on("did-navigate", syncNavigation);
        wc.on("did-navigate-in-page", syncInPageNavigation);
        wc.on("page-title-updated", sync);
        wc.on("page-favicon-updated", faviconUpdated as never);
        wc.on("did-start-loading", sync);
        wc.on("did-stop-loading", sync);
        wc.on("dom-ready", restoreRecordingCursor);
        wc.on("did-fail-load", failed as never);
        wc.on("audio-state-changed", audioStateChanged);
        wc.ipc.on(HUMAN_INPUT_CHANNEL, humanInput);
        wc.ipc.on(RECORDING_INPUT_CHANNEL, recordingInput);
        wc.ipc.on(MOUSE_NAVIGATE_CHANNEL, mouseNavigate);
        detachPasskeys = passkeys.attachGuest(wc);
        wc.setWindowOpenHandler((details) => {
          const action = previewWindowOpenAction(details);
          if (action === "popup") {
            return { action: "allow", overrideBrowserWindowOptions: POPUP_WINDOW_OPTIONS };
          }
          if (action === "deny") return { action: "deny" };
          if (action === "new-tab") {
            runFork(
              deps.emitOpenLink({
                tabId,
                url: details.url,
                background: details.disposition === "background-tab",
              }),
            );
            return { action: "deny" };
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
          copy.set(wc.id, { attachmentId, cancelFaviconCapture, scope, webContents: wc });
        }),
      );
    });
    yield* install().pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  return { attachListeners };
};

export type AttachOps = ReturnType<typeof makeAttachOps>;
