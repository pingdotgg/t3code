import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewManager from "./Manager.ts";

const {
  createFromBuffer,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
} = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
  fromId: vi.fn(() => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeImage: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: {
    writeImage,
  },
  nativeImage: {
    createFromBuffer,
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

const browserSessionLayer = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    getSession: () => Effect.die("unexpected getSession"),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

const environmentLayer = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

const fileSystemLayer = FileSystem.layerNoop({
  makeDirectory: (path) =>
    Effect.sync(() => {
      mkdir(path);
    }),
  writeFile: (path, data) =>
    Effect.sync(() => {
      writeFile(path, data);
    }),
});

const layer = PreviewManager.layer.pipe(
  Layer.provideMerge(browserSessionLayer),
  Layer.provideMerge(environmentLayer),
  Layer.provideMerge(fileSystemLayer),
  Layer.provideMerge(Path.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
);
const encodePreviewManagerError = Schema.encodeSync(PreviewManager.PreviewManagerError);

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(layer), Effect.scoped);

describe("PreviewManager", () => {
  beforeEach(() => {
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
    createFromBuffer.mockReset();
    webviewSend.mockClear();
  });

  effectIt.effect("reports an unregistered webview as temporarily unavailable", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });

        yield* manager.createTab("tab_1");

        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });
        expect(fromId).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect(
    "captures automation screenshots through CDP and recovers when capture is unavailable",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const png = Buffer.from("automation-preview-png");
          const image = {
            isEmpty: () => false,
            getSize: () => ({ width: 640, height: 360 }),
            resize: vi.fn(),
            toPNG: () => png,
          };
          createFromBuffer.mockReturnValue(image);
          let attached = false;
          let captureMode: "available" | "failure" | "timeout" = "available";
          const attach = vi.fn(() => {
            attached = true;
          });
          const detach = vi.fn(() => {
            attached = false;
          });
          const focus = vi.fn();
          const restoreFocus = vi.fn();
          const capturePage = vi.fn(async () => image);
          const sendCommand = vi.fn(async (method: string): Promise<unknown> => {
            if (method === "Runtime.evaluate") {
              return {
                result: {
                  value: {
                    url: "https://example.com/",
                    title: "Example",
                    loading: false,
                    visibleText: "Example body",
                    interactiveElements: [],
                  },
                },
              };
            }
            if (method === "Accessibility.getFullAXTree") {
              return { nodes: [] };
            }
            if (method === "Page.captureScreenshot") {
              if (captureMode === "failure") throw new Error("UnknownVizError");
              if (captureMode === "timeout") return await new Promise<never>(() => undefined);
              return { data: png.toString("base64") };
            }
            return undefined;
          });
          fromId.mockReturnValue({
            id: 42,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://example.com/",
            getTitle: () => "Example",
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setWindowOpenHandler: vi.fn(),
            focus,
            capturePage,
            debugger: {
              isAttached: () => attached,
              attach,
              detach,
              sendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
          } as never);
          getFocusedWebContents.mockReturnValue({
            id: 7,
            isDestroyed: () => false,
            focus: restoreFocus,
          } as never);

          yield* manager.createTab("tab_snapshot");
          yield* manager.registerWebview("tab_snapshot", 42);
          yield* Effect.yieldNow;

          const captured = yield* manager.automationSnapshot("tab_snapshot");

          expect(captured).toMatchObject({
            url: "https://example.com/",
            title: "Example",
            visibleText: "Example body",
            accessibilityTree: { nodes: [] },
            screenshot: {
              mimeType: "image/png",
              data: png.toString("base64"),
              width: 640,
              height: 360,
            },
          });
          expect(capturePage).not.toHaveBeenCalled();
          expect(sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          });
          expect(sendCommand).not.toHaveBeenCalledWith("Page.bringToFront", undefined);
          expect(focus).not.toHaveBeenCalled();

          const backgroundCdpCaptured = yield* manager.automationSnapshot("tab_snapshot", true);
          expect(backgroundCdpCaptured.screenshot).toMatchObject({ width: 640, height: 360 });
          expect(sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          });
          expect(sendCommand).toHaveBeenCalledWith("Page.bringToFront", undefined);
          expect(focus).toHaveBeenCalledOnce();
          expect(restoreFocus).toHaveBeenCalledOnce();
          expect(capturePage).not.toHaveBeenCalled();

          captureMode = "failure";
          const backgroundFallbackCaptured = yield* manager.automationSnapshot(
            "tab_snapshot",
            true,
          );
          expect(backgroundFallbackCaptured.screenshot).toMatchObject({ width: 640, height: 360 });
          expect(focus).toHaveBeenCalledTimes(2);
          expect(restoreFocus).toHaveBeenCalledTimes(2);
          expect(capturePage).toHaveBeenCalledOnce();
          expect(capturePage).toHaveBeenCalledWith(undefined, { stayHidden: false });

          capturePage.mockClear();
          const foregroundFallbackCaptured = yield* manager.automationSnapshot("tab_snapshot");
          expect(foregroundFallbackCaptured.screenshot).toMatchObject({
            width: 640,
            height: 360,
          });
          expect(capturePage).toHaveBeenCalledOnce();

          capturePage.mockClear();
          capturePage.mockResolvedValueOnce({ ...image, isEmpty: () => true });
          const degraded = yield* manager.automationSnapshot("tab_snapshot");
          expect(degraded.screenshot).toBeNull();
          expect(capturePage).toHaveBeenCalledOnce();
          expect(detach).not.toHaveBeenCalled();

          capturePage.mockClear();
          captureMode = "timeout";
          const timedOutCapture = yield* manager
            .automationSnapshot("tab_snapshot")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(5_000);
          expect((yield* Fiber.join(timedOutCapture)).screenshot).toMatchObject({
            width: 640,
            height: 360,
          });
          expect(capturePage).toHaveBeenCalledOnce();
          expect(detach).toHaveBeenCalledOnce();

          captureMode = "available";
          const recovered = yield* manager.automationSnapshot("tab_snapshot");
          expect(recovered.screenshot).toMatchObject({ width: 640, height: 360 });
          expect(attach).toHaveBeenCalledTimes(2);
        }),
      ),
  );

  effectIt.effect("bounds debugger initialization and recovers the control session", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let attached = false;
        let firstInitialization = true;
        const attach = vi.fn(() => {
          attached = true;
        });
        const detach = vi.fn(() => {
          attached = false;
        });
        const sendCommand = vi.fn(async (method: string): Promise<unknown> => {
          if (method === "Runtime.enable" && firstInitialization) {
            firstInitialization = false;
            return await new Promise<never>(() => undefined);
          }
          return method === "Runtime.evaluate" ? { result: { value: "recovered" } } : undefined;
        });
        fromId.mockReturnValue({
          id: 43,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com/",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => attached,
            attach,
            detach,
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_timeout");
        yield* manager.registerWebview("tab_timeout", 43);
        yield* Effect.yieldNow;

        const evaluation = yield* manager
          .automationEvaluate("tab_timeout", { expression: "document.title" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(15_000);
        const timedOut = yield* Effect.exit(Fiber.join(evaluation));

        expect(Exit.isFailure(timedOut)).toBe(true);
        if (Exit.isFailure(timedOut)) {
          expect(Option.getOrThrow(Cause.findErrorOption(timedOut.cause))).toMatchObject({
            _tag: "PreviewAutomationTimeoutError",
            tabId: "tab_timeout",
          });
        }
        expect(detach).toHaveBeenCalledOnce();

        expect(
          yield* manager.automationEvaluate("tab_timeout", {
            expression: "document.title",
          }),
        ).toBe("recovered");
        expect(attach).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect("does not let a queued timeout detach the active control session", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let attached = false;
        let stallNextEvaluation = true;
        const attach = vi.fn(() => {
          attached = true;
        });
        const detach = vi.fn(() => {
          attached = false;
        });
        const sendCommand = vi.fn(async (method: string): Promise<unknown> => {
          if (method === "Runtime.evaluate" && stallNextEvaluation) {
            stallNextEvaluation = false;
            return await new Promise<never>(() => undefined);
          }
          return method === "Runtime.evaluate" ? { result: { value: "recovered" } } : undefined;
        });
        fromId.mockReturnValue({
          id: 44,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com/",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => attached,
            attach,
            detach,
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_queued_timeout");
        yield* manager.registerWebview("tab_queued_timeout", 44);
        let latestController: string | undefined;
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            if (tabId === "tab_queued_timeout") latestController = state.controller;
          }),
        );
        const active = yield* manager
          .automationEvaluate("tab_queued_timeout", { expression: "document.title" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        const queued = yield* manager
          .automationWaitFor("tab_queued_timeout", { text: "ready", timeoutMs: 1_000 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        yield* TestClock.adjust(750);
        expect(Exit.isFailure(yield* Effect.exit(Fiber.join(queued)))).toBe(true);
        expect(detach).not.toHaveBeenCalled();
        expect(latestController).toBe("agent");

        yield* TestClock.adjust(14_000);
        expect(Exit.isFailure(yield* Effect.exit(Fiber.join(active)))).toBe(true);
        expect(detach).toHaveBeenCalledOnce();
        expect(latestController).toBe("none");

        expect(
          yield* manager.automationEvaluate("tab_queued_timeout", {
            expression: "document.title",
          }),
        ).toBe("recovered");
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
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
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

        expect(yield* manager.automationStatus("tab_pending")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_pending",
          url: "http://localhost:3200/",
          title: "",
          loading: true,
        });

        yield* manager.registerWebview("tab_pending", 42);
        yield* Effect.yieldNow;

        expect(loadURL).toHaveBeenCalledOnce();
        expect(loadURL).toHaveBeenCalledWith("http://localhost:3200/");
      }),
    ),
  );

  effectIt.effect("mirrors Electron's effective zoom across registration and navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let effectiveZoom = 0.9;
        let zoomReadable = true;
        let url = "https://example.com";
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => {
            if (!zoomReadable) throw new Error("zoom unavailable");
            return effectiveZoom;
          },
          setZoomFactor,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_zoom");
        yield* manager.registerWebview("tab_zoom", 42);

        expect(states.at(-1)?.zoomFactor).toBe(0.9);
        expect(setZoomFactor).not.toHaveBeenCalled();

        effectiveZoom = 1.25;
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.zoomFactor).toBe(1.25);
        expect(setZoomFactor).not.toHaveBeenCalled();

        zoomReadable = false;
        url = "https://example.com/after-zoom-read-failed";
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.navStatus).toEqual({
          kind: "Success",
          url,
          title: "Example",
        });
        expect(states.at(-1)?.zoomFactor).toBe(1.25);

        const replacementSetZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 43,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: replacementSetZoomFactor,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.registerWebview("tab_zoom", 43);

        expect(replacementSetZoomFactor).toHaveBeenCalledWith(1.25);
        expect(states.at(-1)?.zoomFactor).toBe(1.25);
      }),
    ),
  );

  effectIt.effect("emulates prefers-color-scheme and re-applies it across webview swaps", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const makeWebContents = (id: number) => {
          const sendCommand = vi.fn(async () => undefined);
          return {
            sendCommand,
            wc: {
              id,
              isDestroyed: () => false,
              isDevToolsOpened: () => false,
              getType: () => "webview",
              getURL: () => "https://example.com",
              getTitle: () => "Example",
              isLoading: () => false,
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              on: vi.fn(),
              off: vi.fn(),
              ipc: { on: vi.fn(), off: vi.fn() },
              send: webviewSend,
              navigationHistory: { canGoBack: () => false, canGoForward: () => false },
              setWindowOpenHandler: vi.fn(),
              debugger: {
                isAttached: () => false,
                attach: vi.fn(),
                sendCommand,
                on: vi.fn(),
                off: vi.fn(),
              },
            } as never,
          };
        };
        const first = makeWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_scheme");
        yield* manager.registerWebview("tab_scheme", 42);
        yield* Effect.yieldNow;

        yield* manager.setColorScheme("tab_scheme", "dark");

        expect(first.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("dark");

        const replacement = makeWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_scheme", 43);
        yield* Effect.yieldNow;

        expect(replacement.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("dark");

        yield* manager.setColorScheme("tab_scheme", "system");

        expect(replacement.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("system");
      }),
    ),
  );

  effectIt.effect("keeps a main-frame load failure visible until a retry starts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const url = "http://localhost:5733/";
        let loading = false;
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "localhost:5733",
          isLoading: () => loading,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const statuses: PreviewManager.PreviewNavStatus[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            statuses.push(state.navStatus);
          }),
        );
        yield* manager.createTab("tab_failed");
        yield* manager.registerWebview("tab_failed", 42);

        listeners.get("did-fail-load")?.(
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          "https://missing-frame.example/",
          false,
        );
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        listeners.get("did-stop-loading")?.();
        listeners.get("page-title-updated")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)).toEqual({
          kind: "LoadFailed",
          url,
          title: "localhost:5733",
          code: -102,
          description: "ERR_CONNECTION_REFUSED",
        });

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("LoadFailed");

        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");
      }),
    ),
  );

  effectIt.effect("captures a PNG screenshot into browser artifacts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = Buffer.from("preview-png");
        const capturePage = vi.fn(async () => ({ toPNG: () => png }));
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com:8443/path?query=value",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        expect(webviewSend).toHaveBeenCalledWith(
          "preview:annotation-theme",
          expect.objectContaining({
            colorScheme: "light",
            primary: "oklch(0.488 0.217 264)",
          }),
        );

        const artifact = yield* manager.captureScreenshot("tab_1");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(mkdir).toHaveBeenCalledWith("/tmp/t3/dev/browser-artifacts");
        expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
        expect(artifact).toMatchObject({
          tabId: "tab_1",
          mimeType: "image/png",
          sizeBytes: png.byteLength,
        });
        expect(artifact.path).toMatch(
          /\/browser-artifacts\/browser-screenshot-example-com-[^.]+\.png$/,
        );

        const captureCause = new Error("capture failed");
        capturePage.mockRejectedValueOnce(captureCause);
        const exit = yield* Effect.exit(manager.captureScreenshot("tab_1"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "captureScreenshot.capturePage",
          tabId: "tab_1",
          webContentsId: 42,
          cause: captureCause,
        });
      }),
    ),
  );

  effectIt.effect("keeps element picking active during subframe navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        listeners.get("did-start-navigation")?.({}, "about:blank", false, false);
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        listeners.get("did-start-navigation")?.({}, "https://example.com/next", false, true);
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    ),
  );

  effectIt.effect("reveals only files inside the configured browser artifact directory", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.revealArtifact("/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png");

        expect(showItemInFolder).toHaveBeenCalledWith(
          "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png",
        );
        const exit = yield* Effect.exit(manager.revealArtifact("/tmp/t3/dev/settings.json"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("copies screenshot artifacts to the system clipboard", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const artifactPath = "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png";

        yield* manager.copyArtifactToClipboard(artifactPath);

        expect(createFromPath).toHaveBeenCalledWith(artifactPath);
        expect(writeImage).toHaveBeenCalledOnce();
        const exit = yield* Effect.exit(
          manager.copyArtifactToClipboard("/tmp/t3/dev/settings.json"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);

        createFromPath.mockReturnValueOnce({ isEmpty: () => true });
        const invalidImageExit = yield* Effect.exit(manager.copyArtifactToClipboard(artifactPath));
        expect(Exit.isFailure(invalidImageExit)).toBe(true);
        if (Exit.isSuccess(invalidImageExit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(invalidImageExit.cause))).toMatchObject({
          _tag: "PreviewArtifactImageLoadError",
          artifactPath,
        });
      }),
    ),
  );

  effectIt.effect("emits the resolved pointer target before dispatching an automation click", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const activity: string[] = [];
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
            activity.push("mousePressed");
            humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.subscribePointerEvents((event) =>
          Effect.sync(() => {
            activity.push(event.phase);
          }),
        );
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        yield* Fiber.join(click);

        expect(activity).toEqual(["move", "click", "mousePressed"]);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
      }),
    ),
  );

  effectIt.effect("types in background webviews and enables native key input", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let failKeyDown = false;
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (
            failKeyDown &&
            method === "Input.dispatchKeyEvent" &&
            (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
          ) {
            throw new Error("key dispatch failed");
          }
          if (
            method === "Input.dispatchKeyEvent" &&
            (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
          ) {
            humanInput?.(
              {},
              {
                kind: "key",
                key: params["key"],
                code: params["code"] ?? "Digit1",
              },
            );
          }
          return method === "Runtime.evaluate" ? { result: { value: { ok: true } } } : undefined;
        });
        const restoreFocus = vi.fn();
        const focus = vi.fn();
        getFocusedWebContents.mockReturnValue({
          id: 7,
          isDestroyed: () => false,
          focus: restoreFocus,
        } as never);
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          focus,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationType("tab_input", { text: "hello", clear: true });
        yield* manager.automationType("tab_input", { text: "", clear: true });
        yield* manager.automationPress("tab_input", { key: "x" });

        const calls = sendCommand.mock.calls;
        const methods = calls.map(([method]) => method);
        const enableIndex = methods.indexOf("Input.setIgnoreInputEvents");
        const focusOnIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === true,
        );
        const keyDownIndex = calls.findIndex(
          ([method, params]) =>
            method === "Input.dispatchKeyEvent" && params?.["type"] === "keyDown",
        );
        const keyUpIndex = calls.findIndex(
          ([method, params]) => method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
        );
        const focusOffIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === false,
        );
        const typeEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('document.execCommand("insertText"'),
        );
        expect(typeEvaluation).toBeDefined();
        const clearOnlyEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('const text = ""') &&
            params.expression.includes("Object.getOwnPropertyDescriptor"),
        );
        expect(clearOnlyEvaluation).toBeDefined();
        expect(methods).not.toContain("Input.insertText");
        expect(enableIndex).toBeGreaterThanOrEqual(0);
        expect(focus).toHaveBeenCalledOnce();
        expect(restoreFocus).toHaveBeenCalledOnce();
        expect(methods).toContain("Page.bringToFront");
        expect(enableIndex).toBeLessThan(focusOnIndex);
        expect(focusOnIndex).toBeLessThan(keyDownIndex);
        expect(keyDownIndex).toBeLessThan(keyUpIndex);
        expect(keyUpIndex).toBeLessThan(focusOffIndex);
        expect(
          calls.filter(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
          ),
        ).toHaveLength(1);
        expect(sendCommand).toHaveBeenCalledWith("Input.setIgnoreInputEvents", { ignore: false });

        sendCommand.mockClear();
        failKeyDown = true;
        const failedPress = yield* Effect.exit(manager.automationPress("tab_input", { key: "y" }));

        expect(Exit.isFailure(failedPress)).toBe(true);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "y",
          code: "KeyY",
          modifiers: 0,
          windowsVirtualKeyCode: 89,
          location: 0,
          isKeypad: false,
        });
        expect(sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        expect(restoreFocus).toHaveBeenCalledTimes(2);
        expect(
          sendCommand.mock.calls.filter(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
          ),
        ).toHaveLength(1);

        sendCommand.mockClear();
        failKeyDown = false;
        yield* manager.automationPress("tab_input", { key: "!" });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "!",
          code: "Digit1",
          modifiers: 0,
          windowsVirtualKeyCode: 49,
          location: 0,
          isKeypad: false,
          text: "!",
          unmodifiedText: "!",
        });
        expect(restoreFocus).toHaveBeenCalledTimes(3);
      }),
    ),
  );

  effectIt.effect("still interrupts agent control for a different human pointer event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent") {
            humanInput?.({}, { kind: "pointer", x: 400, y: 300, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        const exit = yield* Fiber.await(click);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          operation: "click",
          tabId: "tab_1",
          webContentsId: 42,
        });
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.name).toBe("PreviewAutomationControlInterruptedError");
        }
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("derives evaluation detail kind and length from the same non-empty source", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const text = "ReferenceError: fallbackDetail is not defined";
        const exceptionDetails = {
          text,
          exception: { description: "" },
        };
        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { exceptionDetails } : undefined,
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const exit = yield* Effect.exit(
          manager.automationEvaluate("tab_1", { expression: "fallbackDetail" }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationEvaluationError",
          detailKind: "exception-text",
          detailLength: text.length,
          cause: exceptionDetails,
        });
      }),
    ),
  );
});

