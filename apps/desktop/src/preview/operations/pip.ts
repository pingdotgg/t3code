/**
 * Preview picture-in-picture window lifecycle.
 */
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  PreviewManagerError,
  PreviewOperationError,
} from "../errors.ts";
import {
  PICTURE_IN_PICTURE_INITIAL_HEIGHT,
  PICTURE_IN_PICTURE_INITIAL_WIDTH,
  PICTURE_IN_PICTURE_MIN_HEIGHT,
  PICTURE_IN_PICTURE_MIN_WIDTH,
  buildPreviewPictureInPictureDataUrl,
} from "../geometry.ts";
import type {
  PictureInPictureSession,
} from "../types.ts";
import type { WindowOps } from "./window.ts";
import type { SessionOps } from "./session.ts";
import type { CaptureOps } from "./capture.ts";
import type { State } from "./state.ts";

export const makePipOps = (deps: State & WindowOps & SessionOps & CaptureOps) => {
  const {
    rendererHistory,
    hostPlatform,
    parentScope,
    runFork,
    tabsRef,
    frameCaptureSessionsRef,
    pictureInPictureSessionsRef,
    pictureInPictureAspectRatiosRef,
    pictureInPictureMutationSemaphore,
    attempt,
    attemptPromise,
    replaceMap,
    update,
    pictureInPicturePreloadPath,
  } = deps;
  const m = deps.mutable;
  const releasePictureInPicture = Effect.fn("PreviewManager.releasePictureInPicture")(function* (
    tabId: string,
    expectedSession: PictureInPictureSession,
    closeWindow: boolean,
  ) {
    const removed = yield* SynchronizedRef.modify(pictureInPictureSessionsRef, (sessions) => {
      if (sessions.get(tabId) !== expectedSession) {
        return [false, sessions] as const;
      }
      return [
        true,
        replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        }),
      ] as const;
    });
    if (!removed) return;
    yield* Deferred.interrupt(expectedSession.ready);
    yield* Scope.close(expectedSession.initializationScope, Exit.void).pipe(Effect.ignore);
    yield* Ref.update(pictureInPictureAspectRatiosRef, (aspectRatios) =>
      replaceMap(aspectRatios, (copy) => {
        copy.delete(tabId);
      }),
    );
    yield* deps.stopFrameCapture(tabId, "picture-in-picture");
    const tabs = yield* SynchronizedRef.get(tabsRef);
    if (tabs.has(tabId)) {
      yield* update(tabId, { pictureInPicture: false });
    }
    if (closeWindow && !expectedSession.window.isDestroyed()) {
      yield* attempt({ operation: "pictureInPicture.close", tabId }, () =>
        expectedSession.window.close(),
      ).pipe(Effect.ignore);
    }
  });

  const closePictureInPictureUnlocked = Effect.fn("PreviewManager.closePictureInPictureUnlocked")(
    function* (tabId: string) {
      const pictureInPictureSession = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(
        tabId,
      );
      if (!pictureInPictureSession) {
        yield* deps.stopFrameCapture(tabId, "picture-in-picture");
        const tabs = yield* SynchronizedRef.get(tabsRef);
        if (tabs.has(tabId)) {
          yield* update(tabId, { pictureInPicture: false });
        }
        return;
      }
      yield* releasePictureInPicture(tabId, pictureInPictureSession, true);
    },
  );

  const closePictureInPicture = Effect.fn("PreviewManager.closePictureInPicture")(function* (
    tabId: string,
  ) {
    yield* pictureInPictureMutationSemaphore.withPermit(closePictureInPictureUnlocked(tabId));
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
    const claim = yield* pictureInPictureMutationSemaphore.withPermit(
      Effect.gen(function* () {
        const existing = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
        if (existing && !existing.window.isDestroyed()) {
          return { kind: "existing" as const, session: existing };
        }
        if (existing) {
          yield* releasePictureInPicture(tabId, existing, false);
        }
        const wc = yield* deps.requireWebContents(tabId);
        const title = yield* attempt(
          {
            operation: "pictureInPicture.readTitle",
            tabId,
            webContentsId: wc.id,
          },
          () => wc.getTitle().trim(),
        );
        const pictureInPictureWindow = yield* attempt(
          {
            operation: "pictureInPicture.create",
            tabId,
            webContentsId: wc.id,
          },
          () =>
            new BrowserWindow({
              width: PICTURE_IN_PICTURE_INITIAL_WIDTH,
              height: PICTURE_IN_PICTURE_INITIAL_HEIGHT,
              minWidth: PICTURE_IN_PICTURE_MIN_WIDTH,
              minHeight: PICTURE_IN_PICTURE_MIN_HEIGHT,
              title: title.length > 0 ? `Preview · ${title}` : "Browser preview",
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
                preload: pictureInPicturePreloadPath,
                backgroundThrottling: false,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            }),
        );
        yield* rendererHistory.register(pictureInPictureWindow.webContents, {
          surface: "picture-in-picture",
          tabId,
        });
        const initializationScope = yield* Scope.fork(parentScope, "sequential");
        const ready = yield* Deferred.make<void, PreviewManagerError>();
        const session: PictureInPictureSession = {
          window: pictureInPictureWindow,
          webContentsId: wc.id,
          ready,
          initializationScope,
        };
        const onClosed = () => {
          runFork(
            pictureInPictureMutationSemaphore.withPermit(
              releasePictureInPicture(tabId, session, false),
            ),
          );
        };
        const onDidFinishLoad = () => {
          runFork(
            SynchronizedRef.update(frameCaptureSessionsRef, (sessions) => {
              const current = sessions.get(tabId);
              if (!current?.consumers.has("picture-in-picture")) return sessions;
              return replaceMap(sessions, (copy) => {
                copy.set(tabId, { ...current, lastPictureInPictureFingerprint: null });
              });
            }),
          );
        };
        const pipWebContents = pictureInPictureWindow.webContents;
        yield* attempt(
          {
            operation: "pictureInPicture.configure",
            tabId,
            webContentsId: wc.id,
          },
          () => {
            pictureInPictureWindow.once("closed", onClosed);
            pictureInPictureWindow.setAlwaysOnTop(
              true,
              hostPlatform === "darwin" ? "floating" : "normal",
            );
            if (hostPlatform === "darwin") {
              pictureInPictureWindow.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
                // Electron's temporary UIElement transformation would remove the app from the Dock.
                skipTransformProcessType: true,
              });
            }
            pipWebContents.on("did-finish-load", onDidFinishLoad);
          },
        ).pipe(
          Effect.onError(() =>
            Effect.all(
              [
                Scope.close(initializationScope, Exit.void).pipe(Effect.ignore),
                attempt({ operation: "pictureInPicture.close", tabId }, () =>
                  pictureInPictureWindow.close(),
                ).pipe(Effect.ignore),
              ],
              { discard: true },
            ),
          ),
        );
        yield* Scope.addFinalizer(
          initializationScope,
          Effect.sync(() => {
            pipWebContents.off("did-finish-load", onDidFinishLoad);
          }).pipe(Effect.ignore),
        );
        yield* SynchronizedRef.update(pictureInPictureSessionsRef, (sessions) =>
          replaceMap(sessions, (copy) => {
            copy.set(tabId, session);
          }),
        );
        return { kind: "created" as const, session };
      }),
    );
    const pictureInPictureSession = claim.session;
    if (claim.kind === "existing") {
      yield* Deferred.await(pictureInPictureSession.ready);
      return yield* pictureInPictureMutationSemaphore.withPermit(
        Effect.gen(function* () {
          const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
          if (current !== pictureInPictureSession || pictureInPictureSession.window.isDestroyed()) {
            return yield* new PreviewOperationError({
              operation: "pictureInPicture.showExisting",
              tabId,
              webContentsId: pictureInPictureSession.webContentsId,
              cause: new Error("Picture-in-picture session closed before it became visible."),
            });
          }
          yield* attempt(
            {
              operation: "pictureInPicture.showExisting",
              tabId,
              webContentsId: pictureInPictureSession.webContentsId,
            },
            () => pictureInPictureSession.window.showInactive(),
          );
        }),
      );
    }

    const initialize = Effect.gen(function* () {
      yield* attemptPromise(
        {
          operation: "pictureInPicture.load",
          tabId,
          webContentsId: pictureInPictureSession.webContentsId,
        },
        () => pictureInPictureSession.window.loadURL(buildPreviewPictureInPictureDataUrl()),
      );
      const currentWebContents = yield* deps.requireWebContents(tabId);
      if (
        currentWebContents.id !== pictureInPictureSession.webContentsId ||
        currentWebContents.isDestroyed()
      ) {
        return yield* new PreviewOperationError({
          operation: "pictureInPicture.validateWebContents",
          tabId,
          webContentsId: pictureInPictureSession.webContentsId,
          cause: new Error("Preview webview changed while picture-in-picture was opening."),
        });
      }
      yield* deps.startFrameCapture(tabId, "picture-in-picture");
      yield* attempt(
        {
          operation: "pictureInPicture.show",
          tabId,
          webContentsId: pictureInPictureSession.webContentsId,
        },
        () => pictureInPictureSession.window.showInactive(),
      );
    });
    const initializationExit = yield* Effect.gen(function* () {
      const initializationFiber = yield* Effect.forkIn(
        initialize,
        pictureInPictureSession.initializationScope,
      );
      return yield* Fiber.await(initializationFiber);
    }).pipe(
      Effect.onInterrupt(() =>
        pictureInPictureMutationSemaphore.withPermit(
          releasePictureInPicture(tabId, pictureInPictureSession, true),
        ),
      ),
    );
    if (Exit.isSuccess(initializationExit)) {
      const published = yield* pictureInPictureMutationSemaphore.withPermit(
        Effect.gen(function* () {
          const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
          if (current !== pictureInPictureSession || pictureInPictureSession.window.isDestroyed()) {
            if (current === pictureInPictureSession) {
              yield* releasePictureInPicture(tabId, pictureInPictureSession, false);
            }
            return false;
          }
          yield* update(tabId, { pictureInPicture: true });
          yield* Deferred.done(pictureInPictureSession.ready, initializationExit);
          return true;
        }),
      );
      if (published) return;
      return yield* Deferred.await(pictureInPictureSession.ready);
    }
    yield* Deferred.done(pictureInPictureSession.ready, initializationExit);
    const current = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(tabId);
    if (current === pictureInPictureSession) {
      yield* pictureInPictureMutationSemaphore.withPermit(
        releasePictureInPicture(tabId, pictureInPictureSession, true),
      );
    }
    return yield* Effect.failCause(initializationExit.cause);
  });

  return { releasePictureInPicture, closePictureInPictureUnlocked, closePictureInPicture, closeAllPictureInPicture, openPictureInPicture };
};

export type PipOps = ReturnType<typeof makePipOps>;
