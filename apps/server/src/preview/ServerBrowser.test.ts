import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Playwright download mocks perform real file operations outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import {
  type BrowserRecordingFrameRate,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async scratchPage() {
      return makeEncoderPage() as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext();
      context.page.viewportSize.mockReturnValue(null);
      desktopConnections.push({ endpoint, context });
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
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
    off: vi.fn((name: string, callback: (...args: unknown[]) => void) =>
      events.off(name, callback),
    ),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      // Snapshots shrink their screenshot in the page; the header stands in for the result.
      if (method === "Runtime.callFunctionOn") return { result: { value: PNG_HEADER } };
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main", loaderId: axLoader } } };
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: axNodes };
      if (method === "DOM.describeNode") {
        const { backendNodeId } = input as { backendNodeId: number };
        return {
          node: { nodeName: "INPUT", attributes: backendNodeId === 30 ? ["type", "password"] : [] },
        };
      }
      if (method === "DOM.resolveNode") {
        return {
          object: { objectId: `node-${(input as { backendNodeId: number }).backendNodeId}` },
        };
      }
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
      if (method === "Input.dispatchKeyEvent" && (input as { commands?: unknown }).commands) {
        if (focusedFrame) focusedFrame.copy = keyCopy || focusedFrame.copy;
        else pageCopy = keyCopy || pageCopy;
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

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "about:blank";
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
          element: () => ({ getAttribute: async () => ".csv" }),
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
    title: vi.fn(async () => "test page"),
    viewportSize: vi.fn(() => viewport),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "delete",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
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
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

// Runs the real encoder script against fake canvas and MediaRecorder globals.
function makeEncoderPage() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {}, fillRect() {} }),
    captureStream: (frameRate?: number) => ({ frameRate, getTracks: () => [] }),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    onstart: (() => void) | null = null;
    constructor(stream: { frameRate?: number }, options: { videoBitsPerSecond: number }) {
      encoderStreams.push({
        frameRate: stream.frameRate,
        bitsPerSecond: options.videoBitsPerSecond,
      });
    }
    start() {
      this.onstart?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: () => canvas },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: async () => ({ width: 1280, height: 800, close() {} }),
    atob,
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
const encoderStreams: Array<{ frameRate: number | undefined; bitsPerSecond: number }> = [];
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextFailure: Error | null = null;
let axLoader = "loader-1";
let axNodes: Array<Record<string, unknown>> = [];
let initialNavigation: (() => Promise<void>) | null = null;
let desktopRendersNext = false;
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
const releasedDesktopTabs: Array<string> = [];
const desktopTurns = new NodeEvents.EventEmitter();
const desktopConnections: Array<{ endpoint: string; context: ReturnType<typeof makeContext> }> = [];
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
    awaitAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
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
    endpoint: (key) =>
      Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
        Effect.sync(() => {
          releasedDesktopTabs.push(key.tabId);
          desktopReleased.resolve();
        }),
      ),
    pointer: () => Effect.void,
    turn: (threadId, active) => Effect.sync(() => desktopTurns.emit("turn", threadId, active)),
  }),
  PreviewAgentActivity.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-browser-" })),
  Layer.provideMerge(NodeServices.layer),
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
  encoderStreams.length = 0;
  contextRequests.length = 0;
  contextGate = null;
  contextFailure = null;
  initialNavigation = null;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  axLoader = "loader-1";
  axNodes = pageTree();
  desktopTabs.clear();
  desktopRendersNext = false;
  desktopSizeAnswer = null;
  desktopDetachReady = Promise.withResolvers<void>();
  desktopReleased = Promise.withResolvers<void>();
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
});

it.live("tells the desktop once per thread when its agent turns start and end", () =>
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

it.live("preview_open reports its navigation timeout instead of the request budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
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
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["desktop" as const, undefined])(
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

it.live.each([
  { method: "goto" as const, message: { type: "navigate", url: "http://10.255.255.1/" } },
  { method: "goBack" as const, message: { type: "history", delta: -1 } },
  { method: "goForward" as const, message: { type: "history", delta: 1 } },
  { method: "reload" as const, message: { type: "reload" } },
])("a pending viewer $method allows a corrected URL and text input", ({ method, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
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
      const typed = Promise.withResolvers<void>();
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") typed.resolve();
        return send(operation, input);
      });
      const correction = yield* Effect.gen(function* () {
        yield* viewer.input({ type: "navigate", url: "http://localhost:5173/fixed" });
        yield* viewer.input({ type: "text", text: "hello" });
      }).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      // The text reaches the page while the first navigation is still uncommitted.
      yield* Effect.promise(() => typed.promise);
      expect(page.goto).toHaveBeenLastCalledWith(
        "http://localhost:5173/fixed",
        expect.objectContaining({ waitUntil: "commit" }),
      );
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "hello",
      });
      committed.resolve();
      yield* Fiber.join(navigation);
      yield* Fiber.join(correction);
    }),
  ).pipe(Effect.provide(layer)),
);

