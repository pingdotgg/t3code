/**
 * Preview tab sessions: control-session lifecycle, zoom, audio and colour scheme.
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
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  PreviewArtifactPathOutsideDirectoryError,
  PreviewAutomationDebuggerAttachedError,
  PreviewAutomationDevToolsOpenError,
  PreviewManagerError,
  PreviewOperationError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
  PreviewWebviewNotInitializedError,
} from "../errors.ts";
import type {
  BrowserControlSession,
  PreviewNavStatus,
  PreviewTabState,
} from "../types.ts";
import type { ListenersOps } from "./listeners.ts";
import type { State } from "./state.ts";

export const makeSessionOps = (deps: State & ListenersOps) => {
  const {
    path,
    parentScope,
    browserHost,
    runFork,
    resolvedArtifactDirectory,
    tabsRef,
    attachedRef,
    pickSessionsRef,
    controlSessionsRef,
    attempt,
    attemptPromise,
    currentIso,
    replaceMap,
    update,
    emitIfCurrent,
    withTabLifecycleLock,
  } = deps;
  const m = deps.mutable;
  const tabIdForWebContents = Effect.fnUntraced(function* (webContentsId: number) {
    const tabs = yield* SynchronizedRef.get(tabsRef);
    return (
      Array.from(tabs.entries()).find(([, tab]) => tab.webContentsId === webContentsId)?.[0] ?? null
    );
  });

  const detachControlSession = Effect.fn("PreviewManager.detachControlSession")(function* (
    webContentsId: number,
    closedServerTab?: PreviewTabState["serverTab"],
  ) {
    const control = yield* SynchronizedRef.modify(controlSessionsRef, (sessions) => [
      sessions.get(webContentsId),
      replaceMap(sessions, (copy) => {
        copy.delete(webContentsId);
      }),
    ]);
    if (control) yield* releaseControlSession(control, closedServerTab);
  });

  // Closes a session already removed from `controlSessionsRef`. The server can
  // only drive a tab while the desktop holds its debugger.

  const releaseControlSession = Effect.fnUntraced(function* (
    control: BrowserControlSession,
    closedServerTab?: PreviewTabState["serverTab"],
  ) {
    if (closedServerTab) browserHost.detach(closedServerTab);
    for (const tab of (yield* SynchronizedRef.get(tabsRef)).values()) {
      if (tab.webContentsId === control.webContentsId && tab.serverTab) {
        browserHost.detach(tab.serverTab);
      }
    }
    yield* Scope.close(control.scope, Exit.void).pipe(Effect.ignore);
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
        if (wc.isDestroyed()) {
          return Effect.fail(
            new PreviewOperationError({
              operation: "ensureControlSession",
              webContentsId: wc.id,
              cause: new Error("WebContents was destroyed"),
            }),
          );
        }
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
          const wcDebugger = wc.debugger;
          const consoleReleases = yield* Queue.sliding<void>(1);
          // Console eviction leaves strong debugger handles; release the group because we keep only text.
          yield* Effect.forkIn(
            Effect.forever(
              Queue.take(consoleReleases).pipe(
                Effect.andThen(
                  attemptPromise({ operation: "releaseConsoleObjects", webContentsId: wc.id }, () =>
                    wcDebugger.sendCommand("Runtime.releaseObjectGroup", {
                      objectGroup: "console",
                    }),
                  ).pipe(Effect.ignore),
                ),
              ),
            ),
            scope,
          );
          const handleDebuggerMessage = Effect.fnUntraced(function* (
            method: string,
            params: Record<string, unknown>,
          ) {
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
            }
            if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
              yield* Queue.offer(consoleReleases, undefined);
            }
          });
          const onMessage: BrowserControlSession["onMessage"] = (_event, method, params) => {
            runFork(handleDebuggerMessage(method, params));
          };
          const control: BrowserControlSession = {
            webContentsId: wc.id,
            debugger: wcDebugger,
            semaphore,
            scope,
            onMessage,
          };
          // Electron emits `detach` when Chromium closes the debugger session on its
          // own. The cached session would then fail every command until the webview
          // is replaced.
          let dropped = false;
          const onDetach = () => {
            dropped = true;
            runFork(recoverDetachedControlSession(wc, control));
          };
          // The listener comes off before detach() so a detach this manager requested
          // never looks like a dropped one. A dropped session has nothing left to
          // detach: `wc.debugger` is shared, so detaching here would hit a successor.
          yield* Scope.addFinalizer(
            scope,
            attempt({ operation: "detachControlSession", webContentsId: wc.id }, () => {
              wcDebugger.off("message", onMessage);
              wcDebugger.off("detach", onDetach);
              if (!dropped && wcDebugger.isAttached()) wcDebugger.detach();
            }).pipe(Effect.ignore),
          );
          const initialize = Effect.fn("PreviewManager.initializeControlSession")(function* () {
            yield* attempt({ operation: "attachDebuggerListeners", webContentsId: wc.id }, () => {
              wcDebugger.on("message", onMessage);
              wcDebugger.on("detach", onDetach);
              wcDebugger.attach("1.3");
            });
            // Set an opaque base before first paint or background-less dark pages retain white-on-white text.
            yield* attemptPromise(
              { operation: "initializeDebugger.defaultBackground", webContentsId: wc.id },
              () =>
                wcDebugger.sendCommand("Emulation.setDefaultBackgroundColorOverride", {
                  color: { r: 255, g: 255, b: 255, a: 1 },
                }),
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

  const restoreControlSession = Effect.fn("PreviewManager.restoreControlSession")(
    function* (tabId: string, wc: Electron.WebContents) {
      const beforeAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (beforeAttach?.webContentsId !== wc.id) return;
      const control = yield* ensureControlSession(wc);
      const afterAttach = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
      if (afterAttach?.webContentsId !== wc.id) {
        yield* detachControlSession(wc.id);
        return;
      }
      if (afterAttach.serverTab) {
        yield* deps.listenToBrowserHost;
        browserHost.attach(afterAttach.serverTab, { webContents: wc, debugger: control.debugger });
      }
      if (afterAttach.colorScheme !== "system") {
        yield* attemptPromise({ operation: "applyColorScheme", tabId, webContentsId: wc.id }, () =>
          control.debugger.sendCommand("Emulation.setEmulatedMedia", {
            features: [
              {
                name: "prefers-color-scheme",
                value: afterAttach.colorScheme,
              },
            ],
          }),
        );
      }
    },
    (effect, _tabId, _wc) => effect.pipe(Effect.ignore),
  );

  // Only the session that saw the detach is replaced: by the time the event is
  // handled the guest may already hold a newer one, which must stay.

  const recoverDetachedControlSession = Effect.fn("PreviewManager.recoverDetachedControlSession")(
    function* (wc: Electron.WebContents, detached: BrowserControlSession) {
      const removed = yield* SynchronizedRef.modify(controlSessionsRef, (sessions) =>
        sessions.get(wc.id) === detached
          ? ([
              true,
              replaceMap(sessions, (copy) => {
                copy.delete(wc.id);
              }),
            ] as const)
          : ([false, sessions] as const),
      );
      if (!removed) return;
      yield* releaseControlSession(detached);
      if (wc.isDestroyed()) return;
      const tabId = yield* tabIdForWebContents(wc.id);
      if (tabId === null) return;
      yield* restoreControlSession(tabId, wc);
    },
    (recover) => Effect.ignore(recover),
  );

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
    if (managed) {
      managed.cancelFaviconCapture();
      yield* Scope.close(managed.scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const computeNavStatus = (wc: Electron.WebContents): PreviewNavStatus => {
    const url = wc.getURL();
    const title = wc.getTitle();
    if (url === "" || url === "about:blank") return { kind: "Idle" };
    // isLoading() includes late iframes whose completion may never clear the tab's loading bar.
    if (wc.isLoadingMainFrame()) return { kind: "Loading", url, title };
    return { kind: "Success", url, title };
  };

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
      Effect.filterOrFail(
        (resolvedPath) => resolvedPath !== null,
        () =>
          new PreviewArtifactPathOutsideDirectoryError({
            artifactPath,
            artifactDirectory: resolvedArtifactDirectory,
          }),
      ),
    );

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

  const assertTabZoom = Effect.fn("PreviewManager.assertTabZoom")(function* (tabId: string) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) return;
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* attempt({ operation: "assertTabZoom", tabId, webContentsId: wc.id }, () =>
      wc.setZoomFactor(tab.zoomFactor),
    ).pipe(Effect.ignore);
  });

  /** Read committed mute and current guest at call time so stale snapshots cannot roll back newer actions. */

  const assertTabAudioMuted = Effect.fn("PreviewManager.assertTabAudioMuted")(function* (
    tabId: string,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab || tab.webContentsId == null) return;
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* attempt({ operation: "assertTabAudioMuted", tabId, webContentsId: wc.id }, () =>
      wc.setAudioMuted(tab.audioMuted),
    );
  });

  const syncTabAudible = Effect.fn("PreviewManager.syncTabAudible")(function* (
    tabId: string,
    wc: Electron.WebContents,
    audible: boolean,
  ) {
    if (wc.isDestroyed()) return;
    const updatedAt = yield* currentIso;
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (
        !current ||
        current.webContentsId !== wc.id ||
        webContents.fromId(wc.id) !== wc ||
        current.audible === audible
      ) {
        return [Option.none<PreviewTabState>(), tabs] as const;
      }
      const state: PreviewTabState = { ...current, audible, updatedAt };
      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    if (Option.isSome(next)) yield* emitIfCurrent(tabId, next.value);
  });

  const setAudioMuted = Effect.fn("PreviewManager.setAudioMuted")(function* (
    tabId: string,
    audioMuted: boolean,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    // Serialize commit/apply, then read committed mute so concurrent toggles cannot reach Chromium out of order.
    yield* withTabLifecycleLock(
      tabId,
      Effect.gen(function* () {
        const previous = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.audioMuted;
        const committed = previous !== undefined && previous !== audioMuted;
        if (committed) {
          yield* update(tabId, { audioMuted });
        }
        // Roll back rejected mute commits so the UI reflects actual playback.
        yield* assertTabAudioMuted(tabId).pipe(
          Effect.tapError(() =>
            committed ? update(tabId, { audioMuted: previous }) : Effect.void,
          ),
        );
      }),
    );
  });

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
            value: colorScheme === "system" ? "" : colorScheme,
          },
        ],
      }),
    );
  });

  // The scheme is read after the session attaches so a concurrent setColorScheme is not
  // overwritten with a stale snapshot.

  const setColorScheme = Effect.fn("PreviewManager.setColorScheme")(function* (
    tabId: string,
    colorScheme: DesktopPreviewColorScheme,
  ) {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
    if (!tab) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    if (tab.colorScheme !== colorScheme) {
      yield* update(tabId, { colorScheme });
    }
    // registerWebview may swap guests during the update; apply to the current one.
    const webContentsId = (yield* SynchronizedRef.get(tabsRef)).get(tabId)?.webContentsId;
    if (webContentsId == null) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    yield* applyColorScheme(tabId, wc, colorScheme);
  });

  return { tabIdForWebContents, detachControlSession, releaseControlSession, ensureControlSession, restoreControlSession, recoverDetachedControlSession, cancelPickElement, detachListeners, computeNavStatus, requireWebContents, resolveArtifactPath, withWebContents, goBack, goForward, refresh, hardReload, assertTabZoom, assertTabAudioMuted, syncTabAudible, setAudioMuted, applyColorScheme, setColorScheme };
};

export type SessionOps = ReturnType<typeof makeSessionOps>;
