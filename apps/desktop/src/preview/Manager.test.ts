import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewManager from "./Manager.ts";

const { createFromPath, fromId, mkdir, showItemInFolder, webviewSend, writeFile, writeImage } =
  vi.hoisted(() => ({
    createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
    fromId: vi.fn(() => null),
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
    mkdir.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
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

        yield* manager.subscribePointerEvents((event) => activity.push(event.phase));
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
