import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Playwright download mocks perform real file operations outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import {
  type BrowserRecordingFrameRate,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationLoadError,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      if (contextFailure) throw contextFailure;
      await contextGate?.promise;
      const context = makeContext(this.onClose);
      const setupFailure = pageSetupFailure;
      if (setupFailure) {
        context.newCDPSession = async () => {
          throw setupFailure;
        };
      }
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async scratchPage() {
      return encoderPageOverride ?? (makeEncoderPage() as unknown as Page);
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext(undefined, desktopPageUrl);
      context.page.viewportSize.mockReturnValue(null);
      const browser = { close: vi.fn(async () => {}) };
      desktopConnections.push({ endpoint, context, browser });
      return { browser, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeFrame() {
  const frame = {
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

function makeSession(
  frame: ReturnType<typeof makeFrame> | undefined,
  viewport: { width: number; height: number },
) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, callback: (...args: unknown[]) => void) => events.on(name, callback)),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        if ((input as { format: string }).format === "jpeg" && heldStill) await heldStill();
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      // Snapshots shrink their screenshot in the page; the header stands in for the result.
      if (method === "Runtime.callFunctionOn") return { result: { value: PNG_HEADER } };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId:
            (input as { worldName?: string }).worldName === "t3-preview-viewport"
              ? 9
              : (input as { worldName?: string }).worldName === "t3-preview"
                ? 1
                : 7,
        };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 1) {
        return { result: { value: [] } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      // The recorder drops its last copy on every copy or cut key it sees.
      if (
        method === "Input.dispatchKeyEvent" &&
        ["copy", "cut"].includes((input as { commands?: Array<string> }).commands?.[0] ?? "")
      ) {
        if (focusedFrame) focusedFrame.copy = keyCopy;
        else pageCopy = keyCopy;
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : pageCopy;
        if (frame) frame.copy = "";
        else pageCopy = "";
        return { result: { value } };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 9)
        return desktopSizeAnswer?.() ?? { result: { value: { ...viewport } } };
      return { result: { value: "evaluated" } };
    }),
  };
}

function fileChooserElement(accept: string) {
  return {
    getAttribute: async () => accept,
    evaluate: (probe: (element: { ownerDocument: unknown }) => boolean) =>
      Promise.resolve(
        probe({
          ownerDocument: (globalThis as typeof globalThis & { document?: unknown }).document,
        }),
      ),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void, initialUrl = "about:blank") {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = initialUrl;
  let viewport: ReturnType<Page["viewportSize"]> = { width: 1280, height: 800 };
  const cssViewport = { width: 1920, height: 1080 };
  let closed = false;
  let contextClosed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    nativeFileChooser,
    setChooserFiles,
    openFileChooser: () => {
      if (
        !events.emit("filechooser", {
          isMultiple: () => false,
          element: () => fileChooserElement(".csv"),
          setFiles: setChooserFiles,
        })
      ) {
        nativeFileChooser();
      }
    },
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    commit: (next: string) => {
      url = next;
    },
    title: vi.fn(async () => "test page"),
    viewportSize: vi.fn(() => viewport),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string, _options?: { timeout?: number; waitUntil?: string }) => {
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
      url = next;
      events.emit("load");
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async (_state?: string, _options?: { timeout?: number }) => {}),
    evaluate: vi.fn(async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "delete",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn((): unknown => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => closed,
    // Models Playwright: unload handlers always run, but `beforeunload` only with
    // `runBeforeUnload`, and a guarding page stays open behind a `beforeunload` dialog.
    beforeUnload: "none" as "none" | "listen" | "guard",
    unloadEvents: [] as string[],
    beforeUnloadDialog: null as null | {
      accept: ReturnType<typeof vi.fn>;
      dismiss: ReturnType<typeof vi.fn>;
    },
    // Set to hold the page open after `beforeunload` until resolved, as Playwright's
    // `runBeforeUnload` close resolves before the page actually closes.
    unloadGate: null as PromiseWithResolvers<void> | null,
    removed: false,
    pagehideBinding: null as (() => void) | null,
    pagehideWatched: Promise.withResolvers<void>(),
    exposeFunction: vi.fn(async (_name: string, callback: () => void) => {
      page.pagehideBinding = callback;
      page.pagehideWatched.resolve();
    }),
    close: vi.fn(async (options?: { runBeforeUnload?: boolean }) => {
      if (closed) return;
      const finish = () => {
        if (closed || page.removed) return;
        page.unloadEvents.push("pagehide");
        page.pagehideBinding?.();
        page.unloadEvents.push("visibilitychange");
        closed = true;
        events.emit("close");
      };
      if (!options?.runBeforeUnload || page.beforeUnload === "none") return finish();
      page.unloadEvents.push("beforeunload");
      if (page.beforeUnload === "listen" && page.unloadGate) {
        void page.unloadGate.promise.then(finish);
        return;
      }
      if (page.beforeUnload === "listen") return finish();
      const dialog = {
        type: () => "beforeunload",
        message: () => "",
        defaultValue: () => "",
        accept: vi.fn(async () => finish()),
        dismiss: vi.fn(async () => {}),
      };
      page.beforeUnloadDialog = dialog;
      events.emit("dialog", dialog);
    }),
  };
  const context = {
    page,
    sessions,
    cssViewport,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (target: unknown) => {
      const session = makeSession(
        target === page ? undefined : (target as ReturnType<typeof makeFrame>),
        cssViewport,
      );
      sessions.push(session);
      return session;
    },
    closing: Promise.withResolvers<void>(),
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      context.closing.resolve();
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

// Runs the real encoder script against fake canvas and MediaRecorder globals.
function makeEncoderPage() {
  let paintedFrame = "";
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage(bitmap: { pixels: string }) {
        paintedFrame = bitmap.pixels;
      },
      fillRect() {},
    }),
    captureStream: (frameRate?: number) => ({
      frameRate,
      getTracks: () => [],
      getVideoTracks: () => [{ requestFrame() {} }],
    }),
  };
  const video = {
    play: async () => {},
    pause() {},
    requestVideoFrameCallback: (callback: () => void) => queueMicrotask(callback),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    mimeType = "video/webm";
    state = "inactive";
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    readonly stream: { frameRate?: number };
    constructor(stream: { frameRate?: number }, options: { videoBitsPerSecond: number }) {
      this.stream = stream;
      encoderStreams.push({
        frameRate: stream.frameRate,
        bitsPerSecond: options.videoBitsPerSecond,
      });
    }
    start() {
      this.state = "recording";
      this.onstart?.();
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([paintedFrame]) });
      this.onstop?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: (tag: string) => (tag === "video" ? video : canvas) },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: async (blob: Blob) => {
      await decodeGate?.promise;
      return { width: 1280, height: 800, pixels: await blob.text(), close() {} };
    },
    atob,
    btoa,
    Blob,
    performance,
  };
  sandbox.window = sandbox;
  const context = NodeVM.createContext(sandbox);
  return {
    ...makeContext().page,
    evaluate: vi.fn(async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
      typeof script === "string"
        ? NodeVM.runInContext(script, context)
        : NodeVM.runInContext(`(${script.toString()})`, context)(arg),
    ),
  };
}

const contexts: ReturnType<typeof makeContext>[] = [];
let encoderPageOverride: Page | undefined;
const encoderStreams: Array<{ frameRate: number | undefined; bitsPerSecond: number }> = [];
let decodeGate: PromiseWithResolvers<void> | null = null;
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let heldStill: (() => Promise<void>) | null = null;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextFailure: Error | null = null;
let pageSetupFailure: Error | null = null;
let initialNavigation: (() => Promise<void>) | null = null;
let desktopRendersNext = false;
let desktopPageUrl = "about:blank";
/** Replaces the answer to the desktop page's size reads. */
let desktopSizeAnswer: (() => Promise<Record<string, unknown>>) | null = null;
const desktopDetaches = new NodeEvents.EventEmitter();
let desktopDetachReady = Promise.withResolvers<void>();
let desktopReleased = Promise.withResolvers<void>();
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
/** When set, a desktop that has not attached a tab waits for it the way the real channel does. */
let desktopAttachesLate = false;
let desktopAttachWaiting = Promise.withResolvers<void>();
const shownDesktopTabs = new Set<string>();
const releasedDesktopTabs: Array<string> = [];
const desktopLoadFailures = new Map<string, PreviewAutomationLoadError>();
const desktopTurns = new NodeEvents.EventEmitter();
const desktopConnections: Array<{
  endpoint: string;
  context: ReturnType<typeof makeContext>;
  browser: { close: ReturnType<typeof vi.fn> };
}> = [];
const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});
const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.die("mock Chromium does not need an executable"),
    installed: Effect.die("mock Chromium does not need an executable"),
  }),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    available: true,
    awaitAttached: (key, timeout) =>
      !desktopAttachesLate || desktopRenders(key.tabId)
        ? Effect.sync(() => desktopRenders(key.tabId))
        : Effect.raceFirst(
            Stream.callback<string>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const onAttach = (attached: { tabId: string }) =>
                    Queue.offerUnsafe(queue, attached.tabId);
                  desktopDetaches.on("attach", onAttach);
                  return onAttach;
                }),
                (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
              ),
            ).pipe(
              Stream.filter((tabId) => tabId === key.tabId),
              Stream.runHead,
              Effect.as(true),
            ),
            Effect.sync(() => desktopAttachWaiting.resolve()).pipe(
              Effect.andThen(Effect.sleep(timeout)),
              Effect.as(false),
            ),
          ),
    detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onDetach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("detach", onDetach);
          desktopDetachReady.resolve();
          return onDetach;
        }),
        (onDetach) => Effect.sync(() => desktopDetaches.off("detach", onDetach)),
      ),
    ),
    attached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onAttach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("attach", onAttach);
          return onAttach;
        }),
        (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
      ),
    ),
    isAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    isShown: (key) => shownDesktopTabs.has(key.tabId),
    loadFailure: (key) => desktopLoadFailures.get(key.tabId),
    endpoint: (key) =>
      Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
        Effect.sync(() => {
          releasedDesktopTabs.push(key.tabId);
          desktopDetaches.emit("release", key.tabId);
          desktopReleased.resolve();
        }),
      ),
    pointer: () => Effect.void,
    turn: (threadId, active) => Effect.sync(() => desktopTurns.emit("turn", threadId, active)),
  }),
  PreviewAgentActivity.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-browser-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  return { browser, broker, tabId };
});
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});
/** Fills a viewer's output with frames; resolves once every one of them is acknowledged. */
const stallViewer = (viewer: ServerBrowser.ServerBrowserViewer) => {
  const output = viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
  const acked = Promise.withResolvers<void>();
  let unacked = 0;
  const ack = Effect.sync(() => {
    if (--unacked === 0) acked.resolve();
  });
  while (Queue.offerUnsafe(output, { _tag: "frame", data: Buffer.alloc(0), ack })) unacked++;
  return Effect.promise(() => acked.promise);
};
const viewportSizes = (items: ReadonlyArray<ServerBrowser.ServerBrowserViewerOutput>) =>
  items.flatMap((item) => (item._tag === "viewport" ? [`${item.width}x${item.height}`] : []));
const openDesktopViewer = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const manager = yield* Manager.PreviewManager;
  desktopRendersNext = true;
  const { tabId } = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
  const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
  const context = desktopConnections[0]!.context;
  const cdp = context.sessions[0]!;
  const resize = (width: number, height: number) => {
    Object.assign(context.cssViewport, { width, height });
    return Effect.promise(() => cdp.emitAsync("Page.frameResized"));
  };
  return { tabId, viewer, context, cdp, resize };
});

beforeEach(() => {
  contexts.length = 0;
  encoderPageOverride = undefined;
  encoderStreams.length = 0;
  decodeGate = null;
  contextRequests.length = 0;
  contextGate = null;
  heldStill = null;
  contextFailure = null;
  pageSetupFailure = null;
  initialNavigation = null;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  desktopTabs.clear();
  shownDesktopTabs.clear();
  desktopLoadFailures.clear();
  desktopRendersNext = false;
  desktopAttachesLate = false;
  desktopAttachWaiting = Promise.withResolvers<void>();
  desktopPageUrl = "about:blank";
  desktopSizeAnswer = null;
  desktopDetachReady = Promise.withResolvers<void>();
  desktopReleased = Promise.withResolvers<void>();
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
});

