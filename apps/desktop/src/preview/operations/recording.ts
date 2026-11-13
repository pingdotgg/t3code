/**
 * Preview screen recording: arm, start, stop and save.
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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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
import { DEFAULT_RECORDING_INPUT_OPTIONS, type RecordingInputOptions } from "../RecordingInput.ts";
import {
  PreviewMainWindowClosedError,
  PreviewOperationError,
  PreviewRecordingArmConflictError,
  PreviewRecordingCaptureUnavailableError,
  PreviewTabNotFoundError,
  PreviewWebContentsNotFoundError,
} from "../errors.ts";
import {
  CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS,
  RECORDING_ARM_GRACE_MS,
  recordingFileExtension,
  requestRecordingCaptureExpression,
} from "../geometry.ts";
import type {
  PendingRecording,
} from "../types.ts";
import type { WindowOps } from "./window.ts";
import type { SessionOps } from "./session.ts";
import type { CaptureOps } from "./capture.ts";
import type { TabsOps } from "./tabs.ts";
import type { State } from "./state.ts";

export const makeRecordingOps = (deps: State & WindowOps & SessionOps & CaptureOps & TabsOps) => {
  const {
    fileSystem,
    path,
    parentScope,
    resolvedArtifactDirectory,
    tabsRef,
    frameCaptureSessionsRef,
    closingTabIdsRef,
    displayMediaHandlerSessions,
    attempt,
    attemptPromise,
    currentIso,
    currentMillis,
    replaceMap,
    update,
    withTabLifecycleLock,
  } = deps;
  const m = deps.mutable;
  const armPendingRecording = Effect.fn("PreviewManager.armPendingRecording")(function* (
    tabId: string,
    wc: Electron.WebContents,
    requestingFrameTreeNodeId: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const previous = m.pendingRecording;
    if (
      previous !== null &&
      previous.tabId !== tabId &&
      !previous.webContents.isDestroyed() &&
      now - previous.armedAtMillis < RECORDING_ARM_GRACE_MS
    ) {
      return yield* new PreviewRecordingArmConflictError({
        tabId,
        webContentsId: wc.id,
        armedTabId: previous.tabId,
      });
    }
    const armed: PendingRecording = {
      tabId,
      webContents: wc,
      requestingFrameTreeNodeId,
      armedAtMillis: now,
    };
    m.pendingRecording = armed;
    // The synchronous callback cannot read a clock. Compare identity so expiry cannot clobber a re-arm.
    yield* Effect.forkIn(
      Effect.sleep(RECORDING_ARM_GRACE_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (m.pendingRecording === armed) m.pendingRecording = null;
          }),
        ),
      ),
      parentScope,
    );
  });

  // Only serve the tab armed by startRecording; pages must not capture independently.

  const installDisplayMediaRequestHandler = (session: Session) => {
    if (displayMediaHandlerSessions.has(session)) return;
    displayMediaHandlerSessions.add(session);
    session.setDisplayMediaRequestHandler((request, callback) => {
      const armed = m.pendingRecording;
      if (!armed) {
        callback({});
        return;
      }
      if (armed.webContents.isDestroyed()) {
        m.pendingRecording = null;
        callback({});
        return;
      }
      if (request.frame?.frameTreeNodeId !== armed.requestingFrameTreeNodeId) {
        callback({});
        return;
      }
      m.pendingRecording = null;
      callback({ video: armed.webContents.mainFrame });
    });
  };

  const startRecording = Effect.fn("PreviewManager.startRecording")(function* (
    tabId: string,
    options: RecordingInputOptions = DEFAULT_RECORDING_INPUT_OPTIONS,
  ) {
    if ((yield* Ref.get(closingTabIdsRef)).has(tabId)) {
      return yield* new PreviewTabNotFoundError({ tabId });
    }
    return yield* withTabLifecycleLock(
      tabId,
      Effect.gen(function* () {
        yield* deps.startFrameCapture(tabId, "recording");
        yield* SynchronizedRef.update(frameCaptureSessionsRef, (sessions) =>
          replaceMap(sessions, (copy) => {
            const current = copy.get(tabId);
            if (current) copy.set(tabId, { ...current, recordingInputOptions: options });
          }),
        );
        const wc = yield* deps.requireWebContents(tabId);
        const requestWebContents = wc.hostWebContents;
        if (requestWebContents === null) {
          return yield* new PreviewMainWindowClosedError({ tabId });
        }
        const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
        yield* attempt({ operation: "recording.cursor", tabId, webContentsId: wc.id }, () =>
          wc.send(RECORDING_CURSOR_CHANNEL, true, options, tab?.controller),
        );
        const warmupContext = { operation: "recording.warmSource", tabId, webContentsId: wc.id };
        yield* Effect.tryPromise({
          // Electron cannot cancel capturePage, but a stalled warmup must release the tab lock.
          try: (_signal) => wc.capturePage(),
          catch: (cause) => new PreviewOperationError({ ...warmupContext, cause }),
        }).pipe(
          Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
          Effect.catchTags({
            TimeoutError: (cause) =>
              Effect.fail(new PreviewOperationError({ ...warmupContext, cause })),
          }),
          Effect.retry({ times: 1 }),
          Effect.ignore,
        );
        const currentWebContents = yield* deps.requireWebContents(tabId);
        if (currentWebContents !== wc || wc.isDestroyed()) {
          return yield* new PreviewWebContentsNotFoundError({
            tabId,
            webContentsId: wc.id,
          });
        }
        if (!m.frameCaptureWindowOpen || requestWebContents.isDestroyed()) {
          return yield* new PreviewMainWindowClosedError({ tabId });
        }
        installDisplayMediaRequestHandler(requestWebContents.session);
        yield* armPendingRecording(tabId, wc, requestWebContents.mainFrame.frameTreeNodeId);
        const captureRequested = yield* attemptPromise(
          {
            operation: "recording.requestCapture",
            tabId,
            webContentsId: requestWebContents.id,
          },
          () =>
            requestWebContents.executeJavaScript(requestRecordingCaptureExpression(tabId), true),
        );
        if (captureRequested !== true) {
          return yield* new PreviewRecordingCaptureUnavailableError({
            tabId,
            webContentsId: requestWebContents.id,
          });
        }
      }).pipe(
        Effect.onError(() => {
          deps.clearPendingRecording(tabId);
          return deps.stopFrameCapture(tabId, "recording").pipe(Effect.ignore);
        }),
      ),
    );
  });

  const stopRecording = Effect.fn("PreviewManager.stopRecording")(function* (tabId: string) {
    // Clearing runs under the tab lock so it cannot land before an in-flight start arms.
    yield* withTabLifecycleLock(
      tabId,
      Effect.suspend(() => {
        deps.clearPendingRecording(tabId);
        return deps.stopFrameCapture(tabId, "recording");
      }),
    );
  });

  const saveRecording = Effect.fn("PreviewManager.saveRecording")(function* (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    const [createdAt, millis] = yield* Effect.all([currentIso, currentMillis]);
    const id = `browser-recording-${millis.toString(36)}`;
    const extension = recordingFileExtension(mimeType);
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

  return { armPendingRecording, installDisplayMediaRequestHandler, startRecording, stopRecording, saveRecording };
};

export type RecordingOps = ReturnType<typeof makeRecordingOps>;
