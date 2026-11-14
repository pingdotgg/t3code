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
  makeTestPictureInPictureWindow,
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


  effectIt.effect("does not publish picture-in-picture readiness after window teardown", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("closing-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        pictureInPictureWindow.showInactive.mockImplementationOnce(() => {
          pictureInPictureWindow.close();
        });
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_pip_teardown");
        yield* manager.registerWebview("tab_pip_teardown", 42);
        const openExit = yield* Effect.exit(manager.openPictureInPicture("tab_pip_teardown"));

        expect(Exit.hasInterrupts(openExit)).toBe(true);
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.some((state) => state.pictureInPicture)).toBe(false);
        expect(states.at(-1)?.pictureInPicture).toBe(false);
      }),
    ),
  );

  effectIt.effect("closes an initializing picture-in-picture without blocking later opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("serialized-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow: initializingWindow } = makeTestPictureInPictureWindow(
          () => new Promise<void>(() => {}),
        );
        const { pictureInPictureWindow: reopenedWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return initializingWindow;
          })
          .mockImplementationOnce(function () {
            return reopenedWindow;
          });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_concurrent_pip");
        yield* manager.registerWebview("tab_concurrent_pip", 42);

        const firstOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const secondOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const close = yield* manager
          .closePictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(initializingWindow.loadURL).toHaveBeenCalledOnce();
        expect(initializingWindow.close).toHaveBeenCalledOnce();
        const [firstOpenExit, secondOpenExit] = yield* Effect.all([
          Fiber.await(firstOpen),
          Fiber.await(secondOpen),
        ]);
        yield* Fiber.join(close);

        expect(Exit.hasInterrupts(firstOpenExit)).toBe(true);
        expect(Exit.hasInterrupts(secondOpenExit)).toBe(true);
        expect(initializingWindow.showInactive).not.toHaveBeenCalled();
        expect(capturePage).not.toHaveBeenCalled();
        expect(states.at(-1)?.pictureInPicture).toBe(false);

        yield* manager.openPictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.showInactive).toHaveBeenCalledOnce();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(true);

        yield* manager.closePictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("shows picture-in-picture and keeps capturing after stalled captures", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image = {
          toJPEG: () => Buffer.from("preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const stalledInitial = Promise.withResolvers<typeof image>();
        const stalledLoop = Promise.withResolvers<typeof image>();
        const capturePage = vi
          .fn<() => Promise<typeof image>>()
          .mockImplementationOnce(() => stalledInitial.promise)
          .mockImplementationOnce(() => stalledLoop.promise)
          .mockResolvedValue(image);
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        yield* manager.createTab("tab_pip_stalled_capture");
        yield* manager.registerWebview("tab_pip_stalled_capture", 42);

        try {
          const open = yield* manager
            .openPictureInPicture("tab_pip_stalled_capture")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(1_000);
          expect(pictureInPictureWindow.showInactive).toHaveBeenCalledOnce();
          yield* Fiber.join(open);

          expect(send).not.toHaveBeenCalled();
          yield* TestClock.adjust(500);
          expect(send).toHaveBeenCalled();
        } finally {
          // Release stalled native calls after a failing assertion against unchanged base.
          stalledInitial.resolve(image);
          stalledLoop.resolve(image);
        }
      }),
    ),
  );

  effectIt.effect("rejects picture-in-picture when its webview changes during initialization", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initialCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("stale-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const replacementCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("replacement-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const initialWebContents = makeTestPreviewWebContents(initialCapturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(replacementCapturePage, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return initialWebContents;
          if (webContentsId === 43) return replacementWebContents;
          return null;
        });
        let resolveLoad: (() => void) | undefined;
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>((resolve) => {
              resolveLoad = resolve;
            }),
        );
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_replaced_webview");
        yield* manager.registerWebview("tab_replaced_webview", 42);
        const open = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(pictureInPictureWindow.loadURL).toHaveBeenCalledOnce();
        expect(resolveLoad).toBeDefined();
        const concurrentOpen = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        yield* manager.registerWebview("tab_replaced_webview", 43);
        resolveLoad?.();

        const openExits = yield* Effect.all([Fiber.await(open), Fiber.await(concurrentOpen)]);
        for (const openExit of openExits) {
          expect(Exit.isFailure(openExit)).toBe(true);
          if (Exit.isSuccess(openExit)) continue;
          const error = Option.getOrThrow(Cause.findErrorOption(openExit.cause));
          expect(error).toMatchObject({
            _tag: "PreviewOperationError",
            operation: "pictureInPicture.validateWebContents",
            tabId: "tab_replaced_webview",
            webContentsId: 42,
          });
        }
        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.showInactive).not.toHaveBeenCalled();
        expect(initialCapturePage).not.toHaveBeenCalled();
        expect(replacementCapturePage).not.toHaveBeenCalled();
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
          isLoadingMainFrame: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, (...args) => {
              listeners.delete(event);
              listener(...args);
            });
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
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

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        listeners.get("did-start-navigation")?.({
          url: "about:blank",
          isSameDocument: false,
          isMainFrame: false,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        listeners.get("did-start-navigation")?.({
          url: "https://example.com/next",
          isSameDocument: false,
          isMainFrame: true,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    ),
  );

  effectIt.effect("keeps annotation send grants isolated and updates an active pick", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const picked = new Map<number, (event: unknown, ...args: unknown[]) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("annotation"),
          toDataURL: () => "data:image/png;base64,YW5ub3RhdGlvbg==",
          getSize: () => ({ width: 10, height: 10 }),
        }));
        const guests = new Map(
          [42, 43, 44].map(
            (id) =>
              [
                id,
                Object.assign(makeTestPreviewWebContents(capturePage, id), {
                  isFocused: () => true,
                  once: vi.fn(),
                  ipc: {
                    on: vi.fn(
                      (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
                        if (channel === "preview:element-picked") picked.set(id, listener);
                      },
                    ),
                    off: vi.fn(),
                    removeListener: vi.fn(),
                  },
                }),
              ] as const,
          ),
        );
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));
        yield* manager.createTab("tab_a");
        yield* manager.createTab("tab_b");
        yield* manager.registerWebview("tab_a", 42);
        yield* manager.registerWebview("tab_b", 43);
        yield* manager.setAnnotationSendEnabled("tab_a", true);
        const annotation = {
          id: "annotation-scopes",
          pageUrl: "https://example.com",
          pageTitle: "Example",
          comment: "Tighten this spacing",
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: "2026-09-05T00:00:00.000Z",
        };
        for (const [tabId, id, nextGrant, expected] of [
          ["tab_b", 43, undefined, "attach"],
          ["tab_a", 42, false, "attach"],
          ["tab_a", 42, true, "send"],
        ] as const) {
          const pick = yield* manager.pickElement(tabId).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          if (nextGrant !== undefined) {
            yield* manager.setAnnotationSendEnabled(tabId, nextGrant);
          }
          picked.get(id)?.({}, annotation, null, "send");
          const result = yield* Fiber.join(pick);
          expect(result?.annotation.id).toBe(annotation.id);
          expect(result?.submission).toBe(expected);
        }
        yield* manager.registerWebview("tab_a", 44);
        const replacementPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(replacementPick))?.submission).toBe("send");
        yield* manager.closeTab("tab_a");
        yield* manager.createTab("tab_a");
        yield* manager.registerWebview("tab_a", 44);
        const reopenedPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(reopenedPick))?.submission).toBe("attach");
      }),
    ),
  );

  describe("annotation screenshots", () => {
    const captureAnnotation = (
      cropRect: PreviewAnnotationRect | null,
      targets: Partial<Pick<PreviewAnnotationPayload, "elements" | "regions" | "strokes">> = {},
      emptyImage?: "viewport" | "crop",
    ) =>
      withManager((manager) =>
        Effect.gen(function* () {
          let onPicked: ((event: unknown, ...args: unknown[]) => void) | undefined;
          const crop = vi.fn((rect: Electron.Rectangle) => ({
            isEmpty: () => emptyImage === "crop",
            getSize: () =>
              emptyImage === "crop"
                ? { width: 0, height: 0 }
                : { width: rect.width, height: rect.height },
            toDataURL: () => (emptyImage === "crop" ? "data:," : "data:image/png;base64,cropped"),
          }));
          const capturePage = vi.fn(async () => ({
            isEmpty: () => emptyImage === "viewport",
            getSize: () =>
              emptyImage === "viewport" ? { width: 0, height: 0 } : { width: 2000, height: 1200 },
            toJPEG: () => Buffer.from("unused"),
            toDataURL: () => (emptyImage === "viewport" ? "data:," : "data:image/png;base64,full"),
            crop,
          }));
          fromId.mockReturnValue(
            Object.assign(makeTestPreviewWebContents(capturePage), {
              isFocused: () => true,
              once: vi.fn(),
              ipc: {
                on: vi.fn((channel: string, listener: typeof onPicked) => {
                  if (channel === "preview:element-picked") onPicked = listener;
                }),
                off: vi.fn(),
                removeListener: vi.fn(),
              },
            }),
          );

          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);
          const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          onPicked?.(
            {},
            {
              id: "annotation_1",
              pageUrl: "https://example.com",
              pageTitle: "Example",
              comment: "Tighten this spacing",
              elements: [],
              regions: [],
              strokes: [],
              ...targets,
              styleChanges: [],
              screenshot: null,
              createdAt: "2026-06-11T00:00:00.000Z",
            },
            cropRect,
            "attach",
            2,
          );

          const result = yield* Fiber.join(pick);
          expect(capturePage).toHaveBeenCalledExactlyOnceWith();
          expect(result?.annotation.comment).toBe("Tighten this spacing");
          expect(result?.submission).toBe("attach");
          return { result, crop };
        }),
      );

    effectIt.effect("clips a partially visible selection to the captured viewport", () =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(
          { x: -40, y: 570, width: 240, height: 110 },
          { regions: [{ id: "region_1", rect: { x: -20, y: 590, width: 200, height: 70 } }] },
        );
        expect(crop).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 1140, width: 400, height: 60 });
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: 400,
          height: 60,
        });
      }),
    );

    effectIt.effect.each([
      {
        name: "an offscreen crop without individual target bounds",
        cropRect: { x: 1010, y: 40, width: 100, height: 70 },
        regions: [],
      },
      {
        name: "padding overlapping the viewport while its target is offscreen",
        cropRect: { x: 40, y: -100, width: 240, height: 110 },
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
      {
        name: "a union spanning the viewport with both targets offscreen",
        cropRect: { x: -230, y: 40, width: 1460, height: 110 },
        regions: [
          { id: "region_1", rect: { x: -210, y: 60, width: 200, height: 70 } },
          { id: "region_2", rect: { x: 1010, y: 60, width: 200, height: 70 } },
        ],
      },
      {
        name: "an offscreen target when crop bounds are missing",
        cropRect: null,
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
    ])("does not attach $name", ({ cropRect, regions }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, { regions });
        expect(crop).not.toHaveBeenCalled();
        expect(result?.annotation.screenshot).toBeNull();
        expect(result?.screenshotFailed).toBe(true);
      }),
    );

    // regression: #18441 zero-area strokes on the viewport edge must still get a screenshot crop
    effectIt.effect.each([
      {
        name: "zero-width SVG line on the left edge",
        rect: { x: 0, y: 60, width: 0, height: 70 },
        cropRect: { x: -20, y: 40, width: 40, height: 110 },
        expectedCrop: { x: 0, y: 80, width: 40, height: 220 },
      },
      {
        name: "zero-height SVG line on the top edge",
        rect: { x: 60, y: 0, width: 70, height: 0 },
        cropRect: { x: 40, y: -20, width: 110, height: 40 },
        expectedCrop: { x: 80, y: 0, width: 220, height: 40 },
      },
    ])("captures a stroked $name", ({ rect, cropRect, expectedCrop }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, {
          elements: [
            {
              id: "element_1",
              rect,
              element: {
                pageUrl: "https://example.com",
                pageTitle: "Example",
                tagName: "line",
                selector: "svg > line",
                htmlPreview: '<line stroke="black" stroke-width="2" />',
                componentName: null,
                source: null,
                stack: [],
                styles: "stroke: black; stroke-width: 2px;",
                pickedAt: "2026-06-11T00:00:00.000Z",
              },
            },
          ],
        });
        expect(crop).toHaveBeenCalledExactlyOnceWith(expectedCrop);
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: expectedCrop.width,
          height: expectedCrop.height,
        });
      }),
    );
  });

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
});