it.effect("tells the desktop once per thread when its agent turns start and end", () =>
  Effect.gen(function* () {
    yield* ServerBrowser.ServerBrowser;
    const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
    const threadId = scope.thread.threadId;
    const turns = yield* Queue.unbounded<readonly [string, boolean]>();
    const record = (id: string, active: boolean) => Queue.offerUnsafe(turns, [id, active]);
    desktopTurns.on("turn", record);
    yield* Effect.addFinalizer(() => Effect.sync(() => desktopTurns.off("turn", record)));
    const endFirst = yield* activity.begin(threadId);
    // An overlapping turn on the same thread neither starts nor ends focus on its own.
    const endSecond = yield* activity.begin(threadId);
    expect(yield* Queue.take(turns)).toEqual([threadId, true]);
    yield* endFirst;
    yield* endFirst;
    expect(yield* activity.active(threadId)).toBe(true);
    yield* endSecond;
    expect(yield* Queue.take(turns)).toEqual([threadId, false]);
    expect(yield* Queue.size(turns)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("preview_open reports its navigation timeout instead of the request budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      initialNavigation = async () => {
        throw Object.assign(new Error("page.goto: Timeout 15000ms exceeded."), {
          name: "TimeoutError",
        });
      };

      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: {
            url: "http://localhost:1337/",
            reuseExistingTab: false,
            show: false,
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
        timeoutMs: 15_000,
      });
      expect(error.message).toBe("Preview automation open timed out after 15000ms.");
      // The failed open returned no tabId, so its tab must not linger and block later opens.
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId)).toEqual([tabId]);
      expect(contexts[1]!.page.close).toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "an initial download stays available after preview_open reports the navigation error",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const released = Promise.withResolvers<void>();
        initialNavigation = async () => {
          contexts[1]!.page.emit("download", {
            failure: async () => null,
            delete: async () => released.resolve(),
            saveAs: (path: string) => NodeFSP.writeFile(path, "a,b"),
            suggestedFilename: () => "report.csv",
            url: () => "http://localhost:1337/report.csv",
          });
          throw new Error("page.goto: Download is starting");
        };
        const error = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: {
              url: "http://localhost:1337/report.csv",
              reuseExistingTab: false,
              open: false,
            },
          })
          .pipe(Effect.flip);
        expect(error.message).toContain("Download is starting");
        yield* Effect.promise(() => released.promise);
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        expect(sessions).toHaveLength(2);
        const downloadTabId = PreviewTabId.make(sessions.find((tab) => tab.tabId !== tabId)!.tabId);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId: downloadTabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([
          expect.objectContaining({ fileName: "report.csv", sizeBytes: 3 }),
        ]);
        expect(
          yield* (yield* FileSystem.FileSystem).readFileString(status.downloads![0]!.path),
        ).toBe("a,b");
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect.each([
  { renderer: "idle", title: "Heavy page" },
  { renderer: "busy", title: null },
])(
  "navigate returns the committed page while its load event is still pending ($renderer renderer)",
  ({ renderer, title }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const titleRequested = Promise.withResolvers<void>();
        // A busy main thread never answers title(); drive its native deadline explicitly.
        page.title.mockImplementation(() => {
          titleRequested.resolve();
          return renderer === "busy"
            ? new Promise<string>(() => {})
            : Promise.resolve("Heavy page");
        });
        const heavy = "http://localhost:5173/heavy";
        const timedOut = (method: string, timeout: number | undefined) =>
          Object.assign(new Error(`${method}: Timeout ${timeout}ms exceeded.`), {
            name: "TimeoutError",
          });
        // The document commits and parses, but a stalled subresource holds back `load`.
        page.goto.mockImplementation(async (next, options) => {
          page.commit(next);
          page.emit("request", {
            url: () => next,
            isNavigationRequest: () => true,
            frame: () => page,
          });
          if (options?.waitUntil === "load") throw timedOut("page.goto", options.timeout);
        });
        page.waitForLoadState.mockImplementation(async (state, options) => {
          if (state === undefined || state === "load") {
            throw timedOut("page.waitForLoadState", options?.timeout);
          }
        });

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const result = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "navigate",
            input: { url: heavy, timeoutMs: 4_000 },
          })
          .pipe(Effect.forkScoped);
        const titleRead = yield* Effect.raceFirst(
          Effect.promise(() => titleRequested.promise).pipe(Effect.as(true)),
          Fiber.await(result).pipe(Effect.as(false)),
        );
        if (titleRead && renderer === "busy") {
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(250));
        }
        const status = yield* Fiber.join(result);

        expect(status).toMatchObject({ url: heavy, title, loading: true });
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())), Effect.provide(layer)),
);

it.effect("a desktop status answers with the last viewport while the renderer cannot measure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      desktopRendersNext = true;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: "https://example.com/", reuseExistingTab: false, show: false },
      });
      const measuring = Promise.withResolvers<void>();
      desktopSizeAnswer = () => {
        measuring.resolve();
        return new Promise(() => {});
      };
      // A resize makes the next status measure again.
      yield* Effect.promise(() =>
        desktopConnections[0]!.context.sessions[0]!.emitAsync("Page.frameResized"),
      );

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId: opened.tabId!,
          operation: "status",
          input: {},
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => measuring.promise);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(250));
      const status = yield* Fiber.join(result);

      expect(status.viewport).toEqual({ width: 1920, height: 1080 });
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())), Effect.provide(layer)),
);

it.effect.each([
  { name: "an agent navigate", message: null },
  { name: "a viewer navigate", message: { type: "navigate", url: "http://localhost:5173/next" } },
  { name: "a viewer Back", message: { type: "history", delta: -1 } },
  { name: "a viewer Forward", message: { type: "history", delta: 1 } },
  { name: "a viewer Reload", message: { type: "reload" } },
  { name: "a viewer hard reload", message: { type: "reload", ignoreCache: true } },
])("$name stops a page script that never yields before it navigates", ({ message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const viewer = message ? yield* browser.attachViewer(viewerInput(tabId, true)) : null;
      if (viewer) yield* viewer.input({ type: "takeControl" });
      const { page, sessions } = contexts[0]!;
      // As in Chrome: the hung renderer answers nothing, and a terminate reaches it only while
      // no navigation is pending.
      let stopped = false;
      const probed = Promise.withResolvers<void>();
      const navigatedAfterStop: Array<boolean> = [];
      for (const cdp of sessions) {
        const send = cdp.send.getMockImplementation()!;
        cdp.send.mockImplementation((method, input) => {
          if (
            method === "Runtime.evaluate" &&
            (input as { expression: string }).expression === "0"
          ) {
            probed.resolve();
            return new Promise(() => {});
          }
          if (method === "Runtime.terminateExecution") stopped = true;
          if (method === "Page.reload") navigatedAfterStop.push(stopped);
          return send(method, input);
        });
      }
      const goto = page.goto.getMockImplementation()!;
      page.goto.mockImplementation(async (next, options) => {
        navigatedAfterStop.push(stopped);
        return goto(next, options);
      });
      for (const method of ["goBack", "goForward", "reload"] as const) {
        page[method].mockImplementation(async () => {
          navigatedAfterStop.push(stopped);
        });
      }

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = yield* (
        viewer
          ? viewer.input(message)
          : broker.invoke<PreviewAutomationStatus>({
              scope,
              tabId,
              operation: "navigate",
              input: { url: "http://localhost:5173/next", timeoutMs: 5_000 },
            })
      ).pipe(Effect.forkScoped);
      const probing = yield* Effect.raceFirst(
        Effect.promise(() => probed.promise).pipe(Effect.as(true)),
        Fiber.await(result).pipe(Effect.as(false)),
      );
      if (probing) yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_000));
      yield* Fiber.join(result);

      expect(navigatedAfterStop).toEqual([true]);
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())), Effect.provide(layer)),
);

it.live("navigate fails when the page never commits within its timeout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      contexts[0]!.page.goto.mockImplementation(async () => {
        throw Object.assign(new Error("page.goto: Timeout 4000ms exceeded."), {
          name: "TimeoutError",
        });
      });

      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://10.255.255.1/", timeoutMs: 4_000 },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "PreviewAutomationTimeoutError", timeoutMs: 4_000 });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each(["desktop" as const, undefined])(
  "explicit desktop targets ($0 runtime) fail without creating a server tab",
  (runtime) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const desktop = yield* manager.open({
          threadId: scope.thread.threadId,
          url: "https://example.com/original",
          ...(runtime === undefined ? {} : { runtime }),
        });
        const before = yield* manager.list({ threadId: scope.thread.threadId });
        const error = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(desktop.tabId),
            operation: "open",
            input: { url: "https://example.com/replacement", open: true },
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
        expect(error.message).toContain("desktop runtime");
        expect(error.message).toContain("cannot control");
        expect(yield* manager.list({ threadId: scope.thread.threadId })).toEqual(before);
        expect(contexts).toHaveLength(1);
        const reused = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { open: false },
        });
        expect(reused.tabId).toBe(tabId);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a tab the desktop does not draw is marked headless, so the desktop streams it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      desktopRendersNext = true;
      const desktopTab = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      const headlessOf = (id: string | null) =>
        sessions.find((session) => session.tabId === id)?.headless;

      expect(headlessOf(tabId)).toBe(true);
      expect(headlessOf(desktopTab.tabId)).toBeUndefined();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a server started without the desktop browser channel marks its tabs headless", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });

      expect(sessions.find((session) => session.tabId === tabId)?.headless).toBe(true);
    }),
  ).pipe(
    // A WSL-only desktop starts its backend without the browser fds.
    Effect.provide(
      ServerBrowser.layer.pipe(
        Layer.provide(DesktopChannel.layer),
        Layer.provideMerge(dependencies),
      ),
    ),
  ),
);

it.effect("an agent's tab the reloaded desktop dropped goes back to the desktop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const threadId = scope.thread.threadId;
      desktopRendersNext = true;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: "https://example.com/?t=1", reuseExistingTab: false, open: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      // The renderer reloads on another thread: its webview goes, and it only mounts this
      // thread's tabs again once a preview event for the thread reaches it.
      yield* Effect.promise(() => desktopDetachReady.promise);
      desktopAttachesLate = true;
      desktopTabs.delete(tabId);
      desktopDetaches.emit("detach", { threadId, tabId });
      yield* Effect.promise(() => desktopReleased.promise);
      // It is still reloading when the agent's call arrives, so it misses the first event.
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => desktopAttachWaiting.promise);
        const events = yield* manager.subscribeEvents;
        const nextForThread = Effect.gen(function* () {
          let event = yield* PubSub.take(events);
          while (event.threadId !== threadId) event = yield* PubSub.take(events);
        });
        yield* nextForThread;
        yield* nextForThread;
        desktopTabs.add(tabId);
        desktopDetaches.emit("attach", { threadId, tabId });
      }).pipe(Effect.forkScoped);

      const evaluating = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "navigator.userAgent" },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.raceFirst(
        Fiber.join(evaluating),
        Effect.promise(() => desktopAttachWaiting.promise).pipe(
          Effect.andThen(TestClock.adjust("10 seconds")),
          Effect.andThen(Fiber.join(evaluating)),
        ),
      );
      const { sessions } = yield* manager.list({ threadId });

      expect(sessions.find((session) => session.tabId === tabId)?.headless).toBeUndefined();
      expect(desktopConnections).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

