import { it as effectIt } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type {
  DesktopPreviewRecordingInputEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewPasskeys from "./Passkeys.ts";


import {
  createManagerHarness,
  makeTestHostWebContents,
  makeTestPictureInPictureWindow,
} from "./Manager.testkit.ts";

describe("fitPictureInPictureContentSize", () => {
  it("does not collapse toward the minimum size when orientation changes repeatedly", () => {
    const portrait = PreviewManager.fitPictureInPictureContentSize([523, 294], 9 / 16);
    const landscape = PreviewManager.fitPictureInPictureContentSize(portrait, 16 / 9);

    expect(portrait).toEqual([294, 523]);
    expect(landscape).toEqual([523, 294]);
  });
});

describe("isPreviewEditingShortcut", () => {
  const input = (platform: NodeJS.Platform, key: string, overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key,
      meta: platform === "darwin",
      control: platform !== "darwin",
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it("recognizes macOS Paste and Match Style when Option changes the key to a symbol", () => {
    const pasteAndMatchStyle = input("darwin", "◊", { code: "KeyV", alt: true, shift: true });
    expect(PreviewManager.isPreviewEditingShortcut(pasteAndMatchStyle, "darwin")).toBe(true);
    for (const modifiers of [
      { code: "KeyC" },
      { alt: false },
      { shift: false },
      { control: true },
    ]) {
      expect(
        PreviewManager.isPreviewEditingShortcut({ ...pasteAndMatchStyle, ...modifiers }, "darwin"),
      ).toBe(false);
    }
  });
});

describe("previewWindowOpenAction", () => {
  const details = (overrides: {
    readonly url?: string;
    readonly disposition?: Electron.HandlerDetails["disposition"];
  }) => ({
    url: "https://accounts.google.com/o/oauth2/auth",
    disposition: "new-window" as Electron.HandlerDetails["disposition"],
    ...overrides,
  });

  it("opens a real window for scripted popups so the opener survives", () => {
    expect(PreviewManager.previewWindowOpenAction(details({}))).toBe("popup");
    expect(
      PreviewManager.previewWindowOpenAction(details({ url: "http://localhost:5173/auth" })),
    ).toBe("popup");
  });

  it("opens HTTP links in preview tabs", () => {
    for (const disposition of ["foreground-tab", "background-tab"] as const) {
      expect(PreviewManager.previewWindowOpenAction(details({ disposition }))).toBe("new-tab");
    }
  });

  it("keeps a form POST with a body on the in-place path", () => {
    const postBody = { data: [], contentType: "application/x-www-form-urlencoded" };
    expect(
      PreviewManager.previewWindowOpenAction({
        ...details({ disposition: "foreground-tab" }),
        postBody,
      }),
    ).toBe("navigate");
  });

  it("does not hand a window to schemes that cannot be hardened", () => {
    for (const url of [
      "vscode://vscode-remote/ssh-remote+box/tmp",
      "blob:https://example.com/0b6c6a5e-55d4-4b4c-9d47-8f1b0c1d2e3f",
    ]) {
      expect(PreviewManager.previewWindowOpenAction(details({ url }))).toBe("navigate");
    }
  });

  it("denies local and inline schemes that no page could open in place itself", () => {
    for (const url of [
      "data:text/html,<h1>hi</h1>",
      "DaTa:text/html,<h1>hi</h1>",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "view-source:https://example.com",
      "chrome://gpu",
      "about:srcdoc",
      "devtools://devtools/bundled/inspector.html",
      "filesystem:https://example.com/temporary/page.html",
      "not a url",
    ]) {
      for (const disposition of ["new-window", "foreground-tab", "background-tab"] as const) {
        expect(PreviewManager.previewWindowOpenAction(details({ url, disposition }))).toBe("deny");
      }
    }
  });

  it("denies a blank window instead of blanking the opener", () => {
    for (const url of ["about:blank", ""]) {
      for (const disposition of ["new-window", "foreground-tab"] as const) {
        expect(PreviewManager.previewWindowOpenAction(details({ url, disposition }))).toBe("deny");
      }
    }
  });
});

const {
  browserWindowConstructor,
  clipboardItemConstructor,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  previewSession,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeClipboard,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  clipboardItemConstructor: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean; readonly toPNG: () => Buffer } => ({
    isEmpty: () => false,
    toPNG: () => Buffer.from("png"),
  })),
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  previewSession: { on: vi.fn() },
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeClipboard: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  // oxlint-disable-next-line typescript/no-extraneous-class -- This constructor-only mock implements the browser ClipboardItem API.
  ClipboardItem: class {
    constructor(data: Record<string, unknown>) {
      clipboardItemConstructor(data);
    }
  },
  clipboard: {
    write: writeClipboard,
  },
  nativeImage: {
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

const {
  withManager,
  makeTestPreviewWebContents,
} = createManagerHarness({
  previewSession,
  mkdir,
  writeFile,
  fromId,
  webviewSend,
});

describe("PreviewManager", () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset();
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    previewSession.on.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    clipboardItemConstructor.mockClear();
    writeClipboard.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
  });


  const makeAttachingGuest = (id: number) => {
    const listeners = new Map<string, () => void>();
    const attach = vi.fn();
    const detach = vi.fn();
    const sendCommand = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => undefined,
    );
    const detachListeners = new Set<() => void>();
    let chromiumDetaches = 0;
    let destroyed = false;
    const wc = {
      id,
      isDestroyed: () => destroyed,
      isDevToolsOpened: () => {
        if (destroyed) throw new TypeError("Object has been destroyed");
        return false;
      },
      getType: () => "webview",
      getURL: () => "http://localhost:5173/README.md",
      getTitle: () => "README.md",
      isLoadingMainFrame: () => true,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      on: vi.fn(),
      off: vi.fn(),
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      ipc: { on: vi.fn(), off: vi.fn() },
      send: webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => attach.mock.calls.length > detach.mock.calls.length + chromiumDetaches,
        attach,
        detach,
        sendCommand,
        on: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.add(listener);
        },
        off: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.delete(listener);
        },
      },
    };
    /** Chromium dropping the debugger without a detach() call. */
    const chromiumDetach = () => {
      chromiumDetaches += 1;
      // Snapshot like an EventEmitter, so a listener added during emit waits for the next one.
      for (const listener of Array.from(detachListeners)) listener();
    };
    return {
      wc: wc as unknown as Electron.WebContents,
      attach,
      detach,
      sendCommand,
      chromiumDetach,
      destroy: () => {
        destroyed = true;
        listeners.get("destroyed")?.();
      },
    };
  };

  effectIt.effect("reattaches a debugger that Chromium dropped on its own", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAttachingGuest(48);
        fromId.mockReturnValue(guest.wc);
        yield* manager.createTab("tab_detached");
        yield* manager.registerWebview("tab_detached", 48);
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(1);

        guest.chromiumDetach();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect("skips a guest destroyed while another guest's session opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const slow = makeAttachingGuest(46);
        let releaseSlow = () => {};
        const slowCommand = new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        slow.sendCommand.mockImplementation(() => slowCommand);
        const queued = makeAttachingGuest(47);

        const slowFiber = yield* manager
          .prepareWebview(slow.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const queuedFiber = yield* manager
          .prepareWebview(queued.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        queued.destroy();
        releaseSlow();

        expect(Exit.isSuccess(yield* Fiber.await(slowFiber))).toBe(true);
        expect(Exit.isSuccess(yield* Fiber.await(queuedFiber))).toBe(true);
        expect(slow.attach).toHaveBeenCalledTimes(1);
        expect(queued.attach).not.toHaveBeenCalled();
      }),
    ),
  );

  const makeAudioWebContents = (id: number) => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const setAudioMuted = vi.fn();
    let audible = false;
    let audibleAfterFirstRead = false;
    let audibleReads = 0;
    return {
      setAudioMuted,
      emitAudioState: (next: boolean) => {
        audible = next;
        listeners.get("audio-state-changed")?.({ audible: next } as never);
      },
      /** Simulate playback starting during attach before the tab owns the guest and can receive its events. */
      startPlayingAfterFirstRead: () => {
        audibleAfterFirstRead = true;
      },
      wc: {
        id,
        isDestroyed: () => false,
        isDevToolsOpened: () => false,
        getType: () => "webview",
        getURL: () => "https://example.com",
        getTitle: () => "Example",
        isLoadingMainFrame: () => false,
        getZoomFactor: () => 1,
        setZoomFactor: vi.fn(),
        setAudioMuted,
        isCurrentlyAudible: () => {
          audibleReads += 1;
          if (audibleAfterFirstRead && audibleReads > 1) return true;
          return audible;
        },
        loadURL: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (...args: never[]) => void) => {
          listeners.set(event, listener);
        }),
        off: vi.fn((event: string) => {
          listeners.delete(event);
        }),
        ipc: { on: vi.fn(), off: vi.fn() },
        send: webviewSend,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setIgnoreMenuShortcuts: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        debugger: {
          isAttached: () => false,
          attach: vi.fn(),
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
        },
      } as never,
    };
  };

  effectIt.effect("reconciles audibility that changed while the guest attached", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        guest.startPlayingAfterFirstRead();
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_window");
        yield* manager.registerWebview("tab_audio_window", 42);
        yield* Effect.yieldNow;

        expect(states.at(-1)?.audible).toBe(true);
      }),
    ),
  );

  effectIt.effect("ignores audio state from a replaced guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAudioWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_stale");
        yield* manager.registerWebview("tab_audio_stale", 42);
        yield* Effect.yieldNow;

        const replacement = makeAudioWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_audio_stale", 43);
        yield* Effect.yieldNow;

        const publishedBefore = states.length;
        first.emitAudioState(true);
        yield* Effect.yieldNow;

        expect(states.length).toBe(publishedBefore);
        expect(states.at(-1)?.audible).toBe(false);
      }),
    ),
  );

  effectIt.effect("blocks late webview and capture starts during tab close", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("close-race-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const firstWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(capturePage, 43);
        const replacementListenerSpies = replacementWebContents as unknown as {
          readonly on: ReturnType<typeof vi.fn>;
          readonly off: ReturnType<typeof vi.fn>;
          readonly ipc: { readonly off: ReturnType<typeof vi.fn> };
        };
        fromId.mockImplementation((id) => {
          if (id === 42) return firstWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_close_register_race");
        yield* manager.registerWebview("tab_close_register_race", 42);
        yield* manager.openPictureInPicture("tab_close_register_race");

        const closeCleanupPaused = yield* Deferred.make<void>();
        const continueCloseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          !state.pictureInPicture && state.webContentsId === 42
            ? Deferred.succeed(closeCleanupPaused, undefined).pipe(
                Effect.andThen(Deferred.await(continueCloseCleanup)),
              )
            : Effect.void,
        );

        const closeFiber = yield* manager
          .closeTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(closeCleanupPaused);
        const recreateFiber = yield* manager
          .createTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        const registrationFiber = yield* manager
          .registerWebview("tab_close_register_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        yield* manager.closeTab("tab_close_register_race");
        const recordingExit = yield* Effect.exit(manager.startRecording("tab_close_register_race"));
        yield* Deferred.succeed(continueCloseCleanup, undefined);
        yield* Fiber.join(closeFiber);
        const recreated = yield* Fiber.join(recreateFiber);
        const registrationExit = yield* Fiber.await(registrationFiber);

        for (const exit of [registrationExit, recordingExit] as ReadonlyArray<
          Exit.Exit<unknown, PreviewManager.PreviewManagerError>
        >) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isSuccess(exit)) continue;
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewTabNotFoundError",
            tabId: "tab_close_register_race",
          });
        }
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        expect(replacementListenerSpies.off).not.toHaveBeenCalled();
        expect(replacementListenerSpies.ipc.off).not.toHaveBeenCalled();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(recreated.webContentsId).toBeNull();
      }),
    ),
  );

  effectIt.effect("preserves both screenshots of the same site in the same millisecond", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstPng = Buffer.from("first-preview-png");
        const secondPng = Buffer.from("second-preview-png");
        const pngImage = (png: Buffer) => ({
          toPNG: () => png,
          toJPEG: () => png,
          getSize: () => ({ width: 1280, height: 720 }),
        });
        const capturePage = vi
          .fn<() => Promise<ReturnType<typeof pngImage>>>()
          .mockResolvedValueOnce(pngImage(firstPng))
          .mockResolvedValueOnce(pngImage(secondPng));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const first = yield* manager.captureScreenshot("tab_1");
        const second = yield* manager.captureScreenshot("tab_1");

        expect(first.createdAt).toBe(second.createdAt);
        expect(first.id).not.toBe(second.id);
        expect(first.path).not.toBe(second.path);
        expect(first.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(second.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(writeFile.mock.calls).toEqual([
          [first.path, firstPng],
          [second.path, secondPng],
        ]);
      }),
    ),
  );

  effectIt.effect("keeps every recorded guest unthrottled until its frame capture stops", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const firstWebContents = makeTestPreviewWebContents(capturePage, 41, host);
        const secondWebContents = makeTestPreviewWebContents(capturePage, 42, host);
        const webContentsById = new Map([
          [41, firstWebContents],
          [42, secondWebContents],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_capture_throttling_1");
        yield* manager.createTab("tab_capture_throttling_2");
        yield* manager.registerWebview("tab_capture_throttling_1", 41);
        yield* manager.registerWebview("tab_capture_throttling_2", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        yield* manager.startRecording("tab_capture_throttling_1");
        host.displayMediaHandler()?.({ frame: host.mainFrame }, () => {});
        yield* manager.startRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_1");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("does not commit failed starts and retries throttle restoration", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_capture_throttling_failure");
        yield* manager.registerWebview("tab_capture_throttling_failure", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("start throttling update failed");
        });
        const failedStart = yield* Effect.exit(
          manager.startRecording("tab_capture_throttling_failure"),
        );
        expect(Exit.isFailure(failedStart)).toBe(true);

        yield* manager.startRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false]]);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("stop throttling update failed");
        });
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false], [true], [true]]);

        yield* manager.startRecording("tab_capture_throttling_failure");
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [false],
          [true],
          [true],
          [false],
          [true],
        ]);
      }),
    ),
  );

  effectIt.effect("keeps frame capture closed when a replacement is destroyed during cleanup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const windowEvents = new Map<string, () => void>();
        const host = makeTestHostWebContents();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const guest = makeTestPreviewWebContents(capturePage, 42, host);
        fromId.mockReturnValue(guest);
        yield* manager.createTab("tab_shutdown");
        yield* manager.registerWebview("tab_shutdown", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: (event: string, listener: () => void) => windowEvents.set(event, listener),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);
        yield* manager.startRecording("tab_shutdown");
        const pip = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pip.pictureInPictureWindow;
        });
        yield* manager.openPictureInPicture("tab_shutdown");
        const capturesBeforeClose = capturePage.mock.calls.length;
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          state.pictureInPicture
            ? Effect.void
            : Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
              ),
        );

        windowEvents.get("closed")!();
        yield* Deferred.await(cleanupStarted);
        let destroyed = false;
        const replacement = yield* manager
          .setMainWindow({
            isDestroyed: () => destroyed,
            once: vi.fn(),
            webContents: { setBackgroundThrottling: vi.fn() },
          } as never)
          .pipe(Effect.forkChild({ startImmediately: true }));
        try {
          expect(replacement.pollUnsafe()).toBeUndefined();
          destroyed = true;
        } finally {
          yield* Deferred.succeed(releaseCleanup, undefined);
        }
        yield* Fiber.join(replacement);

        const restart = yield* Effect.exit(manager.startRecording("tab_shutdown"));
        expect(Exit.isFailure(restart)).toBe(true);
        if (Exit.isFailure(restart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(restart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_shutdown",
          });
        }
        expect(capturePage).toHaveBeenCalledTimes(capturesBeforeClose);
        expect(pip.pictureInPictureWindow.isDestroyed()).toBe(true);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);
      }),
    ),
  );
});
