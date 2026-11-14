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
  flushMicrotasks,
  makeChangeSignal,
  makeSourcePng,
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
  withManager,
  makeFaviconWebContents,
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


  effectIt.effect.each([
    ["linux", "ctrl+alt+[", "[", "BracketLeft", false],
    ["win32", "ctrl+alt+8", "[", "Digit8", false],
    ["win32", "ctrl+alt+k", "K", "KeyK", false],
    ["linux", "ctrl+alt+`", "Dead", "Backquote", false],
    ["darwin", "ctrl+alt+[", "[", "BracketLeft", true],
    ["linux", "ctrl+alt+f7", "F7", "F7", true],
  ] as const)(
    "handles ambiguous preview chords on %s: %s",
    ([platform, chord, key, code, expected]) =>
      withManager(
        (manager) =>
          Effect.gen(function* () {
            const preview = makeFaviconWebContents();
            const send = vi.fn();
            Object.assign(preview.webContents, {
              hostWebContents: { isDestroyed: () => false, send },
            });
            fromId.mockReturnValue(preview.webContents);
            yield* manager.createTab("tab_alt_graph");
            yield* manager.registerWebview("tab_alt_graph", 42);
            yield* manager.setForwardedShortcuts([
              { command: "view.reopenClosed", shortcut: parseKeybindingShortcut(chord)! },
            ]);
            const preventDefault = vi.fn();
            preview.listeners.get("before-input-event")!(
              { preventDefault } as never,
              {
                type: "keyDown",
                key,
                code,
                meta: false,
                control: true,
                shift: false,
                alt: true,
              } as never,
            );
            expect(preventDefault).toHaveBeenCalledTimes(expected ? 1 : 0);
            expect(send).toHaveBeenCalledTimes(expected ? 1 : 0);
          }),
        platform,
      ),
  );

  effectIt.effect.each([
    ["darwin", true, false, true],
    ["darwin", false, true, false],
    ["linux", false, true, true],
    ["win32", true, false, false],
  ] as const)(
    "reloads the preview only on the platform refresh chord: %s meta=%s ctrl=%s",
    ([platform, meta, control, expected]) =>
      withManager(
        (manager) =>
          Effect.gen(function* () {
            const preview = makeFaviconWebContents();
            fromId.mockReturnValue(preview.webContents);
            yield* manager.createTab("tab_refresh");
            yield* manager.registerWebview("tab_refresh", 42);
            const preventDefault = vi.fn();
            preview.listeners.get("before-input-event")!(
              { preventDefault } as never,
              { type: "keyDown", key: "r", meta, control, shift: false, alt: false } as never,
            );
            expect(preventDefault).toHaveBeenCalledTimes(expected ? 1 : 0);
            expect(preview.reload).toHaveBeenCalledTimes(expected ? 1 : 0);
          }),
        platform,
      ),
  );

  effectIt.effect("keeps editing and forwarded shortcuts in whichever tab holds focus", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const send = vi.fn();
        const focus = vi.fn();
        const host = { isDestroyed: () => false, send, focus };
        const older = makeFaviconWebContents({ id: 42 });
        const newer = makeFaviconWebContents({ id: 43 });
        for (const tab of [older, newer]) Object.assign(tab.webContents, { hostWebContents: host });
        getFocusedWebContents.mockReturnValue(newer.webContents as never);
        fromId.mockReturnValue(older.webContents);
        yield* manager.createTab("tab_older");
        yield* manager.registerWebview("tab_older", 42);
        fromId.mockReturnValue(newer.webContents);
        yield* manager.createTab("tab_newer");
        yield* manager.registerWebview("tab_newer", 43);
        const shortcut = parseKeybindingShortcut("mod+shift+t")!;
        yield* manager.setForwardedShortcuts([{ command: "view.reopenClosed", shortcut }]);

        const beforeInput = older.listeners.get("before-input-event")!;
        const key = { type: "keyDown", meta: true, control: false, alt: false };
        beforeInput(
          { preventDefault: vi.fn() } as never,
          { ...key, key: "v", shift: false } as never,
        );
        expect(
          (older.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(false);

        const preventDefault = vi.fn();
        beforeInput({ preventDefault } as never, { ...key, key: "T", shift: true } as never);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledExactlyOnceWith("desktop:menu-action", "view.reopenClosed");

        yield* manager.setForwardedShortcuts([
          { command: "preview.focusUrl", shortcut: parseKeybindingShortcut("mod+l")! },
        ]);
        beforeInput({ preventDefault } as never, { ...key, key: "l", shift: false } as never);
        expect(focus).toHaveBeenCalledOnce();
        expect(send).toHaveBeenLastCalledWith("desktop:menu-action", "preview.focusUrl");
        expect(focus.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]!);
        beforeInput(
          { preventDefault } as never,
          { ...key, key: "l", shift: false, isAutoRepeat: true } as never,
        );
        expect(focus).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledTimes(2);
        send.mockClear();
        yield* manager.setForwardedShortcuts([{ command: "view.reopenClosed", shortcut }]);

        Object.assign(newer.webContents, { focusedFrame: null });
        const agentInput = newer.listeners.get("before-input-event")!;
        const agentPreventDefault = vi.fn();
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "v", shift: false } as never,
        );
        expect(
          (newer.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(true);
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "T", shift: true } as never,
        );
        expect(agentPreventDefault).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("isolates failed state listeners and continues delivery", () => {
    const loggedErrors: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      for (const value of Array.isArray(message) ? message : [message]) {
        if (typeof value === "object" && value !== null && "cause" in value) {
          loggedErrors.push(Cause.squash(value.cause as Cause.Cause<never>));
        }
      }
    });
    const deliveryError = new ElectronWindow.ElectronWindowOperationError({
      operation: "send-window-message",
      platform: "darwin",
      windowId: 42,
      channel: "preview:state-change",
      cause: new Error("renderer unavailable"),
    });
    const delivered = vi.fn();

    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.subscribeStateChanges(() => Effect.die(deliveryError));
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            delivered(tabId, state);
          }),
        );

        const state = yield* manager.createTab("tab_listener_failure");

        expect(delivered).toHaveBeenCalledOnce();
        expect(delivered).toHaveBeenCalledWith("tab_listener_failure", state);
        expect(loggedErrors).toHaveLength(1);
        expect(loggedErrors[0]).toBeInstanceOf(ElectronWindow.ElectronWindowOperationError);
        expect(loggedErrors[0]).toMatchObject({
          operation: "send-window-message",
          windowId: 42,
          channel: "preview:state-change",
        });
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([logger], {
          mergeWithExisting: false,
        }),
      ),
    );
  });

  effectIt.effect("does not swallow state listener interruption", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* manager.subscribeStateChanges(() => Effect.interrupt);
            return yield* Effect.exit(manager.createTab("tab_interrupted_listener"));
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }),
    ),
  );

  effectIt.effect("queues navigation until the webview registers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(async () => undefined);
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "about:blank",
          getTitle: () => "",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
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
        } as never);

        yield* manager.navigate("tab_pending", "localhost:3200");

        yield* manager.registerWebview("tab_pending", 42);
        yield* Effect.yieldNow;

        expect(loadURL).toHaveBeenCalledOnce();
        expect(loadURL).toHaveBeenCalledWith("http://localhost:3200/");
      }),
    ),
  );

  effectIt.effect("detaches through the pinned debugger after the webview is destroyed", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let destroyed = false;
        let attached = false;
        const debuggerOff = vi.fn();
        const debuggerDetach = vi.fn(() => {
          attached = false;
        });
        const wcDebugger = {
          isAttached: () => attached,
          attach: vi.fn(() => {
            attached = true;
          }),
          detach: debuggerDetach,
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: debuggerOff,
        };
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => destroyed,
          getType: () => "webview",
          getURL: () => "http://localhost:3200/",
          getTitle: () => "Preview",
          isLoadingMainFrame: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          reload: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          get debugger() {
            if (destroyed) throw new Error("Object has been destroyed");
            return wcDebugger;
          },
        } as never);
        yield* manager.createTab("tab_pinned_debugger");
        yield* manager.registerWebview("tab_pinned_debugger", 42);
        yield* manager.setColorScheme("tab_pinned_debugger", "dark");
        expect(attached).toBe(true);
        destroyed = true;

        yield* manager.navigate("tab_pinned_debugger", "https://example.com/");

        expect(debuggerOff).toHaveBeenCalledWith("message", expect.any(Function));
        expect(debuggerDetach).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("does not let destroyed-webview cleanup detach a same-id replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const previous = makeFaviconWebContents();
        const replacement = makeFaviconWebContents({ url: "https://example.com/" });
        let current = previous.webContents;
        let startReplacementRegistration: () => void = () => void 0;
        const replacementReady = new Promise<void>((resolve) => {
          startReplacementRegistration = resolve;
        });
        fromId.mockImplementation(() => current);
        yield* manager.createTab("tab_destroyed_replacement_race");
        yield* manager.registerWebview("tab_destroyed_replacement_race", 42);
        yield* manager.setColorScheme("tab_destroyed_replacement_race", "dark");
        const replacementRegistration = yield* Effect.promise(() => replacementReady).pipe(
          Effect.flatMap(() => manager.registerWebview("tab_destroyed_replacement_race", 42)),
          Effect.forkChild({ startImmediately: true }),
        );
        previous.setDestroyed(true);
        previous.debuggerOff.mockImplementationOnce(() => {
          current = replacement.webContents;
          startReplacementRegistration();
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.navigate("tab_destroyed_replacement_race", "https://example.com/");
        const registrationExit = yield* Fiber.await(replacementRegistration);

        expect(Exit.isSuccess(registrationExit)).toBe(true);
        expect(previous.off).toHaveBeenCalled();
        expect(replacement.off).not.toHaveBeenCalled();
        expect(states.at(-1)).toMatchObject({
          webContentsId: 42,
          navStatus: { kind: "Loading", url: "https://example.com/" },
        });
      }),
    ),
  );

  effectIt.effect("shares an identical in-flight event and lets a changed event win", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFirst!: (response: Response) => void;
        const firstResponse = new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
        const preview = makeFaviconWebContents({
          changes,
          fetch: (url) =>
            url.endsWith("first.png")
              ? firstResponse
              : Promise.resolve(
                  new Response(new Uint8Array(makeSourcePng()), {
                    headers: { "content-type": "image/png" },
                  }),
                ),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_latest");
        yield* manager.registerWebview("tab_favicon_latest", 42);

        const faviconUpdated = preview.listeners.get("page-favicon-updated")!;
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        faviconUpdated({} as never, ["http://localhost:3200/second.png"] as never);
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);
        resolveFirst(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(preview.fetch).toHaveBeenCalledTimes(2);
        expect(states.filter((state) => state.favicon !== undefined)).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("does not publish a capture invalidated by navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const preview = makeFaviconWebContents({
          changes,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_navigation");
        yield* manager.registerWebview("tab_favicon_navigation", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        preview.listeners.get("did-start-navigation")?.({
          isMainFrame: true,
          isSameDocument: false,
        } as never);
        preview.setUrl("https://example.com/");
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.some((state) => state.favicon !== undefined)).toBe(false);
      }),
    ),
  );

  effectIt.effect("ignores an old capture that completes after webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const initial = makeFaviconWebContents({
          changes,
          id: 42,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        const replacement = makeFaviconWebContents({ changes, id: 43 });
        fromId.mockImplementation((id?: number) =>
          id === 42 ? initial.webContents : id === 43 ? replacement.webContents : null,
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_late_replace");
        yield* manager.registerWebview("tab_favicon_late_replace", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => initial.fetch.mock.calls.length === 1);

        yield* manager.registerWebview("tab_favicon_late_replace", 43);
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(
          states.some((state) => state.webContentsId === 43 && state.favicon !== undefined),
        ).toBe(false);
      }),
    ),
  );

  effectIt.effect("treats a reused WebContents id as a new attachment", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        const initial = makeFaviconWebContents({ changes, id: 42 });
        const replacement = makeFaviconWebContents({ changes, id: 42 });
        let active = initial.webContents;
        fromId.mockImplementation(() => active);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_reused_id");
        yield* manager.registerWebview("tab_favicon_reused_id", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);

        active = replacement.webContents;
        yield* manager.registerWebview("tab_favicon_reused_id", 42);

        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(initial.off).toHaveBeenCalled();
        expect(replacement.listeners.has("page-favicon-updated")).toBe(true);
      }),
    ),
  );
});
