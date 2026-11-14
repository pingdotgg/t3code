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
  type TestCapturedPreviewImage,
} from "./Manager.testkit.ts";

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
  managerLayer,
  withManager,
  makeTestPreviewWebContents,
  setupRecordingRaceTabs,
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


  effectIt.effect("ignores close events from replaced main windows", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeFirstWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_replaced_window_close");
        yield* manager.registerWebview("tab_replaced_window_close", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeFirstWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);

        closeFirstWindow?.();
        yield* manager.startRecording("tab_replaced_window_close");
        expect(firstWindowThrottling).not.toHaveBeenCalled();
        expect(replacementWindowThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_replaced_window_close");
        expect(replacementWindowThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("releases frame capture when the main window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const webContentsById = new Map([
          [42, makeTestPreviewWebContents(capturePage, 42, host)],
          [43, makeTestPreviewWebContents(capturePage, 43, host)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_window_close_recording");
        yield* manager.createTab("tab_window_close_race");
        yield* manager.registerWebview("tab_window_close_recording", 42);
        yield* manager.registerWebview("tab_window_close_race", 43);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.startRecording("tab_window_close_recording");
        expect(firstWindowThrottling.mock.calls).toEqual([[false]]);

        closeMainWindow?.();
        const racedStart = yield* Effect.exit(manager.startRecording("tab_window_close_race"));
        expect(Exit.isFailure(racedStart)).toBe(true);
        if (Exit.isFailure(racedStart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(racedStart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_race",
          });
        }
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);

        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);
        expect(replacementWindowThrottling).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("does not arm recording after the main window closes during warmup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        const capturedImage = {
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const capturePage = vi.fn(
          () =>
            new Promise<TestCapturedPreviewImage>((resolve) => {
              markWarmupStarted();
              finishWarmup = resolve;
            }),
        );
        const host = makeTestHostWebContents();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42, host));

        yield* manager.createTab("tab_window_close_warmup");
        yield* manager.registerWebview("tab_window_close_warmup", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);

        const start = yield* manager
          .startRecording("tab_window_close_warmup")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        closeMainWindow?.();
        finishWarmup(capturedImage);

        const exit = yield* Fiber.await(start);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_warmup",
          });
        }
        expect(host.session.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("tells the server when a tab it renders natively closes", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.DesktopBrowserHost;
      const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
      const lines = yield* Queue.unbounded<string>();
      yield* host.events.pipe(
        Stream.runForEach((line) => Queue.offer(lines, new TextDecoder().decode(line))),
        Effect.forkScoped,
      );
      const nextType = Queue.take(lines).pipe(
        Effect.map((line) => /"type":"(\w+)"/.exec(line)?.[1]),
      );
      const capturePage = vi.fn(async () => ({
        toPNG: () => Buffer.from("png"),
        toJPEG: () => Buffer.from("jpeg"),
        getSize: () => ({ width: 100, height: 80 }),
      }));
      fromId.mockReturnValue(
        Object.assign(makeTestPreviewWebContents(capturePage, 42), {
          isDevToolsOpened: () => false,
          getUserAgent: () => "Electron",
        }),
      );
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.createTab("tab_1", { serverTab });
      yield* manager.registerWebview("tab_1", 42);
      expect(yield* nextType).toBe("attached");
      yield* manager.closeTab("tab_1");
      expect(yield* nextType).toBe("detached");
    }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect(
    "asks the client to paint a navigated server tab while the agent captures it",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.DesktopBrowserHost;
        const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
        const contents = Object.assign(
          makeTestPreviewWebContents(async () => {
            throw new Error("unused");
          }, 42),
          {
            isDevToolsOpened: () => false,
            getUserAgent: () => "Electron",
            loadURL: vi.fn(async () => undefined),
          },
        );
        const screenshot = Promise.withResolvers<unknown>();
        contents.debugger.sendCommand = vi.fn((method: string) =>
          method === "Page.captureScreenshot" ? screenshot.promise : Promise.resolve(undefined),
        ) as unknown as typeof contents.debugger.sendCommand;
        fromId.mockReturnValue(contents);
        const manager = yield* PreviewManager.PreviewManager;
        const capturing = yield* Queue.unbounded<boolean>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Queue.offer(capturing, state.capturing).pipe(Effect.asVoid),
        );
        const attached = yield* Deferred.make<void>();
        yield* host.events.pipe(
          Stream.runForEach((line) =>
            new TextDecoder().decode(line).includes('"type":"attached"')
              ? Deferred.succeed(attached, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* manager.createTab("tab_1", { serverTab });
        yield* manager.registerWebview("tab_1", 42);
        yield* Deferred.await(attached);
        // Navigating rebuilds the tab's state, which must keep the server tab it answers for.
        yield* manager.navigate("tab_1", "https://example.com/next");
        yield* Queue.clear(capturing);

        yield* host.handleCommandLine(
          JSON.stringify({
            type: "cdp",
            ...serverTab,
            message: JSON.stringify({
              id: 1,
              method: "Page.captureScreenshot",
              sessionId: "t3-preview-page",
            }),
          }),
        );
        expect(yield* Queue.take(capturing)).toBe(true);
        screenshot.resolve({ data: "" });
        expect(yield* Queue.take(capturing)).toBe(false);
      }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect("discards a screenshot that resolves after its guest is replaced", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image = {
          toPNG: () => Buffer.from("stale-png"),
          toJPEG: () => Buffer.from("stale-jpeg"),
          getSize: () => ({ width: 100, height: 80 }),
        };
        const pending = Promise.withResolvers<typeof image>();
        const capturePage = vi.fn(() => pending.promise);
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const fiber = yield* Effect.exit(manager.captureScreenshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(0);
        expect(capturePage).toHaveBeenCalledOnce();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 43));
        yield* manager.registerWebview("tab_1", 43);
        pending.resolve(image);
        const exit = yield* Fiber.join(fiber);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(capturePage).toHaveBeenCalledOnce();
        expect(writeFile).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("grants each concurrent preview recording its own tab frame", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstJpeg = Buffer.from("first-recording-frame");
        const secondJpeg = Buffer.from("second-recording-frame");
        const firstCapturePage = vi.fn(async () => ({
          toJPEG: () => firstJpeg,
          getSize: () => ({ width: 800, height: 600 }),
        }));
        const secondCapturePage = vi.fn(async () => ({
          toJPEG: () => secondJpeg,
          getSize: () => ({ width: 390, height: 844 }),
        }));
        const firstSendCommand = vi.fn(async () => undefined);
        const secondSendCommand = vi.fn(async () => undefined);
        const host = makeTestHostWebContents();
        const makeWebContents = (
          id: number,
          capturePage: typeof firstCapturePage,
          sendCommand: typeof firstSendCommand,
        ) =>
          ({
            id,
            mainFrame: { routingId: id },
            hostWebContents: host,
            executeJavaScript: vi.fn(async () =>
              id === 41 ? { width: 800, height: 600 } : { width: 390, height: 844 },
            ),
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => `https://example.com/${id}`,
            getTitle: () => `Example ${id}`,
            isLoadingMainFrame: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setAudioMuted: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            isCurrentlyAudible: () => false,
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setIgnoreMenuShortcuts: vi.fn(),
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
            capturePage,
          }) as never;
        const webContentsById = new Map([
          [41, makeWebContents(41, firstCapturePage, firstSendCommand)],
          [42, makeWebContents(42, secondCapturePage, secondSendCommand)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );
        yield* manager.createTab("tab_1");
        yield* manager.createTab("tab_2");
        yield* manager.registerWebview("tab_1", 41);
        yield* manager.registerWebview("tab_2", 42);

        const grants: Array<{ video?: unknown }> = [];
        const takeGrant = () =>
          host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => {
            grants.push(value);
          });

        yield* manager.startRecording("tab_1");
        takeGrant();
        yield* manager.startRecording("tab_2");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 41 } }, { video: { routingId: 42 } }]);

        expect(firstCapturePage).toHaveBeenCalledOnce();
        expect(secondCapturePage).toHaveBeenCalledOnce();
        expect(firstSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );
        expect(secondSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );

        yield* Effect.all([manager.stopRecording("tab_1"), manager.stopRecording("tab_2")], {
          concurrency: 2,
          discard: true,
        });
      }),
    ),
  );

  effectIt.effect("only lets the host frame that armed a recording claim its stream", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        takeGrant({ frameTreeNodeId: 999 });
        takeGrant();

        expect(grants).toEqual([{}, { video: { routingId: 41 } }]);
        yield* manager.stopRecording("tab_race_a");
      }),
    ),
  );

  effectIt.effect("reclaims the arm slot from a destroyed webContents", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant, destroy } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        destroy(41);
        yield* manager.startRecording("tab_race_b");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 42 } }]);

        yield* manager.stopRecording("tab_race_b");
      }),
    ),
  );

  effectIt.effect("gates recording decorations and isolates failed subscribers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const callbacks = new Map<
          string,
          (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined
        >();
        const contents = Object.assign(
          makeTestPreviewWebContents(async () => ({
            toJPEG: () => Buffer.from("frame"),
            getSize: () => ({ width: 800, height: 600 }),
          })),
          {
            ipc: {
              on: (
                channel: string,
                callback: (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined,
              ) => callbacks.set(channel, callback),
              off: vi.fn(),
            },
          },
        );
        fromId.mockReturnValue(contents as never);
        yield* manager.createTab("tab_recording_input");
        yield* manager.registerWebview("tab_recording_input", 42);
        const received: DesktopPreviewRecordingInputEvent[] = [];
        yield* manager.subscribeRecordingInputs(() => Effect.die("renderer unavailable"));
        yield* manager.subscribeRecordingInputs((event) =>
          Effect.sync(() => {
            received.push(event);
          }),
        );
        const send = (input: unknown) =>
          Effect.gen(function* () {
            const fiber = callbacks.get("preview:recording-input")?.(null, input);
            if (fiber) yield* Fiber.join(fiber);
          });
        const key = { type: "key", label: "⌘C", held: true, width: 800 };
        const pointer = {
          type: "pointer",
          phase: "down",
          x: 120,
          y: 80,
          width: 800,
          height: 600,
        };
        yield* send(key);
        expect(received).toEqual([]);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: true,
          showMousePresses: false,
        });
        yield* send(key);
        yield* send(pointer);
        yield* send({ ...key, width: 0 });
        expect(received).toEqual([{ tabId: "tab_recording_input", input: key }]);
        yield* manager.stopRecording("tab_recording_input");
        yield* send(key);
        expect(received).toHaveLength(1);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: false,
          showMousePresses: true,
        });
        yield* send(key);
        yield* send(pointer);
        expect(received.at(-1)).toEqual({ tabId: "tab_recording_input", input: pointer });
        expect(received).toHaveLength(2);
      }),
    ),
  );

  effectIt.effect("continues native recording when the source warmup fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => {
          throw new Error("source is not ready");
        });
        const host = makeTestHostWebContents();
        const webContents = Object.assign(makeTestPreviewWebContents(capturePage, 42, host), {
          executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
        });
        fromId.mockReturnValue(webContents);

        yield* manager.createTab("tab_recording_warmup_failure");
        yield* manager.registerWebview("tab_recording_warmup_failure", 42);

        yield* manager.startRecording("tab_recording_warmup_failure");
        expect(capturePage).toHaveBeenCalledTimes(2);

        const handler = host.displayMediaHandler();
        const streams: Array<{ video?: unknown }> = [];
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        expect(streams).toEqual([{ video: { routingId: 42 } }, {}]);

        yield* manager.stopRecording("tab_recording_warmup_failure");
      }),
    ),
  );

  effectIt.effect("serializes recording source acquisition with webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturedImage = {
          toJPEG: () => Buffer.from("unused-recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        const capturePage = vi
          .fn<() => Promise<TestCapturedPreviewImage>>()
          .mockImplementationOnce(
            () =>
              new Promise<TestCapturedPreviewImage>((resolve) => {
                markWarmupStarted();
                finishWarmup = resolve;
              }),
          )
          .mockResolvedValue(capturedImage);
        const initialWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementOn = vi.fn();
        const replacementWebContents = Object.assign(makeTestPreviewWebContents(capturePage, 43), {
          on: replacementOn,
        });
        fromId.mockImplementation((id) => {
          if (id === 42) return initialWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });

        yield* manager.createTab("tab_recording_replacement_race");
        yield* manager.registerWebview("tab_recording_replacement_race", 42);
        const start = yield* manager
          .startRecording("tab_recording_replacement_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        const replacement = yield* manager
          .registerWebview("tab_recording_replacement_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementOn).not.toHaveBeenCalled();

        finishWarmup(capturedImage);
        yield* Fiber.join(start);
        yield* Fiber.join(replacement);
        expect(replacementOn).toHaveBeenCalled();
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_recording_replacement_race");
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [true],
        ]);
      }),
    ),
  );
});