// Playwright emulates a light color scheme on every page it attaches to.
it.effect("a desktop tab left on the system appearance clears Playwright's light emulation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { context } = yield* openDesktopViewer;

      expect(context.page.emulateMedia).toHaveBeenCalledWith({ colorScheme: null });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a desktop page that loaded before the server attached reports its loaded title", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      desktopRendersNext = true;
      desktopPageUrl = "https://example.com/loaded";
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: desktopPageUrl, reuseExistingTab: false, show: false },
      });
      let event = yield* PubSub.take(events);
      while (event.type !== "navigated" || event.tabId !== opened.tabId) {
        event = yield* PubSub.take(events);
      }

      expect(event.snapshot.navStatus).toEqual({
        _tag: "Success",
        url: "https://example.com/loaded",
        title: "test page",
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each(["none", "during", "after-fragment", "same-url"])(
  "Stop settles an initial navigation with its request event $0",
  (requestTiming) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const events = yield* manager.subscribeEvents;
        const started = Promise.withResolvers<void>();
        const committed = Promise.withResolvers<void>();
        initialNavigation = () => {
          started.resolve();
          return committed.promise;
        };
        yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
        const { tabId } = yield* manager.open({
          threadId: scope.thread.threadId,
          runtime: "server",
          url:
            requestTiming === "after-fragment"
              ? "https://example.com/pending#section"
              : "https://example.com/pending",
        });
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* Effect.promise(() => started.promise);
        const page = contexts.at(-1)!.page;
        const request = {
          url: () => "https://example.com/pending",
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => page,
          failure: () => ({ errorText: "net::ERR_ABORTED" }),
        };
        const cdp = contexts.at(-1)!.sessions.at(-1)!;
        const send = cdp.send.getMockImplementation()!;
        cdp.send.mockImplementation(async (operation, input) => {
          if (operation === "Page.stopLoading") {
            committed.reject(new Error("net::ERR_ABORTED"));
            if (requestTiming === "during") page.emit("request", request);
          }
          return send(operation, input);
        });
        yield* viewer.input({ type: "stopLoading" });
        const stopped = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(stopped.loading).toBe(false);
        let settled = yield* PubSub.take(events);
        while (
          settled.type !== "navigated" ||
          settled.tabId !== tabId ||
          settled.snapshot.navStatus._tag !== "Idle"
        ) {
          settled = yield* PubSub.take(events);
        }
        const corrected = requestTiming === "same-url";
        using timeout = vi.spyOn(globalThis, "setTimeout");
        if (corrected) {
          page.goto.mockImplementationOnce(async () => {
            page.emit("request", request);
          });
          yield* viewer.input({ type: "navigate", url: request.url() });
        } else if (requestTiming !== "none") {
          if (requestTiming === "after-fragment") page.emit("request", request);
          page.emit("requestfailed", request);
        }
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.loading).toBe(corrected);
        expect(timeout).not.toHaveBeenCalledWith(expect.any(Function), 5_000);
        if (!corrected) {
          const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
          expect(sessions.find((session) => session.tabId === tabId)?.navStatus).toEqual({
            _tag: "Idle",
          });
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect.each([
  {
    method: "goto" as const,
    message: { type: "navigate", url: "http://10.255.255.1/" },
    abortEvent: "before",
  },
  { method: "goBack" as const, message: { type: "history", delta: -1 }, abortEvent: "before" },
  { method: "goForward" as const, message: { type: "history", delta: 1 }, abortEvent: "before" },
  { method: "reload" as const, message: { type: "reload" }, abortEvent: "after" },
  { method: "reload" as const, message: { type: "reload" }, abortEvent: "none" },
  ...["before", "after", "none"].map((abortEvent) => ({
    method: "goto" as const,
    message: { type: "navigate", url: "http://10.255.255.1/" },
    abortEvent,
    blank: true,
  })),
])("viewer $method Stop settles ($abortEvent, blank=$blank)", (testCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { method, message, abortEvent } = testCase;
      const blank = "blank" in testCase;
      const { browser, broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const started = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const page = contexts[0]!.page;
      page[method].mockImplementationOnce(() => {
        started.resolve();
        return committed.promise;
      });
      const navigation = yield* viewer.input(message).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      const cdp = contexts[0]!.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      const request = {
        url: () => "https://example.com/pending",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      const typed = Promise.withResolvers<void>();
      let cancelled = false;
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") typed.resolve();
        if (operation === "Page.stopLoading") {
          cancelled = true;
          committed.reject(new Error("net::ERR_ABORTED"));
          if (abortEvent === "before") page.emit("requestfailed", request);
        }
        return send(operation, input);
      });
      const correction = yield* Effect.gen(function* () {
        if (!blank) yield* viewer.input({ type: "navigate", url: "http://localhost:5173/fixed" });
        yield* viewer.input({ type: "text", text: "hello" });
      }).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      // The text reaches the page while the first navigation is still uncommitted.
      yield* Effect.promise(() => typed.promise);
      expect(page.goto).toHaveBeenLastCalledWith(
        blank ? "http://10.255.255.1/" : "http://localhost:5173/fixed",
        expect.objectContaining({ waitUntil: "commit" }),
      );
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "hello",
      });
      page.emit("request", request);
      let loadingEvent = yield* PubSub.take(events);
      while (
        loadingEvent.type !== "navigated" ||
        loadingEvent.snapshot.navStatus._tag !== "Loading"
      ) {
        loadingEvent = yield* PubSub.take(events);
      }
      const reader = yield* browser.attachViewer(viewerInput(tabId, false));
      yield* reader.input({ type: "stopLoading" });
      expect(cancelled).toBe(false);
      if (abortEvent === "none" && !blank) committed.resolve();
      yield* viewer.input({ type: "stopLoading" });
      expect(cancelled).toBe(true);
      using timeout = vi.spyOn(globalThis, "setTimeout");
      if (abortEvent === "after") page.emit("requestfailed", request);
      expect(timeout).not.toHaveBeenCalledWith(expect.any(Function), 5_000);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.loading).toBe(false);
      const expectedStatus = blank ? "Idle" : "Success";
      let settled = yield* PubSub.take(events);
      while (settled.type !== "navigated" || settled.snapshot.navStatus._tag !== expectedStatus) {
        settled = yield* PubSub.take(events);
      }
      if (blank) {
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        expect(sessions.find((session) => session.tabId === tabId)?.navStatus).toEqual({
          _tag: "Idle",
        });
      }
      if (settled.snapshot.navStatus._tag === "Success")
        expect(settled.snapshot.navStatus.url).toBe("http://localhost:5173/fixed");
      expect(page[method]).toHaveBeenCalledTimes(method === "goto" && !blank ? 2 : 1);
      yield* viewer.input({ type: "releaseControl" });
      yield* Fiber.join(navigation);
      yield* Fiber.join(correction);
    }),
  ).pipe(Effect.provide(layer)),
);

// The fake encoder decodes every frame at 1280x800, so 30 fps hits the bitrate floor.
it.effect.each([
  { reports: [], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [30], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [60], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, undefined], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, 30], frameRate: 30, bitsPerSecond: 2.5e6 },
] satisfies ReadonlyArray<{
  reports: ReadonlyArray<BrowserRecordingFrameRate | undefined>;
  frameRate: number;
  bitsPerSecond: number;
}>)(
  "agent recordings encode at the last reported frame rate ($reports)",
  ({ reports, frameRate, bitsPerSecond }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const reportProfiles = yield* browser.profileReporter;
        for (const recordingFrameRate of reports) {
          yield* reportProfiles({
            profiles: [],
            defaultProfileId: "default",
            ...(recordingFrameRate === undefined ? {} : { recordingFrameRate }),
          });
        }
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        expect(encoderStreams).toEqual([{ frameRate, bitsPerSecond }]);
      }),
    ).pipe(Effect.provide(layer)),
);

// Chrome stops sending screencast frames while too many are unacked.
it.effect("recordings ack screencast frames without waiting for the encoder to decode them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
      const session = contexts[0]!.sessions.find((candidate) =>
        candidate.send.mock.calls.some(([method]) => method === "Page.startScreencast"),
      )!;
      const gate = Promise.withResolvers<void>();
      decodeGate = gate;
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));
      for (const sessionId of [1, 2, 3]) {
        session.emit("Page.screencastFrame", {
          data: Buffer.from(`frame ${sessionId}`).toString("base64"),
          sessionId,
          metadata: { deviceWidth: 1280 },
        });
      }
      expect(
        session.send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck"),
      ).toHaveLength(3);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([{ truncated: false }, { truncated: true }])(
  "saves a large recording as a binary download and removes its staged file (truncated: $truncated)",
  ({ truncated }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        const bytes = 8 * 1024 * 1024;
        const payload = Buffer.alloc(bytes, 0x5a);
        let stagedPath: string | undefined;
        const download = Promise.withResolvers<{ saveAs: (path: string) => Promise<void> }>();
        const sandbox = NodeVM.createContext({
          __t3Recorder: {
            frame: async () => true,
            stop: async () => ({ mimeType: "video/webm", count: 1, bytes }),
            chunk: async () => {
              throw new Error("Large recording used Base64 export");
            },
            download: () =>
              download.resolve({
                saveAs: async (path) => {
                  stagedPath = path;
                  await NodeFSP.writeFile(path, truncated ? payload.subarray(1) : payload);
                },
              }),
          },
        });
        encoderPageOverride = {
          ...makeContext().page,
          evaluate: async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
            typeof script === "function"
              ? NodeVM.runInContext(`(${script.toString()})`, sandbox)(arg)
              : undefined,
          waitForEvent: () => download.promise,
        } as unknown as Page;

        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        const stop = broker.invoke<{ path: string; sizeBytes: number }>({
          scope,
          tabId,
          operation: "recordingStop",
          input: {},
        });
        if (truncated) {
          expect(yield* stop.pipe(Effect.flip)).toMatchObject({
            _tag: "PreviewAutomationExecutionError",
          });
        } else {
          const artifact = yield* stop;
          expect(artifact.sizeBytes).toBe(bytes);
          expect(Buffer.from(yield* fs.readFile(artifact.path)).equals(payload)).toBe(true);
        }
        expect(stagedPath).toBeDefined();
        expect(yield* fs.exists(stagedPath!)).toBe(false);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect.each([
  { refreshFails: false, expected: "final frame" },
  { refreshFails: true, expected: "frame" },
])(
  "saves the last page state when stopping a recording ($refreshFails)",
  ({ refreshFails, expected }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });

        const cdp = contexts[0]!.sessions[0]!;
        const send = cdp.send.getMockImplementation()!;
        cdp.send.mockImplementation((method, input) => {
          if (method !== "Page.captureScreenshot") return send(method, input);
          return refreshFails
            ? Promise.reject(new Error("Page cannot capture a frame"))
            : Promise.resolve({ data: Buffer.from("final frame").toString("base64") });
        });
        const artifact = yield* broker.invoke<{ path: string }>({
          scope,
          tabId,
          operation: "recordingStop",
          input: {},
        });
        expect(yield* fs.readFileString(artifact.path)).toBe(expected);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("enforces provider ownership and explicit targets when a session has multiple tabs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/foreign" },
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(
        "http://localhost:5173/foreign",
        expect.anything(),
      );
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope: asSession("agent-b"),
        tabId,
        operation: "snapshot",
        input: {},
      });
      const foreignEvaluate = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "evaluate",
          input: { expression: "read()" },
        })
        .pipe(Effect.flip);
      expect(foreignEvaluate).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      yield* broker.invoke({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const ambiguous = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "ambiguous()" } })
        .pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const ambiguousStop = yield* broker
        .invoke<void>({ scope, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(ambiguousStop).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const explicitStop = yield* broker
        .invoke<void>({ scope, tabId, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(explicitStop).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        cause: { _tag: "PreviewAutomationRecordingNotActiveError" },
      });
      const result = yield* broker.invoke({
        scope,
        tabId,
        operation: "evaluate",
        input: { expression: "owned()" },
      });
      expect(result).toBe("evaluated");
      expect(contexts).toHaveLength(2);

      const manager = yield* Manager.PreviewManager;
      const unclaimed = yield* manager.open({
        threadId: scope.thread.threadId,
        runtime: "server",
      });
      const closeUnclaimed = yield* broker
        .invoke<void>({
          scope,
          tabId: PreviewTabId.make(unclaimed.tabId),
          operation: "close",
          input: {},
        })
        .pipe(Effect.flip);
      expect(closeUnclaimed).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "unclaimedTab",
      });
      expect(closeUnclaimed.message).toBe(
        "This tab has no agent owner. Ask the user to close it in the browser panel.",
      );
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
        expect.objectContaining({ tabId: unclaimed.tabId }),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a first still that never returns does not stall the tab's later captures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      const capturing = Promise.withResolvers<void>();
      const stuck = Promise.withResolvers<void>();
      heldStill = () => {
        heldStill = null;
        capturing.resolve();
        return stuck.promise;
      };
      yield* Effect.addFinalizer(() => Effect.sync(() => stuck.resolve()));
      yield* browser.attachViewer(viewerInput(tabId, true));
      yield* Effect.promise(() => capturing.promise);
      const snapshotting = yield* broker
        .invoke<PreviewAutomationSnapshot>({ scope, tabId, operation: "snapshot", input: {} })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
      const snapshot = yield* Fiber.join(snapshotting);
      expect(snapshot.accessibilityTree).toContain("delete");
      const second = yield* browser.attachViewer(viewerInput(tabId, false));
      const frame = yield* Stream.fromQueue(second.output).pipe(
        Stream.filter((output) => output._tag === "frame"),
        Stream.runHead,
      );
      expect(Option.isSome(frame)).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("keeps a tab's zoom when its viewer resizes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const { tabId } = yield* manager.open({
        threadId: scope.thread.threadId,
        runtime: "server",
        zoomFactor: 1.5,
      });
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const cdp = contexts[0]!.sessions[0]!;
      cdp.send.mockClear();
      // Resizing the page resets Chromium's device metrics, so zoom must be applied again.
      yield* viewer.input({ type: "resize", width: 390, height: 844 });
      expect(cdp.send).toHaveBeenCalledWith(
        "Emulation.setDeviceMetricsOverride",
        expect.objectContaining({ deviceScaleFactor: 3 }),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "streams to a read-only viewer without allowing takeover, input, or viewport changes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, tabId } = yield* ready;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
        const page = contexts[0]!.page;
        page.setViewportSize.mockClear();
        const session = contexts[0]!.sessions.at(-1)!;
        session.send.mockClear();
        for (const message of [
          { type: "takeControl" },
          { type: "key", action: "down", key: "a", text: "a" },
          { type: "resize", width: 390, height: 844 },
          { type: "viewport", setting: { _tag: "freeform", width: 390, height: 844 } },
        ])
          yield* viewer.input(message);
        expect(page.setViewportSize).not.toHaveBeenCalled();
        expect(session.send.mock.calls.some(([method]) => method.startsWith("Input."))).toBe(false);
        const outputs = yield* Stream.fromQueue(viewer.output).pipe(
          Stream.takeUntil((output) => output._tag === "frame"),
          Stream.runCollect,
        );
        expect(outputs).toContainEqual(
          expect.objectContaining({ _tag: "frame", data: Buffer.from("frame") }),
        );
        expect(outputs).toContainEqual(expect.objectContaining({ _tag: "viewport" }));
        expect(outputs).toContainEqual(
          expect.objectContaining({ _tag: "control", canOperate: false, controller: "agent" }),
        );
        const operator = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* operator.input({ type: "takeControl" });
        yield* operator.input({ type: "text", text: "typed" });
        yield* operator.input({ type: "resize", width: 390, height: 844 });
        expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
          text: "typed",
        });
        expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
        yield* operator.input({ type: "releaseControl" });
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "takeover waits for the running agent and revokes snapshot refs before returning control",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        const ref = /\[ref=([^\]]+)\]/.exec(String(snapshot.accessibilityTree))![1]!;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<Record<string, unknown>>();
        const session = contexts[0]!.sessions[0]!;
        session.send.mockImplementationOnce(async () => {
          started.resolve();
          return finish.promise;
        });
        const running = yield* broker
          .invoke({ scope, tabId, operation: "evaluate", input: { expression: "pending()" } })
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => finish.resolve({ result: { value: "finished" } })),
        );
        yield* Effect.promise(() => started.promise);
        const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
        let control = yield* Queue.take(viewer.output);
        while (control._tag !== "control" || control.controller !== "you") {
          control = yield* Queue.take(viewer.output);
        }
        const rejected = yield* broker
          .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "racing()" } })
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        finish.resolve({ result: { value: "finished" } });
        expect(yield* Fiber.join(running)).toBe("finished");
        yield* Fiber.join(takeover);
        yield* viewer.input({ type: "releaseControl" });
        const stale = yield* broker
          .invoke<void>({ scope, tabId, operation: "click", input: { locator: `aria-ref=${ref}` } })
          .pipe(Effect.flip);
        expect(stale._tag).toBe("PreviewAutomationInvalidSelectorError");
        expect(contexts[0]!.page.locator).not.toHaveBeenCalled();
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "resumed()" },
          }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "reports a valid CSS selector that matches several elements as ambiguous, not invalid",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const strict = new Error(
          "locator.scrollIntoViewIfNeeded: Error: strict mode violation: locator('button[aria-label=\\'Permissions: Full access\\']') resolved to 2 elements:",
        );
        contexts[0]!.page.locator.mockImplementation(
          () =>
            new Proxy(
              {},
              {
                get: () => async () => {
                  throw strict;
                },
              },
            ),
        );
        const failure = yield* broker
          .invoke<void>({
            scope,
            tabId,
            operation: "click",
            input: { selector: "button[aria-label='Permissions: Full access']", timeoutMs: 1_000 },
          })
          .pipe(Effect.flip);
        expect(failure.message).not.toMatch(/invalid selector/);
        expect(failure.message).toMatch(/2 elements/);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("reports a pending dialog without evaluating the page and resolves it explicitly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173" },
      });
      const started = Promise.withResolvers<void>();
      const resolvedEvaluation = Promise.withResolvers<Record<string, unknown>>();
      const session = contexts[0]!.sessions[0]!;
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method !== "Runtime.evaluate") return send(method, input);
        started.resolve();
        return resolvedEvaluation.promise;
      });
      const blockedAction = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete row?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => resolvedEvaluation.resolve({ result: { value: true } })),
      );
      yield* Effect.promise(() => started.promise);
      const dialog = {
        type: () => "confirm",
        message: () => "Delete row?",
        defaultValue: () => "",
        accept: vi.fn(async () => {
          resolvedEvaluation.resolve({ result: { value: true } });
        }),
        dismiss: vi.fn(async () => {}),
      };
      page.emit("dialog", dialog);
      page.title.mockClear();
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.dialog).toMatchObject({ type: "confirm", message: "Delete row?" });
      expect(page.title).not.toHaveBeenCalled();
      expect(dialog.dismiss).not.toHaveBeenCalled();
      const reuse = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "open",
          input: { url: "http://localhost:5173/other" },
        })
        .pipe(Effect.flip);
      expect(reuse).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "dialogPending",
      });
      expect(page.goto).toHaveBeenCalledTimes(1);
      yield* broker.invoke({ scope, tabId, operation: "dialog", input: { accept: true } });
      expect(yield* Fiber.join(blockedAction)).toBe(true);
      expect(dialog.accept).toHaveBeenCalledTimes(1);
      const resolved = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(resolved.dialog).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("closing an isolated tab closes its context only after the page closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const context = contexts[0]!;
      const page = context.page;
      page.beforeUnload = "listen";
      page.unloadGate = Promise.withResolvers<void>();
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      expect(context.close).not.toHaveBeenCalled();
      expect(page.isClosed()).toBe(false);
      page.unloadGate.resolve();
      yield* Effect.promise(() => context.closing.promise);
      expect(page.isClosed()).toBe(true);
      expect(page.unloadEvents).toEqual(["beforeunload", "pagehide", "visibilitychange"]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("closing a tab force-closes a page that never finishes unloading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const context = contexts[0]!;
      const page = context.page;
      page.beforeUnload = "listen";
      page.unloadGate = Promise.withResolvers<void>();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      vi.advanceTimersByTime(4_999);
      expect(page.isClosed()).toBe(false);
      expect(context.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(page.isClosed()).toBe(true);
      yield* Effect.promise(() => context.closing.promise);
      expect(vi.getTimerCount()).toBe(0);
    }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers()))),
  ).pipe(Effect.provide(layer)),
);

