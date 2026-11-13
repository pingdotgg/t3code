/**
 * Preview screenshots and frame capture.
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
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { MENU_ACTION_CHANNEL, PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL } from "../../ipc/channels.ts";
import {
  PreviewMainWindowClosedError,
  PreviewOperationError,
  PreviewTabNotFoundError,
} from "../errors.ts";
import {
  CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS,
  PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON,
  PICTURE_IN_PICTURE_FRAME_INTERVAL_MS,
  PICTURE_IN_PICTURE_JPEG_QUALITY,
  artifactSiteSlug,
  fingerprintCapturedFrame,
  fitPictureInPictureContentSize,
} from "../geometry.ts";
import type {
  FrameCaptureConsumer,
} from "../types.ts";
import type { WindowOps } from "./window.ts";
import type { SessionOps } from "./session.ts";
import type { State } from "./state.ts";

export const makeCaptureOps = (deps: State & WindowOps & SessionOps) => {
  const {
    fileSystem,
    path,
    random,
    parentScope,
    resolvedArtifactDirectory,
    tabsRef,
    frameCaptureSessionsRef,
    pictureInPictureSessionsRef,
    pictureInPictureAspectRatiosRef,
    closingTabIdsRef,
    attempt,
    attemptPromise,
    capturePageWithRetry,
    currentIso,
    currentMillis,
    replaceMap,
    update,
  } = deps;
  const m = deps.mutable;
  const captureScreenshot = Effect.fn("PreviewManager.captureScreenshot")(function* (
    tabId: string,
  ) {
    const wc = yield* deps.requireWebContents(tabId);
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
    const uuid = yield* random.uuidV4();
    const id = `browser-screenshot-${artifactSiteSlug(wc.getURL())}-${millis.toString(36)}-${uuid.slice(0, 8)}`;
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
    if (!captureSession?.consumers.has("picture-in-picture") || captureSession.scope === null)
      return;
    const wc = yield* deps.requireWebContents(tabId);
    const captureContext = { operation: "frameCapture.capturePage", tabId, webContentsId: wc.id };
    const image = yield* attemptPromise(captureContext, () => wc.capturePage()).pipe(
      Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(new PreviewOperationError({ ...captureContext, cause })),
      }),
    );
    const currentCaptureSession = yield* Effect.all(
      [SynchronizedRef.get(frameCaptureSessionsRef), SynchronizedRef.get(tabsRef)],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([captureSessions, tabs]) => {
        const current = captureSessions.get(tabId);
        return current?.scope === captureSession.scope &&
          tabs.get(tabId)?.webContentsId === wc.id &&
          !wc.isDestroyed()
          ? current
          : undefined;
      }),
    );
    if (!currentCaptureSession) return;
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
    const frameSession = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
    if (frameSession?.scope !== captureSession.scope) return;
    // Fingerprint before encoding so unchanged frames skip JPEG, base64, and IPC; unreadable frames must still be sent.
    const fingerprint = fingerprintCapturedFrame(image, size);
    const pictureInPicture =
      frameSession.consumers.has("picture-in-picture") &&
      (fingerprint === null || frameSession.lastPictureInPictureFingerprint !== fingerprint);
    if (!pictureInPicture) return;
    const encoded = yield* attempt(
      {
        operation: "frameCapture.encodeFrame",
        tabId,
        webContentsId: wc.id,
      },
      () => image.toJPEG(PICTURE_IN_PICTURE_JPEG_QUALITY),
    );
    const receivedAt = yield* currentIso;
    const frame: DesktopPreviewRecordingFrame = {
      tabId,
      data: encoded.toString("base64"),
      width: size.width,
      height: size.height,
      receivedAt,
    };
    const pictureInPictureWindow = (yield* SynchronizedRef.get(pictureInPictureSessionsRef)).get(
      tabId,
    )?.window;
    if (!pictureInPictureWindow || pictureInPictureWindow.isDestroyed()) return;
    yield* Effect.gen(function* () {
      const previousAspectRatio = (yield* Ref.get(pictureInPictureAspectRatiosRef)).get(tabId);
      const aspectRatio = frame.width / frame.height;
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
            const contentSize = fitPictureInPictureContentSize(
              pictureInPictureWindow.getContentSize(),
              aspectRatio,
            );
            pictureInPictureWindow.setAspectRatio(0);
            pictureInPictureWindow.setContentSize(contentSize[0], contentSize[1], false);
            pictureInPictureWindow.setAspectRatio(aspectRatio);
          },
        );
        yield* Ref.update(pictureInPictureAspectRatiosRef, (aspectRatios) =>
          replaceMap(aspectRatios, (copy) => {
            copy.set(tabId, aspectRatio);
          }),
        );
      }
      yield* attempt(
        {
          operation: "pictureInPicture.deliverFrame",
          tabId,
          webContentsId: wc.id,
        },
        () => {
          pictureInPictureWindow.webContents.send(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, frame);
        },
      );
      yield* SynchronizedRef.update(frameCaptureSessionsRef, (sessions) => {
        if (sessions.get(tabId) !== frameSession) return sessions;
        return replaceMap(sessions, (copy) => {
          copy.set(tabId, {
            ...frameSession,
            lastPictureInPictureFingerprint: fingerprint,
          });
        });
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Picture-in-picture frame delivery failed.", {
          tabId,
          error,
        }),
      ),
    );
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
      (sessions) => {
        return Effect.gen(function* () {
          if (!m.frameCaptureWindowOpen) {
            return yield* new PreviewMainWindowClosedError({ tabId });
          }
          const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
          if (!tab || (yield* Ref.get(closingTabIdsRef)).has(tabId)) {
            return yield* new PreviewTabNotFoundError({ tabId });
          }
          const wc = yield* deps.requireWebContents(tabId);
          const current = sessions.get(tabId);
          if (current) {
            if (current.consumers.has(consumer)) {
              return [false, sessions] as const;
            }
            if (!current.unthrottledWebContentsIds.has(wc.id)) {
              yield* deps.setFrameCaptureWebContentsBackgroundThrottling(wc, false);
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
            yield* deps.setFrameCaptureBackgroundThrottling(false);
          }
          yield* deps.setFrameCaptureWebContentsBackgroundThrottling(wc, false).pipe(
            Effect.onError(() =>
              sessions.size === 0
                ? deps.setFrameCaptureBackgroundThrottling(true).pipe(Effect.ignore)
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
                lastPictureInPictureFingerprint: null,
              });
            }),
          ] as const;
        });
      },
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

  return { captureScreenshot, capturePreviewFrame, startFrameCapture };
};

export type CaptureOps = ReturnType<typeof makeCaptureOps>;
