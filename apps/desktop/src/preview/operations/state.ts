/**
 * Desktop preview operation state: Electron services, per-tab cells and the shared tab helpers.
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
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as DesktopRendererHistory from "../../telemetry/DesktopRendererHistory.ts";
import * as DesktopBrowserHost from "../DesktopBrowserHost.ts";
import * as PreviewPasskeys from "../Passkeys.ts";
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
import {
  PreviewOperationError,
  PreviewWebContentsNotFoundError,
  isPreviewOperationError,
} from "../errors.ts";
import {
  CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS,
  CAPTURE_PAGE_RETRY_ATTEMPTS,
  CAPTURE_PAGE_RETRY_DELAY_MS,
  DEFAULT_ANNOTATION_THEME,
} from "../geometry.ts";
import type {
  BrowserControlSession,
  FrameCaptureSession,
  Listener,
  ManagedListeners,
  OpenLinkListener,
  PendingRecording,
  PickSession,
  PictureInPictureSession,
  PointerEventListener,
  PreviewOperationContext,
  PreviewTabState,
  RecordingInputListener,
} from "../types.ts";

export interface OperationsStateDeps {
  readonly artifactDirectory: string;
  readonly pictureInPicturePreloadPath: string;
}

export const createOperationsState = Effect.fn("PreviewManager.makeOperationsState")(function* (
  deps: OperationsStateDeps,
) {
  const { artifactDirectory, pictureInPicturePreloadPath } = deps;

  const fileSystem = yield* FileSystem.FileSystem;

  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;

  const hostPlatform = yield* HostProcess.Platform;

  const path = yield* Path.Path;

  const random = yield* SecureRandom.SecureRandom;

  const parentScope = yield* Scope.Scope;

  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;

  const passkeys = yield* PreviewPasskeys.PreviewPasskeys;

  const context = yield* Effect.context<never>();

  const runFork = Effect.runForkWith(context);

  const resolvedArtifactDirectory = path.resolve(artifactDirectory);

  let forwardedShortcuts: ReadonlyArray<PreviewForwardedShortcut> = [];

  const annotationThemeRef = yield* Ref.make(DEFAULT_ANNOTATION_THEME);

  const annotationSendEnabled = new Map<string, boolean>();

  const mainWindowRef = yield* Ref.make<Option.Option<BrowserWindow>>(Option.none());

  const tabsRef = yield* SynchronizedRef.make<ReadonlyMap<string, PreviewTabState>>(new Map());

  const attachedRef = yield* Ref.make<ReadonlyMap<number, ManagedListeners>>(new Map());

  const listenersRef = yield* Ref.make<ReadonlySet<Listener>>(new Set());

  const pointerEventListenersRef = yield* Ref.make<ReadonlySet<PointerEventListener>>(new Set());

  const openLinkListenersRef = yield* Ref.make<ReadonlySet<OpenLinkListener>>(new Set());

  const recordingInputListenersRef = yield* Ref.make<ReadonlySet<RecordingInputListener>>(
    new Set(),
  );

  const pickSessionsRef = yield* Ref.make<ReadonlyMap<string, PickSession>>(new Map());

  const controlSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<number, BrowserControlSession>
  >(new Map());

  const frameCaptureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, FrameCaptureSession>
  >(new Map());

  const pictureInPictureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, PictureInPictureSession>
  >(new Map());

  const pictureInPictureAspectRatiosRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const pictureInPictureMutationSemaphore = yield* Semaphore.make(1);

  const closingTabIdsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  // Legacy tab capture is unsupported (electron/electron#44618); recording uses setDisplayMediaRequestHandler.

  let pendingRecording: PendingRecording | null = null;

  const displayMediaHandlerSessions = new WeakSet<Session>();

  let frameCaptureWindowOpen = true;

  let currentMainWindow: BrowserWindow | undefined;

  let mainWindowCleanupFiber: Fiber.Fiber<void, never> | undefined;

  const tabLifecycleLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();

  const tabLifecycleGenerations = new Map<string, number>();

  const attempt = <A>(errorContext: PreviewOperationContext, evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    });

  const attemptPromise = <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => PromiseLike<A>,
  ) =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
    });

  const capturePageWithRetry = Effect.fn("PreviewManager.capturePageWithRetry")(function* (
    errorContext: PreviewOperationContext,
    tabId: string,
    wc: Electron.WebContents,
  ) {
    const requireCurrentGuest = Effect.gen(function* () {
      const tabs = yield* SynchronizedRef.get(tabsRef);
      if (wc.isDestroyed() || tabs.get(tabId)?.webContentsId !== wc.id) {
        return yield* new PreviewWebContentsNotFoundError({ tabId, webContentsId: wc.id });
      }
    });
    const capture = Effect.gen(function* () {
      yield* requireCurrentGuest;
      const image = yield* Effect.tryPromise({
        try: (_signal) => wc.capturePage(),
        catch: (cause) => new PreviewOperationError({ ...errorContext, cause }),
      }).pipe(
        Effect.timeout(CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS),
        Effect.catchTags({
          TimeoutError: (cause) =>
            Effect.fail(new PreviewOperationError({ ...errorContext, cause })),
        }),
      );
      yield* requireCurrentGuest;
      return image;
    });
    return yield* capture.pipe(
      Effect.retry({
        times: CAPTURE_PAGE_RETRY_ATTEMPTS - 1,
        schedule: Schedule.spaced(CAPTURE_PAGE_RETRY_DELAY_MS),
        while: isPreviewOperationError,
      }),
    );
  });

  const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const currentMillis = Clock.currentTimeMillis;

  const replaceMap = <K, V>(
    source: ReadonlyMap<K, V>,
    update: (copy: Map<K, V>) => void,
  ): ReadonlyMap<K, V> => {
    const copy = new Map(source);
    update(copy);
    return copy;
  };

  const update = Effect.fn("PreviewManager.update")(function* (
    tabId: string,
    patch: Partial<PreviewTabState>,
    humanPoint?: { readonly x: number; readonly y: number },
  ) {
    const updatedAt = yield* currentIso;
    const next = yield* SynchronizedRef.modify(tabsRef, (tabs) => {
      const current = tabs.get(tabId);
      if (!current) return [Option.none<PreviewTabState>(), tabs] as const;
      const state: PreviewTabState = { ...current, ...patch, updatedAt };
      return [
        Option.some(state),
        replaceMap(tabs, (copy) => {
          copy.set(tabId, state);
        }),
      ] as const;
    });
    // syncTabAudible can commit after this update; emitIfCurrent prevents publishing a stale snapshot.
    if (Option.isSome(next)) {
      if (patch.controller !== undefined && next.value.webContentsId != null) {
        const capture = (yield* SynchronizedRef.get(frameCaptureSessionsRef)).get(tabId);
        const webContentsId = next.value.webContentsId;
        if (capture?.consumers.has("recording")) {
          yield* attempt({ operation: "recording.controller", tabId }, () => {
            const contents = webContents.fromId(webContentsId);
            if (contents && !contents.isDestroyed())
              contents.send(RECORDING_CONTROLLER_CHANNEL, patch.controller, humanPoint);
          }).pipe(Effect.ignore);
        }
      }
      yield* emitIfCurrent(tabId, next.value);
    }
  });

  /** Read zoom after awaits so concurrent zoom actions cannot be rolled back by an older snapshot. */

  const deliverEvent = (
    eventKind: "state-change" | "recording-input" | "pointer-event" | "open-link",
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) =>
    Effect.suspend(delivery).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logWarning("Desktop preview event listener failed.", {
            eventKind,
            tabId,
            cause,
          }),
      ),
    );

  const emit = Effect.fn("PreviewManager.emit")(function* (tabId: string, state: PreviewTabState) {
    const listeners = yield* Ref.get(listenersRef);
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent("state-change", tabId, () => listener(tabId, state)),
      { discard: true },
    );
  });

  const emitIfCurrent = Effect.fn("PreviewManager.emitIfCurrent")(function* (
    tabId: string,
    state: PreviewTabState,
  ) {
    if ((yield* SynchronizedRef.get(tabsRef)).get(tabId) === state) {
      yield* emit(tabId, state);
    }
  });

  const withTabLifecycleLock = <A, E, R>(
    tabId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const lifecycle = tabLifecycleLocks.get(tabId) ?? {
        semaphore: Semaphore.makeUnsafe(1),
        users: 0,
      };
      lifecycle.users += 1;
      tabLifecycleLocks.set(tabId, lifecycle);
      return lifecycle.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lifecycle.users -= 1;
            if (lifecycle.users === 0 && tabLifecycleLocks.get(tabId) === lifecycle) {
              tabLifecycleLocks.delete(tabId);
            }
          }),
        ),
      );
    });

  let pointerSequence = 0;

  let browserHostStarted = false;
  // Subscribes before the attach that follows, so no event falls between the two.

  return {
    pictureInPicturePreloadPath,
    fileSystem,
    rendererHistory,
    hostPlatform,
    path,
    random,
    parentScope,
    browserHost,
    passkeys,
    context,
    runFork,
    resolvedArtifactDirectory,
    annotationThemeRef,
    annotationSendEnabled,
    mainWindowRef,
    tabsRef,
    attachedRef,
    listenersRef,
    pointerEventListenersRef,
    openLinkListenersRef,
    recordingInputListenersRef,
    pickSessionsRef,
    controlSessionsRef,
    frameCaptureSessionsRef,
    pictureInPictureSessionsRef,
    pictureInPictureAspectRatiosRef,
    pictureInPictureMutationSemaphore,
    closingTabIdsRef,
    displayMediaHandlerSessions,
    tabLifecycleLocks,
    tabLifecycleGenerations,
    attempt,
    attemptPromise,
    capturePageWithRetry,
    currentIso,
    currentMillis,
    replaceMap,
    update,
    deliverEvent,
    emit,
    emitIfCurrent,
    withTabLifecycleLock,
    mutable: {
    get forwardedShortcuts() {
      return forwardedShortcuts;
    },
    set forwardedShortcuts(value) {
      forwardedShortcuts = value;
    },
    get pendingRecording() {
      return pendingRecording;
    },
    set pendingRecording(value) {
      pendingRecording = value;
    },
    get frameCaptureWindowOpen() {
      return frameCaptureWindowOpen;
    },
    set frameCaptureWindowOpen(value) {
      frameCaptureWindowOpen = value;
    },
    get currentMainWindow() {
      return currentMainWindow;
    },
    set currentMainWindow(value) {
      currentMainWindow = value;
    },
    get mainWindowCleanupFiber() {
      return mainWindowCleanupFiber;
    },
    set mainWindowCleanupFiber(value) {
      mainWindowCleanupFiber = value;
    },
    get pointerSequence() {
      return pointerSequence;
    },
    set pointerSequence(value) {
      pointerSequence = value;
    },
    get browserHostStarted() {
      return browserHostStarted;
    },
    set browserHostStarted(value) {
      browserHostStarted = value;
    },
    },
  };
});

export type State = Effect.Success<ReturnType<typeof createOperationsState>>;