it.effect("closing a desktop tab waits for its page to unload before the desktop removes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      desktopRendersNext = true;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, open: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      const { context, browser } = desktopConnections[0]!;
      const page = context.page;
      // The desktop removes the webview once the session closes, dropping an unload in progress.
      const events = yield* manager.subscribeEvents;
      const sessionClosed = Promise.withResolvers<void>();
      yield* Effect.gen(function* () {
        while ((yield* PubSub.take(events)).type !== "closed");
        page.removed = true;
        sessionClosed.resolve();
      }).pipe(Effect.forkScoped);
      page.beforeUnload = "listen";
      page.unloadGate = Promise.withResolvers<void>();
      const closing = yield* broker
        .invoke({ scope, tabId, operation: "close", input: {} })
        .pipe(Effect.forkScoped);
      // The page finishes unloading once the server listens for it, or too late if it never does.
      yield* Effect.promise(() =>
        Promise.race([page.pagehideWatched.promise, sessionClosed.promise]),
      );
      expect(browser.close).not.toHaveBeenCalled();
      page.unloadGate.resolve();
      yield* Fiber.join(closing);
      expect(page.unloadEvents).toEqual(["beforeunload", "pagehide", "visibilitychange"]);
      expect(browser.close).toHaveBeenCalledTimes(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("closing a tab with an unsaved-changes guard still closes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      // A profile context is shared, so closing the tab cannot fall back to closing its context.
      const reportProfiles = yield* browser.profileReporter;
      yield* reportProfiles({
        profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
        defaultProfileId: "profile-work",
      });
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false, profileId: "profile-work" },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      expect(contextRequests).toEqual([{ profileId: "profile-work", isolated: false }]);
      const page = contexts[0]!.page;
      page.beforeUnload = "guard";
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      // The mock raises the dialog inside `close`, so an unanswered guard leaves the page open here.
      expect(page.beforeUnloadDialog).not.toBeNull();
      expect(page.beforeUnloadDialog!.accept).toHaveBeenCalledTimes(1);
      expect(page.isClosed()).toBe(true);
      expect(page.unloadEvents).toEqual(["beforeunload", "pagehide", "visibilitychange"]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a tab whose renderer crashes stays open instead of vanishing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const url = `https://example.com/app?${"a".repeat(3000)}`;
      contexts[0]!.page.commit(url);
      yield* Effect.promise(() => contexts[0]!.page.emitAsync("crash"));
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.tabId).toBe(tabId);
      expect(status.loadError).toEqual({
        url: url.slice(0, 2048),
        code: -2,
        description: "Page crashed",
      });
      // The crashed page cannot load anything again, so Reload goes to the page that replaced it.
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "reload" });
      expect(contexts[1]!.page.goto).toHaveBeenCalledWith(url, expect.anything());
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a tab opened to a file the browser cannot show reports the file to download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const request = { url: () => pdf, method: () => "GET", isNavigationRequest: () => true };
      page.emit("requestfailed", {
        ...request,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        delete: async () => {
          // A new navigation during cleanup must not erase the settled download status.
          page.emit("request", {
            url: () => "https://example.com/next",
            method: () => "GET",
            isNavigationRequest: () => true,
            frame: () => page,
          });
        },
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      written.resolve();
      const received = [];
      let status;
      do {
        status = yield* PubSub.take(events);
        received.push(status);
      } while (
        status.type !== "navigated" ||
        status.snapshot.navStatus._tag !== "Loading" ||
        status.snapshot.navStatus.url !== "https://example.com/next"
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "failed",
          url: pdf,
          download: { id: expect.any(String), fileName: "paper.pdf" },
        }),
      );
      expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "download")).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "a late failure from a request that predates tracking leaves a newer navigation loading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const navigation = (url: string) => ({
          url: () => url,
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => page,
          failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
        });
        page.emit("request", navigation("https://example.com/next"));
        // A popup's first request can start before the tab listens for requests.
        page.emit("requestfailed", navigation("https://example.com/first"));
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.loading).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a navigation that fails while a load reads its title keeps its failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const page = contexts[0]!.page;
      const heldTitle = Promise.withResolvers<string>();
      page.title.mockImplementationOnce(() => heldTitle.promise);
      yield* Effect.promise(() => page.goto("https://example.com/first"));
      const failing = {
        url: () => "https://example.com/missing",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }),
      };
      page.emit("request", failing);
      page.emit("requestfailed", failing);
      heldTitle.resolve("Held");
      // A load at the same await depth reports after the held one, so its Success marks the end.
      page.emit("load");

      const statuses: Array<string> = [];
      while (!statuses.at(-1)?.startsWith("Success")) {
        const event = yield* PubSub.take(events);
        if (event.type === "failed" && event.tabId === tabId) {
          statuses.push(`LoadFailed ${event.url}`);
        } else if (event.type === "navigated" && event.tabId === tabId) {
          const status = event.snapshot.navStatus;
          if (status._tag === "Success") statuses.push(`Success ${status.title}`);
          else if (status._tag === "Loading") statuses.push(`Loading ${status.url}`);
        }
      }
      expect(statuses).toEqual([
        "Loading https://example.com/missing",
        "LoadFailed https://example.com/missing",
        "Success test page",
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  {
    name: "hover burst before a click",
    inputs: [
      ...Array.from({ length: 120 }, (_, x) => ({
        type: "mouse",
        action: "move",
        x,
        buttons: 0,
        button: "none",
      })),
      { type: "mouse", action: "down", x: 119, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 119, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 119 },
      { type: "mousePressed", x: 119 },
      { type: "mouseReleased", x: 119 },
    ],
  },
  {
    name: "wheel burst before a click",
    inputs: [
      ...Array.from({ length: 120 }, () => ({
        type: "wheel",
        x: 100,
        y: 200,
        deltaX: 0,
        deltaY: 12,
      })),
      { type: "mouse", action: "down", x: 100, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 100, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseWheel", x: 100, y: 200, deltaX: 0, deltaY: 1440 },
      { type: "mousePressed", x: 100 },
      { type: "mouseReleased", x: 100 },
    ],
  },
  {
    name: "modifier changes and drag points",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none", modifiers: 2 },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none", modifiers: 2 },
      { type: "mouse", action: "down", x: 3, buttons: 1, button: "left" },
      { type: "mouse", action: "move", x: 4, buttons: 1, button: "left" },
      { type: "mouse", action: "move", x: 5, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 5, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1, modifiers: 0 },
      { type: "mouseMoved", x: 3, modifiers: 2 },
      { type: "mousePressed", x: 3 },
      { type: "mouseMoved", x: 4 },
      { type: "mouseMoved", x: 5 },
      { type: "mouseReleased", x: 5 },
    ],
  },
  {
    name: "wheel and keyboard boundaries",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "wheel", x: 1, deltaY: 20 },
      { type: "wheel", x: 1, deltaY: 30 },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none" },
      { type: "key", action: "down", key: "a", code: "KeyA", text: "a" },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1 },
      { type: "mouseWheel", deltaY: 50 },
      { type: "mouseMoved", x: 2 },
      { type: "keyDown", key: "a" },
      { type: "mouseMoved", x: 3 },
    ],
  },
  {
    name: "wheel position, modifier and direction boundaries",
    inputs: [
      { type: "wheel", x: 1, deltaX: 5, deltaY: 10 },
      { type: "wheel", x: 1, deltaX: 5, deltaY: 10 },
      { type: "wheel", x: 2, deltaY: 10 },
      { type: "wheel", x: 2, deltaY: 10, modifiers: 2 },
      { type: "wheel", x: 2, deltaY: -10, modifiers: 2 },
      { type: "wheel", x: 2, deltaY: -10, modifiers: 2 },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseWheel", x: 1, deltaX: 10, deltaY: 20, modifiers: 0 },
      { type: "mouseWheel", x: 2, deltaX: 0, deltaY: 10, modifiers: 0 },
      { type: "mouseWheel", x: 2, deltaY: 10, modifiers: 2 },
      { type: "mouseWheel", x: 2, deltaY: -20, modifiers: 2 },
    ],
  },
  {
    name: "text, navigation and resize boundaries",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "text", text: "typed" },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none" },
      { type: "navigate", url: "http://localhost:5173/next" },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none" },
      { type: "resize", width: 640, height: 480 },
      { type: "mouse", action: "move", x: 4, buttons: 0, button: "none" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1 },
      { text: "typed" },
      { type: "mouseMoved", x: 2 },
      { type: "mouseMoved", x: 3 },
      { type: "mouseMoved", x: 4 },
    ],
  },
  {
    name: "ambiguous button fields",
    inputs: [
      { type: "mouse", action: "move", x: 1, button: "none" },
      { type: "mouse", action: "move", x: 2, button: "none" },
      { type: "mouse", action: "move", x: 3, buttons: 0 },
      { type: "mouse", action: "move", x: 4, buttons: 0 },
    ],
    expected: [-1, 1, 2, 3, 4].map((x) => ({ type: "mouseMoved", x })),
  },
])("orders streamed input correctly for $name", (testCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const session = contexts[0]!.sessions.at(-1)!;
      const send = session.send.getMockImplementation()!;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => finish.resolve()));
      session.send.mockClear();
      session.send.mockImplementationOnce(async (method, input) => {
        started.resolve();
        await finish.promise;
        return send(method, input);
      });
      const running = yield* viewer
        .input({ type: "mouse", action: "move", x: -1, button: "none", buttons: 0 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.promise(() => started.promise);
      const waiting = yield* Effect.forEach(testCase.inputs, (input) =>
        viewer.input(input).pipe(Effect.forkScoped({ startImmediately: true })),
      );
      finish.resolve();
      yield* Effect.forEach([running, ...waiting], Fiber.join);
      const dispatched = session.send.mock.calls.flatMap(([method, input]) =>
        method.startsWith("Input.") ? [input] : [],
      );
      expect(dispatched).toHaveLength(testCase.expected.length);
      expect(dispatched).toMatchObject(testCase.expected);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("only the controlling viewer's copy and cut keys reach its clipboard", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const clipboard = (queue: typeof viewer.output) =>
        Queue.clear(queue).pipe(
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      pageCopy = "unprompted";
      yield* viewer.input({ type: "mouse", action: "move", x: 10, y: 10 });
      yield* viewer.input({ type: "wheel", x: 10, y: 10, deltaY: 40 });
      yield* viewer.input({ type: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
      yield* viewer.input({ type: "unknown" });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      keyCopy = "copied";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      const cdp = contexts[0]!.sessions.at(-1)!;
      expect(cdp.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
      keyCopy = "cut";
      yield* viewer.input({ type: "key", action: "down", key: "x", code: "KeyX", modifiers: 2 });
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "cut" }]);
      pageCopy = "left over";
      keyCopy = "";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      expect(yield* clipboard(watcher.output)).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a busy embedded frame does not hold a copy key back from the page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const context = contexts[0]!;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const pageSession = context.sessions.at(-1)!;
      const frame = makeFrame();
      context.page.emit("framenavigated", frame);
      yield* Effect.promise(() => frame.recording.promise);

      // The frame answers its copy read only once the page has the key and the
      // input after it, like a frame busy for longer than the user waits.
      const keyReached = Promise.withResolvers<void>();
      const pageSend = pageSession.send.getMockImplementation()!;
      pageSession.send.mockImplementation(async (method, input) => {
        if (method === "Input.dispatchKeyEvent" && (input as { type?: string }).type === "keyUp")
          keyReached.resolve();
        return pageSend(method, input);
      });
      const frameSession = context.sessions.at(-1)!;
      const frameSend = frameSession.send.getMockImplementation()!;
      frameSession.send.mockImplementation(async (method, input) => {
        if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
          await keyReached.promise;
        }
        return frameSend(method, input);
      });

      keyCopy = "copied";
      const copying = yield* viewer
        .input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* viewer.input({ type: "key", action: "up", key: "c", code: "KeyC", modifiers: 4 });
      yield* Fiber.join(copying);
      expect(pageSession.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      const clipboard = yield* Queue.clear(viewer.output);
      expect(clipboard.filter((item) => item._tag === "clipboard")).toEqual([
        { _tag: "clipboard", text: "copied" },
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([false, true])(
  "a page download is saved, offered to the controller, and listed for the agent (delete fails: %s)",
  (deleteFails) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* Queue.clear(viewer.output);
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        const released = Promise.withResolvers<void>();
        page.emit("download", {
          failure: async () => null,
          delete: async () => {
            try {
              if (deleteFails) throw new Error("context closed");
              await NodeFSP.rm(original);
            } finally {
              released.resolve();
            }
          },
          saveAs: (path: string) => NodeFSP.copyFile(original, path),
          suggestedFilename: () => "report.csv",
          url: () => 'data:text/csv;charset="a,b",a b\'c',
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
        expect(offered).toMatchObject({ _tag: "download", fileName: "report.csv", sizeBytes: 3 });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(deleteFails);
        const file = yield* browser.openDownload({
          threadId: scope.thread.threadId,
          tabId,
          downloadId: offered.id,
        });
        expect(Option.isSome(file) && file.value.fileName).toBe("report.csv");
        expect(yield* fs.readFileString(Option.getOrThrow(file).path)).toBe("a,b");
        if ((yield* HostProcess.Platform) !== "win32") {
          expect((yield* fs.stat(Option.getOrThrow(file).path)).mode & 0o777).toBe(0o600);
        }
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([
          expect.objectContaining({
            fileName: "report.csv",
            sizeBytes: 3,
            url: "data:text/csv,…",
          }),
        ]);
        expect(
          Option.isNone(
            yield* browser.openDownload({
              threadId: scope.thread.threadId,
              tabId,
              downloadId: "guess",
            }),
          ),
        ).toBe(true);
        if ((yield* HostProcess.Platform) !== "win32") {
          const folder = (yield* Path.Path).dirname(Option.getOrThrow(file).path);
          yield* fs.chmod(folder, 0o755);
          page.emit("download", {
            failure: async () => null,
            delete: async () => {},
            saveAs: (path: string) => NodeFSP.writeFile(path, "c"),
            suggestedFilename: () => "again.csv",
            url: () => "https://example.test/again.csv",
          });
          let again = yield* Queue.take(viewer.output);
          while (again._tag !== "download") again = yield* Queue.take(viewer.output);
          expect((yield* fs.stat(folder)).mode & 0o777).toBe(0o700);
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a tab showing a data: page reports its URL without the content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const sibling = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      yield* Effect.promise(() => contexts[1]!.page.goto("data:text/html,<p>SIBLING-SECRET</p>"));
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.promise(() => contexts[0]!.page.goto("data:text/html,<p>SECRET-KEY</p>"));
      let event = yield* PubSub.take(events);
      while (
        event.type !== "navigated" ||
        event.tabId !== tabId ||
        event.snapshot.navStatus._tag !== "Success"
      ) {
        event = yield* PubSub.take(events);
      }
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(event.snapshot.navStatus).toMatchObject({ url: "data:text/html,…" });
      expect(status.url).toBe("data:text/html,…");
      expect(status.tabs?.find((entry) => entry.tabId === tabId)?.url).toBe("data:text/html,…");
      expect(status.tabs?.find((entry) => entry.tabId === sibling.tabId)?.url).toBe(
        "data:text/html,…",
      );
      expect(JSON.stringify([event, status])).not.toContain("SECRET-KEY");
      expect(JSON.stringify([event, status])).not.toContain("SIBLING-SECRET");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each(["save failed", "oversized"])(
  "a rejected download releases the original and keeps no saved copy (%s)",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        let savedPath: string | undefined;
        const released = Promise.withResolvers<void>();
        contexts[0]!.page.emit("download", {
          failure: async () => null,
          delete: async () => {
            await NodeFSP.rm(original);
            released.resolve();
          },
          saveAs: async (path: string) => {
            savedPath = path;
            await NodeFSP.copyFile(original, path);
            if (outcome === "save failed") throw new Error("save interrupted");
            // A sparse file exercises the size limit without writing a GiB of data.
            await NodeFSP.truncate(path, 1024 ** 3 + 1);
          },
          suggestedFilename: () => "report.csv",
          url: () => "blob:http://localhost:5173/1",
        });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(false);
        if (savedPath !== undefined) expect(yield* fs.exists(savedPath)).toBe(false);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a restarted server removes the previous run's downloads and keeps its profiles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const previousTab = path.join(stateDir, "server-browser", "downloads", "previous-tab");
      const profile = path.join(stateDir, "server-browser", "profiles", "default");
      yield* fs.makeDirectory(previousTab, { recursive: true });
      yield* fs.makeDirectory(profile, { recursive: true });
      yield* fs.writeFileString(path.join(previousTab, "report.csv"), "a,b");
      yield* fs.writeFileString(path.join(profile, "Preferences"), "{}");

      yield* Layer.build(ServerBrowser.layer);

      expect(yield* fs.exists(previousTab)).toBe(false);
      expect(yield* fs.readFileString(path.join(profile, "Preferences"))).toBe("{}");
    }),
  ).pipe(Effect.provide(dependencies)),
);

it.effect("a page's file picker goes to the controller and takes its uploaded files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(".csv"),
        setFiles,
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ multiple: false, accept: ".csv" });
      const file = (name: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(name) });
      const answer = (chooserId: string) =>
        browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId,
          files: [file("a.csv"), file("b.csv")],
        });
      expect(yield* answer("other")).toBe(false);
      expect(yield* answer(offered.id)).toBe(true);
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([file("a.csv")]);
      let closed = yield* Queue.take(viewer.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
      expect(closed.id).toBe(offered.id);
      expect(yield* answer(offered.id)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("overlapping file pickers keep the newer offer answerable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string | null>();
      const firstFiles = vi.fn(async (_files: unknown) => {});
      const secondFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ ...fileChooserElement(""), getAttribute: () => accept.promise }),
        setFiles: firstFiles,
      });
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(".csv"),
        setFiles: secondFiles,
      });
      accept.resolve(".txt");
      let first = yield* Queue.take(viewer.output);
      while (first._tag !== "fileChooser") first = yield* Queue.take(viewer.output);
      let second = yield* Queue.take(viewer.output);
      while (second._tag !== "fileChooser") second = yield* Queue.take(viewer.output);
      expect(second.accept).toBe(".csv");
      expect(
        yield* browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId: second.id,
          files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
        }),
      ).toBe(true);
      expect(firstFiles).not.toHaveBeenCalled();
      expect(secondFiles).toHaveBeenCalledOnce();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a detached file picker stays open across same-document navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const pageDocument = {};
      vi.stubGlobal("document", pageDocument);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const detachedInput = { isConnected: false, ownerDocument: pageDocument };
      const navigationProbe = Promise.withResolvers<boolean>();
      const navigationProbeStarted = Promise.withResolvers<void>();
      const navigationProbeFinished = Promise.withResolvers<void>();
      let probeCount = 0;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: async () => "",
          evaluate: (probe: (element: typeof detachedInput) => boolean) => {
            probeCount++;
            if (probeCount === 1) return Promise.resolve(probe(detachedInput));
            navigationProbeStarted.resolve();
            return navigationProbe.promise.then((current) => {
              const result = probe(detachedInput);
              navigationProbeFinished.resolve();
              return current && result;
            });
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);

      page.emit("framenavigated", page);
      yield* Effect.promise(() => navigationProbeStarted.promise);
      navigationProbe.resolve(true);
      yield* Effect.promise(() => navigationProbeFinished.promise);
      yield* viewer.input({ type: "releaseControl" });
      let closedAfterNavigation = false;
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller === "you") {
        if (control._tag === "fileChooserClosed") closedAfterNavigation = true;
        control = yield* Queue.take(viewer.output);
      }
      expect(closedAfterNavigation).toBe(false);
      yield* viewer.input({ type: "takeControl" });
      let restoredControl = yield* Queue.take(viewer.output);
      while (restoredControl._tag !== "control" || restoredControl.controller !== "you") {
        restoredControl = yield* Queue.take(viewer.output);
      }

      expect(
        yield* browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId: offered.id,
          files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
        }),
      ).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each(["main", "iframe"])(
  "a file picker closes at %s document commit before DOMContentLoaded",
  (frame) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const setFiles = vi.fn(async (_files: unknown) => {});
        const probeStarted = Promise.withResolvers<void>();
        const probeSettled = Promise.withResolvers<void>();
        let probeCount = 0;
        page.emit("filechooser", {
          isMultiple: () => false,
          element: () => ({
            getAttribute: async () => "",
            evaluate: () => {
              probeCount++;
              if (probeCount === 1) return Promise.resolve(true);
              probeStarted.resolve();
              return Promise.reject(new Error("Execution context was destroyed")).finally(() =>
                probeSettled.resolve(),
              );
            },
          }),
          setFiles,
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);

        page.emit("framenavigated", frame === "main" ? page : makeFrame());
        yield* Effect.promise(() => probeStarted.promise);
        yield* Effect.promise(() => probeSettled.promise);
        let closed = yield* Queue.take(viewer.output);
        while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
        expect(closed.id).toBe(offered.id);
        expect(
          yield* browser.answerFileChooser({
            threadId: scope.thread.threadId,
            tabId,
            chooserId: offered.id,
            files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
          }),
        ).toBe(false);
        expect(setFiles).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a file picker closes when its page is replaced while control changes hands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const current = Promise.withResolvers<boolean>();
      const probeStarted = Promise.withResolvers<void>();
      let probeCount = 0;
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: async () => "",
          evaluate: () => {
            probeCount++;
            if (probeCount === 1) return Promise.resolve(true);
            probeStarted.resolve();
            return current.promise;
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);

      page.emit("framenavigated", page);
      yield* Effect.promise(() => probeStarted.promise);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      let reoffered = yield* Queue.take(second.output);
      while (reoffered._tag !== "fileChooser") reoffered = yield* Queue.take(second.output);
      current.resolve(false);
      let closed = yield* Queue.take(second.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(second.output);
      expect(closed.id).toBe(reoffered.id);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.fileChooser).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a file picker is not offered after its document changes while reading accept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string | null>();
      const acceptRead = Promise.withResolvers<void>();
      const current = Promise.withResolvers<boolean>();
      const probeStarted = Promise.withResolvers<void>();
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: () => {
            acceptRead.resolve();
            return accept.promise;
          },
          evaluate: () => {
            probeStarted.resolve();
            return current.promise;
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });

      yield* Effect.promise(() => acceptRead.promise);
      page.emit("framenavigated", page);
      accept.resolve("");
      yield* Effect.promise(() => accept.promise);
      yield* Effect.promise(() => probeStarted.promise);
      current.resolve(false);
      yield* Effect.promise(() => current.promise);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.fileChooser).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("only the current controller can answer a file picker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      contexts[0]!.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(""),
        setFiles,
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      const answered = yield* browser.answerFileChooser({
        threadId: scope.thread.threadId,
        tabId,
        chooserId: offered.id,
        files: [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }],
      });
      expect(answered).toBe(false);
      expect(setFiles).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "desktop viewers get the page's CSS size and keep the last one a read cannot measure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Each page size read waits here for its answer.
        const reads = yield* Queue.unbounded<PromiseWithResolvers<Record<string, unknown>>>();
        const deferReads = () => {
          desktopSizeAnswer = () => {
            const read = Promise.withResolvers<Record<string, unknown>>();
            Queue.offerUnsafe(reads, read);
            return read.promise;
          };
        };
        deferReads();
        const { viewer, cdp, context } = yield* openDesktopViewer;
        const answer = (width: number, height: number) => ({
          result: { value: { width, height } },
        });
        const resized = () => cdp.emitAsync("Page.frameResized");
        // The read on attach never answers and gives up with no size to send.
        const blocked = yield* Queue.take(reads);
        yield* TestClock.adjust("1 second");
        // The next page load measures again.
        desktopSizeAnswer = null;
        yield* Effect.promise(() => cdp.emitAsync("Page.loadEventFired"));
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual(["1920x1080"]);
        // While a dialog is open nothing reads. The host closing it clears it, and since
        // closing resizes nothing, the close itself remeasures.
        deferReads();
        context.page.emit("dialog", {
          type: () => "alert",
          message: () => "",
          defaultValue: () => "",
        });
        yield* Effect.promise(resized);
        expect(yield* Queue.size(reads)).toBe(0);
        desktopSizeAnswer = null;
        yield* Effect.promise(() => cdp.emitAsync("Page.javascriptDialogClosed"));
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
          "1920x1080",
          "1920x1080",
        ]);
        // The late answer, a read a navigation breaks and a hidden webview keep the last size.
        blocked.resolve(answer(100, 100));
        deferReads();
        const navigated = resized();
        (yield* Queue.take(reads)).reject(new Error("Cannot find context with specified id"));
        yield* Effect.promise(() => navigated);
        const hidden = resized();
        (yield* Queue.take(reads)).resolve(answer(0, 0));
        yield* Effect.promise(() => hidden);
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
          "1920x1080",
          "1920x1080",
        ]);
        // Resizes during a read share one more read, so the newest size arrives last.
        const first = resized();
        const firstRead = yield* Queue.take(reads);
        const burst = Promise.all([resized(), resized()]);
        firstRead.resolve(answer(800, 500));
        (yield* Queue.take(reads)).resolve(answer(1000, 600));
        expect(yield* Queue.size(reads)).toBe(0);
        yield* Effect.promise(() => Promise.all([first, burst]));
        expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
          "800x500",
          "1000x600",
          "1000x600",
        ]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a desktop tab reports the size the desktop draws after a resize", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const failReads = () => Promise.reject(new Error("Cannot find context with specified id"));
      desktopSizeAnswer = failReads;
      desktopRendersNext = true;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      const { context } = desktopConnections.at(-1)!;
      const cdp = context.sessions[0]!;
      const events = yield* manager.subscribeEvents;
      const status = broker
        .invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} })
        .pipe(Effect.map((result) => result.viewport));
      // The desktop draws the new size once the session update reaches it.
      const resize = (input: Record<string, unknown>, width: number, height: number) =>
        Effect.gen(function* () {
          const result = yield* broker
            .invoke<PreviewAutomationResizeResult>({ scope, tabId, operation: "resize", input })
            .pipe(Effect.forkScoped);
          let event = yield* PubSub.take(events);
          while (event.type !== "resized" || event.tabId !== tabId) {
            event = yield* PubSub.take(events);
          }
          Object.assign(context.cssViewport, { width, height });
          yield* Effect.promise(() => cdp.emitAsync("Page.frameResized"));
          return (yield* Fiber.join(result)).viewport;
        });

      // A size no read measured after the resize is unknown, never a default or the last one.
      expect(
        yield* resize({ mode: "freeform", width: 900, height: 600 }, 900, 600),
      ).toBeUndefined();
      desktopSizeAnswer = null;
      expect(yield* resize({ mode: "freeform", width: 1280, height: 760 }, 1280, 760)).toEqual({
        width: 1280,
        height: 760,
      });
      desktopSizeAnswer = failReads;
      expect(yield* status).toEqual({ width: 1280, height: 760 });
      expect(
        yield* resize({ mode: "freeform", width: 1000, height: 700 }, 1000, 700),
      ).toBeUndefined();
      desktopSizeAnswer = null;
      // A page can keep another size than the fixed one asked for; both report the page's.
      expect(yield* resize({ mode: "freeform", width: 844, height: 390 }, 560, 760)).toEqual({
        width: 560,
        height: 760,
      });
      expect(yield* status).toEqual({ width: 560, height: 760 });
      expect(yield* resize({ mode: "fill" }, 1234, 700)).toEqual({ width: 1234, height: 700 });
      // No page resize or load since that read, so status answers without reading again.
      let reads = 0;
      desktopSizeAnswer = async () => {
        reads += 1;
        return { result: { value: { width: 1, height: 1 } } };
      };
      expect(yield* status).toEqual({ width: 1234, height: 700 });
      expect(reads).toBe(0);
      // A status during a read waits for it rather than answer the size before it.
      const pending = yield* Queue.unbounded<PromiseWithResolvers<Record<string, unknown>>>();
      const heldAnswer = () => {
        const read = Promise.withResolvers<Record<string, unknown>>();
        Queue.offerUnsafe(pending, read);
        return read.promise;
      };
      desktopSizeAnswer = heldAnswer;
      const answer = (width: number, height: number) => ({ result: { value: { width, height } } });
      const refill = broker
        .invoke<PreviewAutomationResizeResult>({
          scope,
          tabId,
          operation: "resize",
          input: { mode: "fill" },
        })
        .pipe(
          Effect.map((result) => result.viewport),
          Effect.forkScoped,
        );
      // Status reads the URL just before it picks the size.
      const url = context.page.url();
      using urlRead = vi.spyOn(context.page, "url");
      const startStatus = Effect.gen(function* () {
        const started = Promise.withResolvers<void>();
        urlRead.mockImplementationOnce(() => {
          started.resolve();
          return url;
        });
        const fiber = yield* Effect.forkScoped(status);
        yield* Effect.promise(() => started.promise);
        return fiber;
      });
      const filled = yield* refill;
      const read = yield* Queue.take(pending);
      const during = yield* startStatus;
      read.resolve(answer(1100, 650));
      expect(yield* Fiber.join(during)).toEqual({ width: 1100, height: 650 });
      expect(yield* Fiber.join(filled)).toEqual({ width: 1100, height: 650 });
      // A page resize during that read makes its answer old: status reads again, and the
      // resize result has no size.
      const outdated = yield* refill;
      const oldRead = yield* Queue.take(pending);
      const later = yield* startStatus;
      yield* Effect.promise(() => cdp.emitAsync("Page.frameResized"));
      desktopSizeAnswer = async () => answer(1000, 600);
      oldRead.resolve(answer(1100, 650));
      expect(yield* Fiber.join(later)).toEqual({ width: 1000, height: 600 });
      expect(yield* Fiber.join(outdated)).toBeUndefined();
      // So does a load during that read, which may have measured the page before it.
      desktopSizeAnswer = heldAnswer;
      const reloaded = yield* refill;
      const pageRead = yield* Queue.take(pending);
      const navigated = yield* startStatus;
      yield* Effect.promise(() => cdp.emitAsync("Page.loadEventFired"));
      desktopSizeAnswer = async () => answer(900, 560);
      pageRead.resolve(answer(1000, 600));
      expect(yield* Fiber.join(navigated)).toEqual({ width: 900, height: 560 });
      expect(yield* Fiber.join(reloaded)).toBeUndefined();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a stalled desktop viewer still gets its size, control and reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId, viewer, context, resize } = yield* openDesktopViewer;
      const output =
        viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
      // Ready once the sizes measured on attach and on a first resize both arrived.
      yield* resize(1920, 1080);
      expect(viewportSizes(yield* Queue.takeAll(viewer.output))).toEqual([
        "1920x1080",
        "1920x1080",
      ]);
      yield* Effect.promise(() => desktopDetachReady.promise);
      yield* viewer.input({ type: "takeControl" });
      context.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(".csv"),
        setFiles: vi.fn(async () => {}),
      });
      let chooser = yield* Queue.take(viewer.output);
      while (chooser._tag !== "fileChooser") chooser = yield* Queue.take(viewer.output);
      yield* Queue.clear(viewer.output);
      // A resize compacts a full backlog but keeps control, the open picker and
      // one-time notifications in order.
      yield* viewer.input({ type: "takeControl" });
      const notifications: Array<ServerBrowser.ServerBrowserViewerOutput> = [
        { _tag: "fileChooserClosed", id: "chooser-0" },
        { _tag: "popup", tabId: "popup-1" },
        { _tag: "download", id: "download-1", fileName: "report.csv", sizeBytes: 3 },
        { _tag: "clipboard", text: "copied" },
      ];
      for (const item of notifications) Queue.offerUnsafe(output, item);
      let acked = stallViewer(viewer);
      yield* resize(1000, 600);
      expect(yield* Queue.takeAll(viewer.output)).toEqual([
        chooser,
        ...notifications,
        expect.objectContaining({ _tag: "control", controller: "you" }),
        { _tag: "viewport", width: 1000, height: 600 },
      ]);
      yield* acked;
      // A control change keeps only the newest size.
      yield* resize(900, 500);
      yield* resize(1200, 700);
      acked = stallViewer(viewer);
      yield* viewer.input({ type: "releaseControl" });
      expect(yield* Queue.takeAll(viewer.output)).toEqual([
        expect.objectContaining({ _tag: "control", controller: "unclaimed" }),
        { _tag: "viewport", width: 1200, height: 700 },
      ]);
      yield* acked;
      // Notifications that no longer fit go oldest first, never the size.
      let copies = 0;
      while (Queue.offerUnsafe(output, { _tag: "clipboard", text: `copy ${copies}` })) copies++;
      yield* resize(1000, 600);
      const compacted = yield* Queue.takeAll(viewer.output);
      expect(compacted.at(0)).toEqual({ _tag: "clipboard", text: "copy 1" });
      expect(compacted.at(-1)).toEqual({ _tag: "viewport", width: 1000, height: 600 });
      // The desktop takes the page back; a resize after it cannot bury the reconnect.
      acked = stallViewer(viewer);
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId });
      yield* Effect.promise(() => desktopReleased.promise);
      yield* resize(1000, 600);
      expect(yield* Queue.takeAll(viewer.output)).toEqual([{ _tag: "reconnect" }]);
      yield* acked;
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("the tab the desktop shows is visible and picked for agents without a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      const openDesktopTab = Effect.fn("openDesktopTab")(function* (url: string) {
        desktopRendersNext = true;
        const opened = yield* manager.open({
          threadId: scope.thread.threadId,
          url,
          runtime: "server",
        });
        const tabId = PreviewTabId.make(opened.tabId);
        yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
        return tabId;
      });
      const recentTab = yield* openDesktopTab("http://localhost:5173/recent");
      const shownTab = yield* openDesktopTab("http://localhost:5173/shown");
      // Opened first and used last, so recency or insertion order alone picks it.
      yield* broker.invoke({ scope, tabId: recentTab, operation: "status", input: {} });

      shownDesktopTabs.add(shownTab);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        tabId: shownTab,
        visible: true,
        tabs: [
          expect.objectContaining({ tabId: recentTab, visible: false }),
          expect.objectContaining({ tabId: shownTab, visible: true }),
        ],
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "agents read a human's tab with no arguments and act on it only while nobody drives",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const opened = yield* manager.open({
          threadId: scope.thread.threadId,
          url: "http://localhost:5173/mine",
          runtime: "server",
        });
        const tabId = PreviewTabId.make(opened.tabId);
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
        });
        expect(status).toMatchObject({
          tabId,
          control: { owner: "human", ownedByCaller: false },
        });
        expect(status.tabs).toEqual([
          expect.objectContaining({ tabId, owner: "human", ownedByCaller: false, visible: true }),
        ]);
        const evaluated = yield* broker
          .invoke<void>({ scope, operation: "evaluate", input: { expression: "read()" } })
          .pipe(Effect.flip);
        expect(evaluated).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        const refused = yield* broker
          .invoke<void>({
            scope,
            tabId,
            operation: "navigate",
            input: { url: "http://localhost:5173/agent" },
          })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        yield* viewer.input({ type: "releaseControl" });
        const released = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(released.control).toMatchObject({ owner: "unclaimed", ownedByCaller: false });
        yield* broker.invoke({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/agent" },
        });
        expect(contexts[0]!.page.goto).toHaveBeenCalledWith(
          "http://localhost:5173/agent",
          expect.anything(),
        );
        yield* viewer.input({ type: "takeControl" });
        const retaken = yield* broker
          .invoke<void>({ scope, tabId, operation: "press", input: { key: "Enter" } })
          .pipe(Effect.flip);
        expect(retaken).toMatchObject({ reason: "humanControl" });
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("preview_open reports a tab it shows as visible once the client attaches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.yieldNow;
      // Like a real client, the stream attaches asynchronously after the reveal request arrives.
      yield* Effect.gen(function* () {
        let event;
        do event = yield* PubSub.take(events);
        while (event.type !== "navigated" || !event.snapshot.revealRequest);
        yield* browser.attachViewer(viewerInput(event.tabId, false)).pipe(Effect.forkScoped);
      }).pipe(Effect.forkScoped);

      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, open: true },
      });

      expect(opened.visible).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a session's own tab stays its default while other sessions' tabs are listed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const other = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabId).toBe(tabId);
      expect(status.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tabId, owner: "agent", ownedByCaller: true }),
          expect.objectContaining({ tabId: other.tabId, owner: "agent", ownedByCaller: false }),
        ]),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "preview_open picks a reported profile by id or name and defaults to the reported one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const reportProfiles = yield* browser.profileReporter;
        yield* reportProfiles({
          profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
          defaultProfileId: "profile-work",
        });
        const openWith = (profileId?: string) =>
          broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: {
              reuseExistingTab: false,
              show: false,
              ...(profileId === undefined ? {} : { profileId }),
            },
          });
        const byDefault = yield* openWith();
        const byName = yield* openWith("WORK");
        const byId = yield* openWith("incognito");
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        const profileOf = (tabId: string | null) =>
          sessions.find((session) => session.tabId === tabId)?.profileId;
        expect(profileOf(byDefault.tabId)).toBe("profile-work");
        expect(profileOf(byName.tabId)).toBe("profile-work");
        expect(profileOf(byId.tabId)).toBe("incognito");
        expect(contextRequests).toEqual([
          { profileId: "profile-work", isolated: false },
          { profileId: "profile-work", isolated: false },
          { profileId: "incognito", isolated: true },
        ]);
        expect(byDefault).toMatchObject({
          defaultProfileId: "profile-work",
          profiles: [
            { id: "default", name: "Default" },
            { id: "incognito", name: "Incognito", incognito: true },
            { id: "profile-work", name: "Work" },
          ],
        });
        const unknown = yield* openWith("Personal").pipe(Effect.flip);
        expect(unknown).toMatchObject({
          _tag: "PreviewAutomationExecutionError",
          reason:
            'No browser profile is named "Personal". Use one of: Default (id default), Incognito (id incognito), Work (id profile-work).',
        });
      }),
    ).pipe(Effect.provide(layer)),
);