// The fake encoder decodes every frame at 1280x800, so 30 fps hits the bitrate floor.
it.live.each([
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
        for (const recordingFrameRate of reports) {
          yield* browser.reportProfiles({
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

it.live("enforces provider ownership and explicit targets when a session has multiple tabs", () =>
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
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("streams to a read-only viewer without allowing takeover, input, or viewport changes", () =>
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
      const outputs = yield* Queue.takeAll(viewer.output);
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

it.live(
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

it.live("reports a pending dialog without evaluating the page and resolves it explicitly", () =>
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

it.live("a tab opened to a file the browser cannot show reports the file to download", () =>
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

it.live(
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

it.live("only the controlling viewer's copy and cut keys reach its clipboard", () =>
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

it.live.each([false, true])(
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

it.live.each(["save failed", "oversized"])(
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

it.live("a page's file picker goes to the controller and takes its uploaded files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => ".csv" }),
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

it.live("only the current controller can answer a file picker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      contexts[0]!.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => "" }),
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
        element: () => ({ getAttribute: async () => ".csv" }),
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

it.live("agents read a human's tab with no arguments and act on it only while nobody drives", () =>
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

it.live("a session's own tab stays its default while other sessions' tabs are listed", () =>
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

it.live(
  "preview_open picks a reported profile by id or name and defaults to the reported one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        yield* browser.reportProfiles({
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

const axNode = (
  nodeId: string,
  role: string,
  extra: Record<string, unknown> = {},
  childIds: Array<string> = [],
) => ({
  nodeId,
  ignored: false,
  role: { value: role },
  childIds,
  ...extra,
  ...(typeof extra.name === "string" ? { name: { value: extra.name } } : {}),
});
const pageTree = () => [
  axNode("1", "RootWebArea", { name: "Shop" }, ["2", "3", "4", "5"]),
  axNode("2", "heading", {
    backendDOMNodeId: 10,
    properties: [{ name: "level", value: { value: 1 } }],
    name: "Cart",
  }),
  axNode("3", "button", { backendDOMNodeId: 20, name: "Checkout" }),
  {
    ...axNode("4", "textbox", { backendDOMNodeId: 30, name: "Password" }),
    value: { value: "hunter2" },
  },
  { ...axNode("5", "generic", {}, ["6"]), ignored: true },
  axNode("6", "StaticText", { name: "Under an ignored wrapper" }),
];
const accessibilitySession = () =>
  contexts[0]!.sessions.findLast((session) =>
    session.send.mock.calls.some(([method]) => method === "Accessibility.enable"),
  )!;
const takeAccessibility = Effect.fn(function* (viewer: ServerBrowser.ServerBrowserViewer) {
  for (;;) {
    const output = yield* Queue.take(viewer.output);
    if (output._tag === "accessibility" || output._tag === "accessibilityNotice") return output;
  }
});

it.live("a read-only viewer reads the page's semantics but cannot act through them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const reader = yield* browser.attachViewer(viewerInput(tabId, false));
      expect(
        contexts[0]!.sessions.some((session) =>
          session.send.mock.calls.some(([method]) => method.startsWith("Accessibility.")),
        ),
      ).toBe(false);
      yield* reader.accessibility(true);
      const shown = yield* takeAccessibility(reader);
      expect(shown).toMatchObject({
        _tag: "accessibility",
        document: {
          document: expect.stringContaining("loader-1"),
          truncated: false,
          root: {
            role: "document",
            name: "Shop",
            children: [
              { role: "heading", name: "Cart", level: 1 },
              { role: "button", name: "Checkout" },
              { role: "textbox", name: "Password", protected: true },
              { role: "text", name: "Under an ignored wrapper" },
            ],
          },
        },
      });
      expect(JSON.stringify(shown)).not.toContain("hunter2");
      const document = shown._tag === "accessibility" ? shown.document! : null;
      const button = document!.root.children![1]!;
      yield* reader.input({
        type: "accessibilityAction",
        document: document!.document,
        node: button.id,
        action: "activate",
      });
      const session = accessibilitySession();
      expect(session.send.mock.calls.some(([method]) => method === "Runtime.callFunctionOn")).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the controller's current-document actions reach the page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const operator = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* operator.accessibility(true);
      const shown = yield* takeAccessibility(operator);
      const document = shown._tag === "accessibility" ? shown.document! : null;
      const [, button, password] = document!.root.children!;
      const act = (action: Record<string, unknown>) =>
        operator.input({ type: "accessibilityAction", document: document!.document, ...action });

      yield* act({ node: button!.id, action: "activate" });
      expect(yield* takeAccessibility(operator)).toEqual({
        _tag: "accessibilityNotice",
        message: "Take control of the browser to use the page.",
      });
      const session = accessibilitySession();
      expect(session.send.mock.calls.some(([method]) => method === "Runtime.callFunctionOn")).toBe(
        false,
      );

      yield* operator.input({ type: "takeControl" });
      yield* act({ node: button!.id, action: "activate" });
      expect(session.send).toHaveBeenCalledWith(
        "Runtime.callFunctionOn",
        expect.objectContaining({ objectId: "node-20", userGesture: true }),
      );
      yield* act({ node: password!.id, action: "setValue", value: "s3cret", submit: true });
      expect(session.send).toHaveBeenCalledWith("DOM.focus", { backendNodeId: 30 });
      expect(session.send).toHaveBeenCalledWith("Input.insertText", { text: "s3cret" });
      expect(session.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ type: "keyDown", key: "Enter" }),
      );
      session.send.mockClear();

      yield* act({ node: "0.404", action: "activate" });
      expect(yield* takeAccessibility(operator)).toMatchObject({
        message: "The page changed. Try again.",
      });
      yield* act({ node: password!.id, action: "activate" });
      expect(yield* takeAccessibility(operator)).toMatchObject({
        message: "That item cannot be activated.",
      });
      contexts[0]!.page.emit("framenavigated", contexts[0]!.page);
      yield* act({ node: button!.id, action: "activate" });
      expect(yield* takeAccessibility(operator)).toMatchObject({
        message: "The page changed. Try again.",
      });
      expect(session.send.mock.calls.some(([method]) => method === "Runtime.callFunctionOn")).toBe(
        false,
      );
      yield* operator.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("turning the view off or leaving releases the Accessibility domain and its session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      yield* viewer.accessibility(true);
      const first = yield* takeAccessibility(viewer);
      const session = accessibilitySession();

      yield* viewer.accessibility(false);
      expect(yield* takeAccessibility(viewer)).toEqual({ _tag: "accessibility", document: null });
      expect(session.send).toHaveBeenCalledWith("Accessibility.disable");
      expect(session.detach).toHaveBeenCalled();

      // A new document replaces the old one wholesale, including removed nodes.
      axLoader = "loader-2";
      axNodes = pageTree().filter((node) => node.nodeId !== "3");
      axNodes[0] = { ...axNodes[0]!, childIds: ["2", "4", "5"] };
      yield* viewer.accessibility(true);
      const second = yield* takeAccessibility(viewer);
      const before = first._tag === "accessibility" ? first.document! : null;
      const after = second._tag === "accessibility" ? second.document! : null;
      expect(after!.document).not.toBe(before!.document);
      expect(after!.root.children!.map((node) => node.role)).toEqual([
        "heading",
        "textbox",
        "text",
      ]);

      const reopened = accessibilitySession();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const other = yield* browser.attachViewer(viewerInput(tabId, false));
          yield* other.accessibility(true);
          yield* takeAccessibility(other);
        }),
      );
      expect(reopened.send).not.toHaveBeenCalledWith("Accessibility.disable");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a viewer whose backlog is replaced still gets the page's semantics", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const operator = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* operator.accessibility(true);
      const session = contexts[0]!.sessions.find((each) =>
        each.on.mock.calls.some(([name]) => name === "Page.screencastFrame"),
      )!;
      // A stalled viewer: frames fill its queue behind the accepted document.
      for (let index = 0; index < 80; index += 1) {
        session.emit("Page.screencastFrame", { data: "ZnJhbWU=", sessionId: index });
      }
      yield* operator.input({ type: "takeControl" });
      const backlog = yield* Queue.takeAll(operator.output);
      expect(backlog.map((output) => output._tag)).toContain("control");
      expect(backlog.filter((output) => output._tag === "accessibility")).toEqual([
        expect.objectContaining({ document: expect.objectContaining({ version: 1 }) }),
      ]);
      yield* operator.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layer)),
);
