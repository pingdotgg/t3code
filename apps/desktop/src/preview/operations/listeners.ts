/**
 * Preview listeners: browser host, agent pointer, open-link and subscription plumbing.
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
import * as Stream from "effect/Stream";
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
import type { State } from "./state.ts";

export const makeListenersOps = (deps: State) => {
  const {
    parentScope,
    browserHost,
    tabsRef,
    pointerEventListenersRef,
    openLinkListenersRef,
    frameCaptureSessionsRef,
    attempt,
    currentIso,
    update,
    deliverEvent,
  } = deps;
  const m = deps.mutable;
  const listenToBrowserHost = Effect.suspend(() => {
    if (m.browserHostStarted) return Effect.void;
    m.browserHostStarted = true;
    const listen = Effect.forkIn(parentScope, { startImmediately: true });
    return Effect.all(
      [
        browserHost.pointers.pipe(Stream.runForEach(emitAgentPointer), listen),
        browserHost.painting.pipe(Stream.runForEach(updateServerTabCapturing), listen),
      ],
      { discard: true },
    );
  });

  const emitAgentPointer = Effect.fn("PreviewManager.emitAgentPointer")(function* (pointer: {
    readonly key: { readonly threadId: string; readonly tabId: string };
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }) {
    const tab = [...(yield* SynchronizedRef.get(tabsRef)).values()].find(
      (candidate) =>
        candidate.serverTab?.threadId === pointer.key.threadId &&
        candidate.serverTab.tabId === pointer.key.tabId,
    );
    if (!tab) return;
    const event: DesktopPreviewPointerEvent = {
      tabId: tab.tabId,
      phase: pointer.phase,
      x: pointer.x,
      y: pointer.y,
      sequence: ++m.pointerSequence,
      createdAt: yield* currentIso,
    };
    const recording = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tab.tabId);
    const webContentsId = tab.webContentsId;
    if (recording?.consumers.has("recording") && webContentsId != null) {
      yield* attempt({ operation: "recording.pointer", tabId: tab.tabId }, () => {
        const contents = webContents.fromId(webContentsId);
        if (contents && !contents.isDestroyed()) contents.send(RECORDING_POINTER_CHANNEL, event);
      }).pipe(Effect.ignore);
    }
    const listeners = yield* Ref.get(pointerEventListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("pointer-event", tab.tabId, () => listener(event)),
      { discard: true },
    );
  });

  const updateServerTabCapturing = Effect.fn("PreviewManager.updateServerTabCapturing")(
    function* (painting: {
      readonly key: { readonly threadId: string; readonly tabId: string };
      readonly active: boolean;
    }) {
      const tab = [...(yield* SynchronizedRef.get(tabsRef)).values()].find(
        (candidate) =>
          candidate.serverTab?.threadId === painting.key.threadId &&
          candidate.serverTab.tabId === painting.key.tabId,
      );
      if (tab && tab.capturing !== painting.active) {
        yield* update(tab.tabId, { capturing: painting.active });
      }
    },
  );

  const emitOpenLink = Effect.fn("PreviewManager.emitOpenLink")(function* (
    event: DesktopPreviewOpenLinkEvent,
  ) {
    const listeners = yield* Ref.get(openLinkListenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("open-link", event.tabId, () => listener(event)),
      { discard: true },
    );
  });

  const subscribe = <A>(
    ref: Ref.Ref<ReadonlySet<A>>,
    listener: A,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Ref.update(ref, (listeners) => new Set([...listeners, listener])),
      () =>
        Ref.update(ref, (listeners) => {
          const next = new Set(listeners);
          next.delete(listener);
          return next;
        }),
    ).pipe(Effect.asVoid);

  return { listenToBrowserHost, emitAgentPointer, updateServerTabCapturing, emitOpenLink, subscribe };
};

export type ListenersOps = ReturnType<typeof makeListenersOps>;