// Holds the next profile save at its temp-file cleanup, after the rename, until released.
const gateSaveCleanup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cleanupStarted = yield* Deferred.make<void>();
  const releaseCleanup = yield* Deferred.make<void>();
  let paused = false;
  return {
    cleanupStarted,
    releaseCleanup,
    pauseNext: () => {
      paused = true;
    },
    fs: FileSystem.FileSystem.of({
      ...fs,
      remove: (target, options) =>
        fs.remove(target, options).pipe(
          Effect.tap(() => {
            if (!paused) return Effect.void;
            paused = false;
            return Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCleanup)),
            );
          }),
        ),
    }),
  };
});

it.effect(
  "an agent opens a reported profile after a restart, before any client reports again",
  () =>
    Effect.gen(function* () {
      const gate = yield* gateSaveCleanup;
      const persistent = (name: string) =>
        ({ id: `profile-${name.toLowerCase()}`, name, kind: "persistent" }) as const;
      // Together the two clients report more profiles than one report may hold.
      const fromA = [
        persistent("Work"),
        ...Array.from({ length: 12 }, (_, n) => persistent(`A${n}`)),
      ];
      const fromB = [
        persistent("Shared"),
        ...Array.from({ length: 12 }, (_, n) => persistent(`B${n}`)),
      ];
      yield* Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const clientA = yield* Scope.make();
        const reportFromA = yield* browser.profileReporter.pipe(
          Effect.provideService(Scope.Scope, clientA),
        );
        const reportFromB = yield* browser.profileReporter;
        const reportFromC = yield* browser.profileReporter;
        yield* reportFromA({ profiles: fromA, defaultProfileId: "profile-work" });
        gate.pauseNext();
        const savingB = yield* reportFromB({
          profiles: fromB,
          defaultProfileId: "profile-shared",
        }).pipe(Effect.forkScoped({ startImmediately: true }));
        // A save that ends without reaching the gate fails the test instead of hanging it.
        yield* Effect.raceFirst(
          Deferred.await(gate.cleanupStarted),
          Fiber.join(savingB).pipe(
            Effect.andThen(Effect.die("save finished before the cleanup gate")),
          ),
        );
        // C's save waits behind B's while the client that reported Work disconnects, as at shutdown.
        const savingC = yield* reportFromC({
          profiles: [],
          defaultProfileId: "profile-shared",
        }).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Scope.close(clientA, Exit.void);
        yield* Deferred.succeed(gate.releaseCleanup, undefined);
        yield* Fiber.join(savingB);
        yield* Fiber.join(savingC);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.fresh(ServerBrowser.layer).pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem, gate.fs)),
          ),
        ),
      );

      const restarted = yield* Effect.gen(function* () {
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* ServerBrowser.ServerBrowser;
        yield* Effect.yieldNow;
        return yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false, profileId: "Work" },
        });
      }).pipe(Effect.provide(Layer.fresh(ServerBrowser.layer)));

      expect(contextRequests).toEqual([{ profileId: "profile-work", isolated: false }]);
      expect(restarted.tabs).toMatchObject([{ profileId: "profile-work" }]);
      expect(restarted).toMatchObject({
        defaultProfileId: "profile-shared",
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito", incognito: true },
          ...[...fromA, ...fromB].map(({ id, name }) => ({ id, name })),
        ],
      });
    }).pipe(Effect.provide(dependencies)),
);