describe("PreviewOperationError", () => {
  it("keeps timeline detail separate from its structured message", () => {
    const cause = new Error("CDP command failed with an invalid node id");
    const error = new PreviewManager.PreviewOperationError({
      operation: "click.DOM.resolveNode",
      tabId: "tab_1",
      webContentsId: 42,
      cause,
    });

    expect(error.message).not.toContain(cause.message);
    expect(PreviewManager.PreviewOperationError.toTimelineMessage(error)).toBe(cause.message);
  });
});

describe("Preview automation diagnostics", () => {
  it("keeps browser exception detail out of structural diagnostics", () => {
    const secret = "unrelated-browser-payload-secret";
    const detail = "ReferenceError: missingValue is not defined";
    const cause = {
      text: "Uncaught Error",
      exception: { description: detail },
      unsafePayload: secret,
    };
    const error = new PreviewManager.PreviewAutomationEvaluationError({
      tabId: "tab_1",
      detailKind: "exception-description",
      detailLength: detail.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error.message).toBe("Preview JavaScript evaluation failed in tab tab_1");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(encodedDiagnostics)).not.toContain(secret);
    expect("detail" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).toBe(detail);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).not.toContain(
      secret,
    );
  });

  it("retains bounded selector diagnostics without exposing selector or reason text", () => {
    const selector = "role=button[name='selector-secret']";
    const reason = "Unexpected token near reason-secret";
    const cause = { invalidSelector: true as const, message: reason };
    const error = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: "click",
      tabId: "tab_1",
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error).toMatchObject({
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
    });
    expect(error.detail).toEqual({
      selectorKind: "locator",
      selectorLength: selector.length,
    });
    expect(error.message).not.toContain("secret");
    expect(JSON.stringify(encodedDiagnostics)).not.toContain("secret");
    expect("selector" in error).toBe(false);
    expect("reason" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationInvalidSelectorError.toTimelineMessage(error)).toBe(
      reason,
    );
  });

  it("does not retain a missing target locator", () => {
    const selector = "[data-token='target-secret']";
    const error = new PreviewManager.PreviewAutomationTargetNotFoundError({
      operation: "scroll",
      tabId: "tab_1",
      selectorKind: "selector",
      selectorLength: selector.length,
    });

    expect(error.message).not.toContain(selector);
    expect(JSON.stringify(error)).not.toContain(selector);
    expect("locator" in error).toBe(false);
  });
});
