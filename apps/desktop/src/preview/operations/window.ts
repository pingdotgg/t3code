/**
 * Preview frame capture throttling and window background policy.
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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
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
import type {
  FrameCaptureConsumer,
} from "../types.ts";
import type { State } from "./state.ts";

export const makeWindowOps = (deps: State) => {
  const {
    mainWindowRef,
    tabsRef,
    frameCaptureSessionsRef,
    attempt,
    replaceMap,
  } = deps;
  const m = deps.mutable;
  const setWindowBackgroundThrottling = Effect.fnUntraced(function* (
    window: BrowserWindow,
    enabled: boolean,
  ) {
    if (window.isDestroyed()) return;
    yield* attempt({ operation: "frameCapture.setBackgroundThrottling" }, () =>
      window.webContents.setBackgroundThrottling(enabled),
    );
  });

  const setFrameCaptureBackgroundThrottling = Effect.fnUntraced(function* (enabled: boolean) {
    const mainWindow = yield* Ref.get(mainWindowRef);
    if (Option.isNone(mainWindow)) return;
    yield* setWindowBackgroundThrottling(mainWindow.value, enabled);
  });

  const setFrameCaptureWebContentsBackgroundThrottling = Effect.fnUntraced(function* (
    wc: Electron.WebContents,
    enabled: boolean,
  ) {
    if (wc.isDestroyed()) return;
    yield* attempt(
      {
        operation: "frameCapture.setBackgroundThrottling",
        webContentsId: wc.id,
      },
      () => wc.setBackgroundThrottling(enabled),
    );
  });

  const restoreFrameCaptureWebContentsBackgroundThrottling = Effect.fnUntraced(function* (
    webContentsIds: ReadonlySet<number>,
  ) {
    yield* Effect.forEach(
      webContentsIds,
      (webContentsId) => {
        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) return Effect.void;
        return setFrameCaptureWebContentsBackgroundThrottling(wc, true).pipe(
          Effect.retry({ times: 2 }),
          Effect.catch((error) =>
            Effect.logWarning("Failed to restore preview webview frame capture throttling.", {
              webContentsId,
              error,
            }),
          ),
        );
      },
      { concurrency: "unbounded", discard: true },
    );
  });

  const keepFrameCaptureWebContentsUnthrottled = Effect.fnUntraced(function* (
    tabId: string,
    wc: Electron.WebContents,
  ) {
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) => {
      const current = sessions.get(tabId);
      if (!current || current.unthrottledWebContentsIds.has(wc.id)) {
        return Effect.succeed([undefined, sessions] as const);
      }
      return setFrameCaptureWebContentsBackgroundThrottling(wc, false).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            if (!current.consumers.has("recording")) return;
            const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId);
            yield* attempt({ operation: "recording.cursor", tabId, webContentsId: wc.id }, () =>
              wc.send(
                RECORDING_CURSOR_CHANNEL,
                true,
                current.recordingInputOptions,
                tab?.controller,
              ),
            );
          }),
        ),
        Effect.map(
          () =>
            [
              undefined,
              replaceMap(sessions, (copy) => {
                copy.set(tabId, {
                  ...current,
                  unthrottledWebContentsIds: new Set([...current.unthrottledWebContentsIds, wc.id]),
                });
              }),
            ] as const,
        ),
      );
    });
  });

  const stopFrameCapture = Effect.fn("PreviewManager.stopFrameCapture")(function* (
    tabId: string,
    consumer: FrameCaptureConsumer,
  ) {
    yield* SynchronizedRef.modifyEffect(frameCaptureSessionsRef, (sessions) =>
      Effect.gen(function* () {
        const current = sessions.get(tabId);
        if (!current || !current.consumers.has(consumer)) {
          return [undefined, sessions] as const;
        }
        if (consumer === "recording") {
          yield* Effect.forEach(current.unthrottledWebContentsIds, (id) =>
            attempt({ operation: "recording.cursor", tabId, webContentsId: id }, () => {
              const contents = webContents.fromId(id);
              if (contents && !contents.isDestroyed())
                contents.send(RECORDING_CURSOR_CHANNEL, false);
            }).pipe(Effect.ignore),
          );
        }
        const consumers = new Set(current.consumers);
        consumers.delete(consumer);
        if (consumers.size > 0) {
          return [
            consumer === "picture-in-picture" ? current.scope : undefined,
            replaceMap(sessions, (copy) => {
              copy.set(tabId, {
                ...current,
                scope: consumer === "picture-in-picture" ? null : current.scope,
                consumers,
                lastPictureInPictureFingerprint:
                  consumer === "picture-in-picture"
                    ? null
                    : current.lastPictureInPictureFingerprint,
              });
            }),
          ] as const;
        }
        const remainingSessions = replaceMap(sessions, (copy) => {
          copy.delete(tabId);
        });
        yield* restoreFrameCaptureWebContentsBackgroundThrottling(
          current.unthrottledWebContentsIds,
        );
        if (remainingSessions.size === 0) {
          yield* setFrameCaptureBackgroundThrottling(true).pipe(
            Effect.retry({ times: 2 }),
            Effect.catch((error) =>
              Effect.logWarning("Failed to restore preview frame capture throttling.", { error }),
            ),
          );
        }
        return [current.scope, remainingSessions] as const;
      }),
    ).pipe(
      Effect.flatMap((captureScope) =>
        captureScope ? Scope.close(captureScope, Exit.void).pipe(Effect.ignore) : Effect.void,
      ),
      Effect.uninterruptible,
    );
  });

  const stopAllRecordings = Effect.fn("PreviewManager.stopAllRecordings")(function* () {
    m.pendingRecording = null;
    const sessions = yield* SynchronizedRef.get(frameCaptureSessionsRef);
    yield* Effect.forEach(sessions.keys(), (tabId) => stopFrameCapture(tabId, "recording"), {
      concurrency: "unbounded",
      discard: true,
    });
  });

  return { setWindowBackgroundThrottling, setFrameCaptureBackgroundThrottling, setFrameCaptureWebContentsBackgroundThrottling, restoreFrameCaptureWebContentsBackgroundThrottling, keepFrameCaptureWebContentsUnthrottled, stopFrameCapture, stopAllRecordings };
};

export type WindowOps = ReturnType<typeof makeWindowOps>;