it.effect("warns at startup about a saved profile catalog it cannot read or decode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const savedPath = path.join(stateDir, "server-browser", "reported-profiles.json");
    const startupWarnings = (saved: "missing" | "empty" | "invalid" | "unreadable") =>
      Effect.gen(function* () {
        const messages: string[] = [];
        yield* fs.remove(savedPath, { recursive: true, force: true });
        yield* fs.makeDirectory(path.dirname(savedPath), { recursive: true });
        if (saved === "empty") yield* fs.writeFileString(savedPath, "");
        if (saved === "invalid") yield* fs.writeFileString(savedPath, "{");
        if (saved === "unreadable") yield* fs.makeDirectory(savedPath);
        const logger = Logger.make(({ message }) => {
          messages.push(String(message));
        });
        yield* ServerBrowser.ServerBrowser.pipe(
          Effect.provide(
            Layer.fresh(ServerBrowser.layer).pipe(
              Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
            ),
          ),
        );
        return messages.filter((message) => message.includes("saved browser profiles"));
      });

    expect(yield* startupWarnings("missing")).toEqual([]);
    expect(yield* startupWarnings("empty")).toEqual([]);
    expect(yield* startupWarnings("invalid")).toEqual([
      expect.stringContaining("ignoring invalid saved browser profiles"),
    ]);
    expect(yield* startupWarnings("unreadable")).toEqual([
      expect.stringContaining("failed to read saved browser profiles"),
    ]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("a report interrupted while an earlier save holds the lock is still saved", () =>
  Effect.gen(function* () {
    const gate = yield* gateSaveCleanup;
    const work = { id: "profile-work", name: "Work", kind: "persistent" } as const;
    const late = { id: "profile-late", name: "Late", kind: "persistent" } as const;
    yield* Effect.gen(function* () {
      const report = yield* (yield* ServerBrowser.ServerBrowser).profileReporter;
      gate.pauseNext();
      const saving = yield* report({ profiles: [work], defaultProfileId: "profile-work" }).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Effect.raceFirst(
        Deferred.await(gate.cleanupStarted),
        Fiber.join(saving).pipe(
          Effect.andThen(Effect.die("save finished before the cleanup gate")),
        ),
      );
      // The client disconnects while its report waits for the save in progress.
      const waiting = yield* report({
        profiles: [work, late],
        defaultProfileId: "profile-late",
      }).pipe(Effect.forkScoped({ startImmediately: true }));
      waiting.interruptUnsafe();
      yield* Deferred.succeed(gate.releaseCleanup, undefined);
      yield* Fiber.join(saving);
      yield* Fiber.await(waiting);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.fresh(ServerBrowser.layer).pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, gate.fs)),
        ),
      ),
    );

    const restarted = yield* Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      return yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false, profileId: "Late" },
      });
    }).pipe(Effect.provide(Layer.fresh(ServerBrowser.layer)));

    expect(restarted).toMatchObject({
      defaultProfileId: "profile-late",
      tabs: [{ profileId: "profile-late" }],
    });
  }).pipe(Effect.provide(dependencies)),
);

it.effect("profiles reported by one client survive another client's report", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker } = yield* ready;
      contextRequests.length = 0;
      const work = { id: "profile-work", name: "Work", kind: "persistent" } as const;
      const shared = { id: "profile-shared", name: "Shared", kind: "persistent" } as const;
      const openWork = () =>
        broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false, profileId: work.id },
        });
      const reportFromA = yield* browser.profileReporter;
      const clientB = yield* Scope.make();
      const reportFromB = yield* browser.profileReporter.pipe(
        Effect.provideService(Scope.Scope, clientB),
      );
      yield* reportFromA({ profiles: [work, shared], defaultProfileId: work.id });
      yield* reportFromB({ profiles: [shared], defaultProfileId: shared.id });
      expect(yield* openWork()).toMatchObject({
        defaultProfileId: shared.id,
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito", incognito: true },
          { id: work.id, name: work.name },
          { id: shared.id, name: shared.name },
        ],
      });
      expect(contextRequests).toEqual([{ profileId: work.id, isolated: false }]);
      yield* Scope.close(clientB, Exit.void);
      expect(yield* openWork()).toMatchObject({ defaultProfileId: work.id });
      yield* reportFromA({ profiles: [shared], defaultProfileId: shared.id });
      const removed = yield* openWork().pipe(Effect.flip);
      expect(removed).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        reason:
          'No browser profile is named "profile-work". Use one of: Default (id default), Incognito (id incognito), Shared (id profile-shared).',
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  { budget: "agent", limit: 8 },
  { budget: "server", limit: 32 },
])("opens and popups reserve the $budget budget before session creation", ({ budget, limit }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const open = (target = scope) =>
        broker.invoke<PreviewAutomationStatus>({
          scope: target,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
      for (let index = 1; index < limit - 3; index++) {
        yield* open(budget === "agent" ? scope : asSession(`other-${Math.floor(index / 8)}`));
      }

      const sessionGate = Promise.withResolvers<void>();
      const launchGate = (contextGate = Promise.withResolvers<void>());
      const sessionStarted = Promise.withResolvers<void>();
      const realOpen = manager.open;
      const delayedOpen = vi.spyOn(manager, "open").mockImplementation((input) =>
        Effect.promise(() => {
          sessionStarted.resolve();
          return sessionGate.promise;
        }).pipe(Effect.andThen(realOpen(input))),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          sessionGate.resolve();
          launchGate.resolve();
          delayedOpen.mockRestore();
        }),
      );
      const events = yield* manager.subscribeEvents;
      const first = yield* open().pipe(Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => sessionStarted.promise);
      const popup = makeContext();
      const resized = Promise.withResolvers<void>();
      const setViewportSize = popup.page.setViewportSize;
      popup.page.setViewportSize = vi.fn(async (size) => {
        await setViewportSize(size);
        if (size?.width === 900) resized.resolve();
      });
      const newCDPSession = popup.newCDPSession;
      popup.newCDPSession = async (target) => {
        await launchGate.promise;
        return newCDPSession(target);
      };
      contexts[0]!.page.emit("popup", popup.page);
      const last = yield* open().pipe(Effect.result, Effect.forkScoped);
      const overflow = yield* open().pipe(Effect.result, Effect.forkScoped);
      // The host processes this after the opens, while manager creation is blocked.
      const reused = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "open",
        input: { show: false },
      });
      expect(reused.tabId).toBe(tabId);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(
        limit - 3,
      );

      sessionGate.resolve();
      for (let count = 0; count < 3; count++) {
        let event = yield* PubSub.take(events);
        while (event.type !== "opened") event = yield* PubSub.take(events);
        yield* manager.resize({
          threadId: scope.thread.threadId,
          tabId: event.tabId,
          viewport: { _tag: "freeform", width: 900, height: 700 },
        });
      }
      // The same slots must stay reserved after publication, while pages are still opening.
      const duringLaunch = yield* open().pipe(Effect.result, Effect.forkScoped);
      const rejectedPopup = makeContext();
      contexts[0]!.page.emit("popup", rejectedPopup.page);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      launchGate.resolve();

      expect((yield* Fiber.join(first))._tag).toBe("Success");
      expect((yield* Fiber.join(last))._tag).toBe("Success");
      for (const fiber of [overflow, duringLaunch]) {
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PreviewAutomationControlInterruptedError", reason: "tabLimit" },
        });
      }
      yield* Effect.promise(() => resized.promise);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      for (const session of sessions)
        yield* browser.attachViewer(viewerInput(session.tabId, false));
      expect(sessions).toHaveLength(limit);
      expect(popup.page.isClosed()).toBe(false);
      expect(rejectedPopup.page.isClosed()).toBe(true);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toHaveLength(limit);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("failed session and browser launches release capacity, as does closing a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const open = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      for (let count = 1; count < 7; count++) yield* open;
      const failSession = vi
        .spyOn(manager, "open")
        .mockImplementationOnce(() => Effect.die(new Error("session creation failed")));
      yield* Effect.addFinalizer(() => Effect.sync(() => failSession.mockRestore()));
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      failSession.mockRestore();
      const events = yield* manager.subscribeEvents;
      contextFailure = new Error("Chromium launch failed");
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      let failedSession = yield* PubSub.take(events);
      while (failedSession.type !== "opened") failedSession = yield* PubSub.take(events);
      // A failed launch must not leave a session a viewer can relaunch past the budget.
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(7);
      contextFailure = null;
      pageSetupFailure = new Error("Target page, context or browser has been closed");
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      pageSetupFailure = null;
      // Setup that fails after the page exists must not leave the page or its context open.
      expect(contexts.at(-1)!.close).toHaveBeenCalled();
      expect(contexts.at(-1)!.page.isClosed()).toBe(true);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(7);
      expect((yield* open).available).toBe(true);
      expect(yield* open.pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(
        yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(failedSession.tabId),
            operation: "open",
            input: { show: false },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "PreviewAutomationTabNotFoundError" });
      const browser = yield* ServerBrowser.ServerBrowser;
      expect(
        yield* browser.attachViewer(viewerInput(failedSession.tabId, false)).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerBrowserTabNotFoundError" });
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      expect((yield* open).available).toBe(true);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toHaveLength(8);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a full server takes back the slot of the longest idle agent tab nobody views", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      const now = vi.spyOn(Date, "now").mockReturnValue(0);
      yield* Effect.addFinalizer(() => Effect.sync(() => now.mockRestore()));
      const open = (providerSessionId: string) => {
        desktopRendersNext = true;
        return broker.invoke<PreviewAutomationStatus>({
          scope: asSession(providerSessionId),
          operation: "open",
          input: { reuseExistingTab: false, open: false },
        });
      };
      const opened: Array<string> = [];
      for (let index = 0; index < 32; index++) {
        now.mockReturnValue(index);
        opened.push((yield* open(`agent-${Math.floor(index / 8)}`)).tabId!);
      }

      now.mockReturnValue(100);
      yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-observer"),
        operation: "status",
        tabId: PreviewTabId.make(opened[0]!),
        input: {},
      });

      // Inside the idle window every desktop tab keeps its slot.
      now.mockReturnValue(29 * 60 * 1000);
      expect(yield* open("agent-new").pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(releasedDesktopTabs).toEqual([]);

      now.mockReturnValue(31 * 60 * 1000);
      // A session at its own limit couldn't use a freed slot, so nothing closes for it.
      expect(yield* open("agent-3").pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(releasedDesktopTabs).toEqual([]);
      // Tabs a desktop window shows keep their slots however long they sit idle.
      for (const tabId of opened) shownDesktopTabs.add(tabId);
      expect(yield* open("agent-new").pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(releasedDesktopTabs).toEqual([]);
      shownDesktopTabs.clear();
      shownDesktopTabs.add(opened[1]!);
      const events = yield* manager.subscribeEvents;
      const releases = yield* Queue.unbounded<string>();
      const recordRelease = (tabId: string) => Queue.offerUnsafe(releases, tabId);
      desktopDetaches.on("release", recordRelease);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => desktopDetaches.off("release", recordRelease)),
      );
      const fresh = yield* open("agent-new");
      expect(fresh.tabId).toBeDefined();
      expect(yield* Queue.take(releases)).toBe(opened[2]);
      yield* Stream.fromSubscription(events).pipe(
        Stream.filter((event) => event.type === "closed" && event.tabId === opened[2]),
        Stream.runHead,
      );
      expect(releasedDesktopTabs).toEqual([opened[2]]);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId).toSorted()).toEqual(
        [...opened.filter((tabId) => tabId !== opened[2]), fresh.tabId!].toSorted(),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

const certificateError = {
  url: "https://device.local/",
  code: -202,
  description: "ERR_CERT_AUTHORITY_INVALID",
};
const dataUrl = `data:text/html,${"PAYLOAD".repeat(300)}`;

it.effect("reports why a page failed to load while the tab shows the error page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const request = {
        url: () => certificateError.url,
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_CERT_AUTHORITY_INVALID" }),
      };
      const status = () =>
        broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
      const snapshot = () =>
        broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
      expect(yield* status()).not.toHaveProperty("loadError");
      expect(yield* snapshot()).not.toHaveProperty("loadError");
      page.emit("request", request);
      page.emit("requestfailed", request);
      page.url = () => "chrome-error://chromewebdata/";
      expect(yield* status()).toMatchObject({
        url: certificateError.url,
        loadError: certificateError,
      });
      expect(yield* snapshot()).toMatchObject({
        url: certificateError.url,
        loadError: certificateError,
      });

      const subframeRequest = {
        ...request,
        url: () => "https://frame.local/",
        frame: () => ({}),
      };
      page.emit("request", subframeRequest);
      page.emit("requestfailed", subframeRequest);
      expect(yield* status()).toMatchObject({
        url: certificateError.url,
        loadError: certificateError,
      });

      // Clearing must happen before the next navigation replaces the error page.
      page.emit("request", { ...request, url: () => "https://device.local/login" });
      expect(yield* status()).not.toHaveProperty("loadError");
      expect(yield* snapshot()).not.toHaveProperty("loadError");

      const dataRequest = { ...request, url: () => dataUrl };
      page.emit("request", dataRequest);
      page.emit("requestfailed", dataRequest);
      expect((yield* status()).loadError?.url).toBe("data:text/html,…");
      initialNavigation = async () => {
        page.emit("request", request);
        page.emit("requestfailed", request);
      };
      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: certificateError.url },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        reason: `Navigation to ${certificateError.url} failed: ${certificateError.description}`,
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("preview_open rejects a desktop navigation that failed before automation attached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const channel = yield* DesktopChannel.DesktopBrowserChannel;
      desktopRendersNext = true;
      desktopPageUrl = "chrome-error://chromewebdata/";
      const failure = {
        ...certificateError,
        url: "https://user:secret@device.local/?token=private#fragment",
      };
      using _failure = vi.spyOn(channel, "loadFailure").mockReturnValue(failure);
      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { url: failure.url, reuseExistingTab: false, open: false },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        reason: `Navigation to ${certificateError.url} failed: ${certificateError.description}`,
      });
      expect(JSON.stringify(error)).not.toMatch(/secret|private|fragment/);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId)).toEqual([tabId]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("reports a desktop tab's load failure from before the server connected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      desktopLoadFailures.set(opened.tabId, certificateError);
      yield* browser.attachViewer(viewerInput(opened.tabId, false));
      const page = desktopConnections[0]!.context.page;
      page.url = () => "chrome-error://chromewebdata/";
      const status = () =>
        broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
          tabId: PreviewTabId.make(opened.tabId),
        });
      const snapshot = () =>
        broker.invoke<PreviewAutomationSnapshot>({
          scope,
          operation: "snapshot",
          input: {},
          tabId: PreviewTabId.make(opened.tabId),
        });
      expect(yield* status()).toMatchObject({
        url: certificateError.url,
        loadError: certificateError,
      });
      expect(yield* snapshot()).toMatchObject({
        url: certificateError.url,
        loadError: certificateError,
      });
      desktopLoadFailures.set(opened.tabId, { ...certificateError, url: dataUrl });
      expect((yield* status()).loadError?.url).toBe("data:text/html,…");
      // A navigation the server sees supersedes it, even before the error page goes.
      page.emit("request", {
        url: () => "https://device.local/retry",
        isNavigationRequest: () => true,
        frame: () => page,
      });
      expect(yield* status()).not.toHaveProperty("loadError");
      expect(yield* snapshot()).not.toHaveProperty("loadError");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a popup opens in its opener's appearance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        runtime: "server",
        colorScheme: "dark",
      });
      yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const events = yield* manager.subscribeEvents;
      contexts[0]!.page.emit("popup", makeContext().page);
      let event = yield* PubSub.take(events);
      while (event.type !== "opened") event = yield* PubSub.take(events);
      expect(event.snapshot.colorScheme).toBe("dark");
    }),
  ).pipe(Effect.provide(layer)),
);
