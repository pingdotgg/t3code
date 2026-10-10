import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

// Keep the manager, broker, ownership, refs, and viewer paths real; replace Chromium I/O only.
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
      return makeContext().page as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext();
      context.page.viewportSize.mockReturnValue(null);
      // A hidden `<webview>` measures 0x0 until it is shown.
      if (desktopHiddenNext) Object.assign(context.cssViewport, { width: 0, height: 0 });
      desktopConnections.push({ endpoint, context });
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeSession(viewport: { width: number; height: number }) {
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
      if (method === "Page.captureScreenshot") return { data: "ZnJhbWU=" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (
        method === "Runtime.evaluate" &&
        typeof input === "object" &&
        input !== null &&
        "contextId" in input &&
        input.contextId === 7
      )
        return { result: { value: { ...viewport } } };
      return { result: { value: "evaluated" } };
    }),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
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
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: vi.fn(() => viewport),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
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
    exposeBinding: vi.fn(async (_name: string, binding: ClipboardBinding) => {
      clipboardBinding = binding;
    }),
    addInitScript: vi.fn(async () => {}),
    newCDPSession: async () => {
      const session = makeSession(cssViewport);
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

const contexts: ReturnType<typeof makeContext>[] = [];
/** The profile and isolation each headless tab asked its context for. */
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
type ClipboardBinding = (source: { page: unknown }, text: unknown) => void;
let clipboardBinding: ClipboardBinding | null = null;
let contextFailure: Error | null = null;
/** Server tabs the fake desktop renders, and the endpoints the server connected to. */
let desktopRendersNext = false;
let desktopHiddenNext = false;
/** Pages the fake desktop takes back or returns; the channel's streams emit them. */
const desktopDetaches = new NodeEvents.EventEmitter();
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
const releasedDesktopTabs: Array<string> = [];
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
/** The same thread, as another of its agent sessions. */
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
    // Only tabs a test marks render on the desktop; the rest stay headless.
    available: true,
    awaitAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onDetach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("detach", onDetach);
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
        Effect.sync(() => releasedDesktopTabs.push(key.tabId)),
      ),
    pointer: () => Effect.void,
  }),
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
/** Fills a viewer's output the way a viewer that stopped reading leaves it. */
const stallViewer = (
  viewer: ServerBrowser.ServerBrowserViewer,
  item: ServerBrowser.ServerBrowserViewerOutput,
) => {
  // The service hands out the read side of a queue it also writes to.
  const output = viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
  while (Queue.offerUnsafe(output, item));
};
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});
/** Waits for a viewport. Pulling drains the queue, so it also discards what arrived with it. */
const nextViewerViewport = (viewer: ServerBrowser.ServerBrowserViewer) =>
  Stream.fromQueue(viewer.output).pipe(
    Stream.filter((item) => item._tag === "viewport"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

beforeEach(() => {
  contexts.length = 0;
  contextRequests.length = 0;
  contextGate = null;
  contextFailure = null;
  desktopTabs.clear();
  desktopRendersNext = false;
  desktopHiddenNext = false;
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
});

it.live("readiness none responds immediately but takeover input waits for navigation commit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const committed = Promise.withResolvers<void>();
      const events: string[] = [];
      contexts[0]!.page.goto.mockImplementationOnce(async () => {
        await committed.promise;
        events.push("navigation committed");
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      const response = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/next", readiness: "none" },
      });
      expect(response.available).toBe(true);
      expect(events).toEqual([]);
      yield* Queue.clear(viewer.output);
      const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller !== "you") {
        control = yield* Queue.take(viewer.output);
      }
      const cdp = contexts[0]!.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") events.push("human typed");
        return send(operation, input);
      });
      const typing = yield* viewer.input({ type: "text", text: "hello" }).pipe(Effect.forkScoped);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      expect(events).toEqual([]);
      committed.resolve();
      yield* Fiber.join(takeover);
      yield* Fiber.join(typing);
      expect(events).toEqual(["navigation committed", "human typed"]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  { method: "goto" as const, message: { type: "navigate", url: "http://localhost:5173/next" } },
  { method: "goBack" as const, message: { type: "history", delta: -1 } },
  { method: "goForward" as const, message: { type: "history", delta: 1 } },
  { method: "reload" as const, message: { type: "reload" } },
])("release waits for viewer $method to commit before agent actions", ({ method, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* Queue.clear(viewer.output);
      const started = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const events: string[] = [];
      contexts[0]!.page[method].mockImplementationOnce(async () => {
        started.resolve();
        await committed.promise;
        events.push("navigation committed");
      });
      const navigate = yield* viewer.input(message).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      yield* Effect.promise(() => started.promise);
      const releasing = yield* viewer.input({ type: "releaseControl" }).pipe(Effect.forkScoped);
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller !== "agent") {
        control = yield* Queue.take(viewer.output);
      }
      const cdp = contexts[0]!.sessions[0]!;
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Runtime.evaluate") events.push("agent acted");
        return send(operation, input);
      });
      const resumed = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "resumed()" },
        })
        .pipe(Effect.forkScoped);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      expect(events).toEqual([]);
      committed.resolve();
      yield* Fiber.join(navigate);
      yield* Fiber.join(releasing);
      yield* Fiber.join(resumed);
      expect(events).toEqual(["navigation committed", "agent acted"]);
      const calls = contexts[0]!.page[method].mock.calls;
      expect(calls[0]?.at(-1)).toMatchObject({ waitUntil: "commit", timeout: 15_000 });
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
      // Another session may still read the tab, but not run page script in it.
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

it.live("applies any client's viewport, appearance, and zoom to a headless tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const page = contexts[0]!.page;
      const session = contexts[0]!.sessions[0]!;
      const target = { threadId: scope.thread.threadId, tabId };
      // The agent owns this tab, and the client sends no takeover first.
      yield* manager.resize({ ...target, viewport: { _tag: "freeform", width: 390, height: 844 } });
      yield* manager.adjust({ ...target, colorScheme: "dark", zoomFactor: 1.25 });
      // Settings apply in order, so the reload landing means the earlier ones did too.
      const reloaded = Promise.withResolvers<void>();
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method === "Page.reload") reloaded.resolve();
        return send(method, input);
      });
      yield* manager.adjust({ ...target, hardReload: true });
      yield* Effect.promise(() => reloaded.promise);
      expect(session.send).toHaveBeenCalledWith("Page.reload", { ignoreCache: true });
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
      expect(page.emulateMedia).toHaveBeenCalledWith({ colorScheme: "dark" });
      // Zoom lays the page out in fewer CSS pixels and draws each one larger.
      expect(session.send).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
        width: 312,
        height: 675,
        deviceScaleFactor: 2.5,
        mobile: false,
      });
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

it.live("the owner can close a tab while an agent action waits on its dialog", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<Record<string, unknown>>();
      contexts[0]!.sessions[0]!.send.mockImplementationOnce(async () => {
        started.resolve();
        return finish.promise;
      });
      page.on("close", () => finish.resolve({ result: { value: "closed" } }));
      const running = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => finish.resolve({ result: { value: "cleanup" } })),
      );
      yield* Effect.promise(() => started.promise);
      page.emit("dialog", {
        type: () => "confirm",
        message: () => "Delete?",
        defaultValue: () => "",
        accept: vi.fn(),
        dismiss: vi.fn(),
      });
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "close",
          input: {},
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(page.close).not.toHaveBeenCalled();
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      expect(yield* Fiber.join(running)).toBe("closed");
      expect(page.close).toHaveBeenCalled();
      const manager = yield* Manager.PreviewManager;
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(0);
      const afterClose = yield* broker
        .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "late()" } })
        .pipe(Effect.flip);
      expect(afterClose._tag).toBe("PreviewAutomationTabNotFoundError");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a popup becomes the agent's own tab and keeps its opener page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const opener = contexts[0]!.page;
      const popup = makeContext();
      opener.emit("popup", popup.page);
      const manager = yield* Manager.PreviewManager;
      let sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
      while (sessions.length < 2) {
        yield* Effect.sleep("5 millis");
        sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
      }
      const popupTab = sessions.find((session) => session.tabId !== tabId)!;
      const opened = sessions.find((session) => session.tabId === tabId)!;
      expect(popupTab).toMatchObject({ automationOwner: opened.automationOwner, reveal: false });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tabId }),
          expect.objectContaining({ tabId: popupTab.tabId, openerTabId: tabId }),
        ]),
      );
      expect(opener.goto).not.toHaveBeenCalled();
      expect(opener.close).not.toHaveBeenCalled();
      // The page the popup script holds is the tab, so closing it ends the tab.
      yield* Effect.promise(() => popup.page.close());
      while ((yield* manager.list({ threadId: scope.thread.threadId })).sessions.length > 1) {
        yield* Effect.sleep("5 millis");
      }
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
      // What Chromium reports when a navigation turns into a download.
      page.emit("requestfailed", {
        ...request,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
      // Stands in for Chromium, which writes the file itself.
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
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
      let status = yield* PubSub.take(events);
      while (status.type !== "failed") status = yield* PubSub.take(events);
      expect(status).toMatchObject({ url: pdf, download: { fileName: "paper.pdf" } });
      // The tab shows the file, so no separate download toast is offered.
      expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "download")).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a file a blank tab opened is offered to download if the tab moves on while it saves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const navigation = {
        url: () => pdf,
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      page.emit("request", navigation);
      page.emit("requestfailed", navigation);
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      // The person navigates elsewhere while the file is still being written.
      page.emit("request", {
        url: () => "https://example.com/next",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
      });
      written.resolve();
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ _tag: "download", fileName: "paper.pdf" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a download from a superseded navigation leaves the newer navigation loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const navigation = {
        url: () => pdf,
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      page.emit("request", navigation);
      page.emit("requestfailed", navigation);
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      // The person navigates elsewhere while the file is still being written.
      page.emit("request", {
        url: () => "https://example.com/next",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
      });
      written.resolve();
      const status = () =>
        broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
      while ((yield* status()).downloads?.length !== 1) yield* Effect.sleep("5 millis");
      expect((yield* status()).loading).toBe(true);
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

it.live("an aborted navigation that no download explains stops loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const navigation = {
        url: () => "https://example.com/cancelled",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      const status = () =>
        broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        page.emit("request", navigation);
        page.emit("requestfailed", navigation);
        expect((yield* status()).loading).toBe(true);
        vi.advanceTimersByTime(5_000);
      } finally {
        vi.useRealTimers();
      }
      expect((yield* status()).loading).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a popup from a person's click is shown to that person, with its opener kept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const watcher = yield* browser.attachViewer(viewerInput(opened.tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const opener = contexts[0]!.page;
      const popup = makeContext();
      opener.emit("popup", popup.page);
      let shown = yield* Queue.take(viewer.output);
      while (shown._tag !== "popup") shown = yield* Queue.take(viewer.output);
      const sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
      expect(sessions.map((session) => session.tabId)).toEqual(
        expect.arrayContaining([opened.tabId, shown.tabId]),
      );
      expect((yield* Queue.clear(watcher.output)).some((item) => item._tag === "popup")).toBe(
        false,
      );
      expect(opener.close).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("closing a tab while a viewer is still opening it does not leave its page behind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      // The background open fails, so the tab exists only as a session.
      contextFailure = new Error("first launch failed");
      const snapshot = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      yield* Effect.sleep("10 millis");
      contextFailure = null;
      contextGate = Promise.withResolvers<void>();
      const attaching = yield* browser
        .attachViewer(viewerInput(snapshot.tabId, false))
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.sleep("10 millis");
      yield* manager.close({ threadId: scope.thread.threadId, tabId: snapshot.tabId });
      yield* Effect.sleep("10 millis");
      contextGate.resolve();
      expect((yield* Fiber.join(attaching))._tag).toBe("ServerBrowserTabNotFoundError");
      expect(contexts).toHaveLength(1);
      expect(contexts[0]!.page.close).toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("page copies reach only the controlling viewer right after its input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const clipboard = (queue: typeof viewer.output) =>
        Queue.clear(queue).pipe(
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      // A page writing on its own, without a recent gesture, stays on the server.
      clipboardBinding!({ page }, "unprompted");
      expect(yield* clipboard(viewer.output)).toEqual([]);
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      const cdp = contexts[0]!.sessions.at(-1)!;
      expect(cdp.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      clipboardBinding!({ page }, "copied");
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
      expect(yield* clipboard(watcher.output)).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a page download is saved, offered to the controller, and listed for the agent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* Queue.clear(viewer.output);
      // Stands in for Chromium, which writes the file itself.
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "report.csv",
        url: () => "blob:http://localhost:5173/1",
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Queue.take(saved);
      yield* fs.writeFileString(path, "a,b");
      written.resolve();
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ _tag: "download", fileName: "report.csv", sizeBytes: 3 });
      const file = yield* browser.openDownload({
        threadId: scope.thread.threadId,
        tabId,
        downloadId: offered.id,
      });
      expect(Option.isSome(file) && file.value.fileName).toBe("report.csv");
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.downloads).toEqual([
        expect.objectContaining({ fileName: "report.csv", sizeBytes: 3 }),
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
      // A single-file input only receives the first file.
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([file("a.csv")]);
      let closed = yield* Queue.take(viewer.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
      expect(closed.id).toBe(offered.id);
      expect(yield* answer(offered.id)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a file picker survives replacement of a stalled viewer backlog", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string>();
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: () => accept.promise }),
        setFiles: async () => {},
      });
      // The viewer stopped reading: its output is full when the picker opens.
      yield* Queue.clear(viewer.output);
      stallViewer(viewer, { _tag: "frame", data: Buffer.alloc(0), ack: Effect.void });
      accept.resolve(".csv");
      // The picker is offered within the microtasks that follow its accept attribute.
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      const opened = yield* Queue.clear(viewer.output);
      expect(opened).toEqual([expect.objectContaining({ _tag: "fileChooser", accept: ".csv" })]);
      stallViewer(viewer, { _tag: "frame", data: Buffer.alloc(0), ack: Effect.void });
      yield* viewer.input({ type: "resize", width: 900, height: 600 });
      const resized = yield* Queue.takeAll(viewer.output);
      expect(resized).toHaveLength(2);
      expect(resized).toEqual(
        expect.arrayContaining([{ _tag: "viewport", width: 900, height: 600 }, opened[0]]),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("control updates replace a stalled viewer backlog in the order they happen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* Queue.clear(viewer.output);
      // Chromium is slow to take back the frames the replacement drops.
      const acked = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => acked.resolve()));
      stallViewer(viewer, {
        _tag: "frame",
        data: Buffer.alloc(0),
        ack: Effect.promise(() => acked.promise),
      });
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "releaseControl" });
      const controls = (yield* Queue.clear(viewer.output)).flatMap((item) =>
        item._tag === "control" ? [item.controller] : [],
      );
      expect(controls[0]).toBe("you");
      expect(controls.at(-1)).not.toBe("you");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a stalled viewer's backlog replacement keeps its other state and notifications", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* Queue.clear(viewer.output);
      const output =
        viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
      /** Fills the stalled backlog, sends input that replaces it, and returns what is left. */
      const replaceBacklog = (input: unknown) =>
        Effect.gen(function* () {
          // Chromium sends no new frames until each dropped one is acked.
          const acked = Promise.withResolvers<void>();
          let unacked = 0;
          const ack = Effect.sync(() => {
            if (--unacked === 0) acked.resolve();
          });
          while (Queue.offerUnsafe(output, { _tag: "frame", data: Buffer.alloc(0), ack }))
            unacked++;
          yield* viewer.input(input);
          yield* Effect.promise(() => acked.promise);
          return yield* Queue.takeAll(viewer.output);
        });
      // One-time notifications cannot be rebuilt from tab state.
      const notifications: Array<ServerBrowser.ServerBrowserViewerOutput> = [
        { _tag: "download", id: "download-1", fileName: "report.csv", sizeBytes: 3 },
        { _tag: "clipboard", text: "copied" },
        { _tag: "popup", tabId: "popup-1" },
        { _tag: "fileChooserClosed", id: "chooser-1" },
      ];
      for (const item of notifications) Queue.offerUnsafe(output, item);
      yield* viewer.input({ type: "takeControl" });
      const resized = yield* replaceBacklog({ type: "resize", width: 900, height: 600 });
      expect(resized).toHaveLength(2 + notifications.length);
      expect(resized).toEqual(
        expect.arrayContaining([
          { _tag: "viewport", width: 900, height: 600 },
          expect.objectContaining({ _tag: "control", controller: "you" }),
        ]),
      );
      expect(resized.filter((item) => notifications.includes(item))).toEqual(notifications);
      yield* viewer.input({ type: "resize", width: 640, height: 480 });
      const released = yield* replaceBacklog({ type: "releaseControl" });
      expect(released).toHaveLength(2);
      expect(released).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ _tag: "control", controller: "agent" }),
          { _tag: "viewport", width: 640, height: 480 },
        ]),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a closing tab still ends a stalled viewer whose backlog is all notifications", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* Queue.clear(viewer.output);
      stallViewer(viewer, {
        _tag: "download",
        id: "download-1",
        fileName: "report.csv",
        sizeBytes: 3,
      });
      contexts[0]!.page.emit("close");
      expect(yield* Queue.takeAll(viewer.output)).toContainEqual({ _tag: "gone" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an agent's tabs stop at the limit until an unwatched idle tab closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const open = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      for (let count = 1; count < 8; count += 1) yield* open;
      expect(yield* Effect.flip(open)).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabLimit",
      });
      // Another agent session keeps its own budget.
      yield* broker.invoke({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const later = (yield* Clock.currentTimeMillis) + 31 * 60 * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      // The first tab is watched, so it stays open while the agent's other idle tabs close.
      const browser = yield* ServerBrowser.ServerBrowser;
      yield* browser.attachViewer(viewerInput(tabId, false));
      const reopened = yield* open;
      const manager = yield* Manager.PreviewManager;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId).toSorted()).toEqual(
        [tabId, reopened.tabId].toSorted(),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an agent answers the page's file picker or sets files on a file input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const upload = (input: Record<string, unknown>) =>
        broker.invoke<void>({ scope, tabId, operation: "upload", input });
      expect(yield* Effect.flip(upload({ paths: ["/tmp/a.csv"] }))).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
      });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => ".csv" }),
        setFiles,
      });
      const status = broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      let opened = yield* status;
      while (!opened.fileChooser) {
        yield* Effect.sleep("5 millis");
        opened = yield* status;
      }
      expect(opened.fileChooser).toEqual({ multiple: false, accept: ".csv" });
      // A single-file picker rejects several files instead of dropping some.
      yield* Effect.flip(upload({ paths: ["/tmp/a.csv", "/tmp/b.csv"] }));
      yield* upload({ paths: ["/tmp/a.csv"] });
      expect(setFiles).toHaveBeenCalledExactlyOnceWith(["/tmp/a.csv"], expect.anything());
      expect((yield* status).fileChooser).toBeNull();

      const setInputFiles = vi.fn(async () => {});
      page.locator.mockReturnValue({ setInputFiles } as never);
      yield* upload({ paths: ["/tmp/b.csv"], locator: "input[type=file]" });
      expect(page.locator).toHaveBeenLastCalledWith("input[type=file]");
      expect(setInputFiles).toHaveBeenCalledWith(["/tmp/b.csv"], expect.anything());
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("viewers see the agent's pointer move to its target and click there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const click = vi.fn(async () => {});
      page.locator.mockReturnValue({
        scrollIntoViewIfNeeded: async () => {},
        boundingBox: async () => ({ x: 100, y: 40, width: 80, height: 20 }),
        click,
      } as never);
      yield* broker.invoke({ scope, tabId, operation: "click", input: { locator: "#go" } });
      const pointers = (yield* Queue.clear(viewer.output)).filter(
        (item) => item._tag === "pointer",
      );
      expect(pointers).toEqual([
        expect.objectContaining({ phase: "move", x: 140, y: 50 }),
        expect.objectContaining({ phase: "click", x: 140, y: 50 }),
      ]);
      expect(click).toHaveBeenCalledOnce();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("drives the desktop's own page for a tab the desktop renders", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      expect(desktopConnections.map((connection) => connection.endpoint)).toEqual([
        `ws://desktop/${opened.tabId}`,
      ]);
      // No headless context was launched for it.
      expect(contexts).toEqual([]);
      const page = desktopConnections[0]!.context.page;
      expect(page.viewportSize()).toBeNull();
      expect(yield* nextViewerViewport(viewer)).toEqual({
        _tag: "viewport",
        width: 1920,
        height: 1080,
      });
      // The desktop panel sizes its page, so a viewer resize leaves it alone.
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "resize", width: 390, height: 844 });
      expect(page.setViewportSize).not.toHaveBeenCalled();
      yield* viewer.input({ type: "releaseControl" });
      // Agents reach it through the same engine as a headless tab.
      const evaluated = yield* broker.invoke({
        scope: asSession("agent-desktop"),
        operation: "status",
        input: {},
        tabId: PreviewTabId.make(opened.tabId),
      });
      expect(evaluated).toMatchObject({ tabId: opened.tabId });
      // Closing the session lets go of the desktop's page without closing it.
      yield* manager.close({ threadId: scope.thread.threadId, tabId: opened.tabId });
      while (releasedDesktopTabs.length === 0) yield* Effect.yieldNow;
      expect(releasedDesktopTabs).toEqual([opened.tabId]);
      expect(page.close).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("desktop viewers follow the page's native size and zoom", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const operator = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const observer = yield* browser.attachViewer(viewerInput(opened.tabId, false));
      const context = desktopConnections[0]!.context;
      const cdp = context.sessions[0]!;
      yield* operator.input({ type: "takeControl" });
      // The desktop panel sizes its page, even for a fixed setting.
      const setting = { _tag: "preset", presetId: "desktop-1920x1080", width: 1920, height: 1080 };
      yield* operator.input({ type: "viewport", setting });
      for (const viewer of [operator, observer]) yield* nextViewerViewport(viewer);
      // The measured size already includes the desktop's native zoom.
      yield* manager.adjust({
        threadId: scope.thread.threadId,
        tabId: opened.tabId,
        zoomFactor: 2,
      });
      Object.assign(context.cssViewport, { width: 1000, height: 600 });
      cdp.emit("Page.frameResized");
      for (const viewer of [operator, observer]) {
        expect(yield* nextViewerViewport(viewer)).toEqual({
          _tag: "viewport",
          width: 1000,
          height: 600,
        });
      }
      expect(context.page.setViewportSize).not.toHaveBeenCalled();
      expect(cdp.send.mock.calls.some(([method]) => method.startsWith("Emulation."))).toBe(false);
      expect(
        yield* broker.invoke({
          scope,
          operation: "status",
          input: {},
          tabId: PreviewTabId.make(opened.tabId),
        }),
      ).toMatchObject({ viewport: { width: 1000, height: 600 } });
      // Viewers map clicks with that size, so the page gets CSS coordinates as sent.
      yield* operator.input({ type: "mouse", action: "down", x: 750, y: 450, button: "left" });
      expect(context.sessions[1]!.send).toHaveBeenCalledWith(
        "Input.dispatchMouseEvent",
        expect.objectContaining({ type: "mousePressed", x: 750, y: 450 }),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a desktop dialog reuses the last size and remeasures when it closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const status = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
        tabId: PreviewTabId.make(opened.tabId),
      });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const context = desktopConnections[0]!.context;
      const cdp = context.sessions[0]!;
      const dialog = {
        type: () => "confirm",
        message: () => "Continue?",
        defaultValue: () => "",
        accept: vi.fn(async () => {}),
        dismiss: vi.fn(async () => {}),
      };
      // An open dialog blocks page script, so status and a new viewer use the last size.
      context.page.emit("dialog", dialog);
      cdp.send.mockClear();
      expect(yield* status).toMatchObject({
        viewport: { width: 1920, height: 1080 },
        dialog: { type: "confirm", message: "Continue?" },
      });
      const reconnected = yield* browser.attachViewer(viewerInput(opened.tabId, false));
      expect(yield* nextViewerViewport(reconnected)).toEqual({
        _tag: "viewport",
        width: 1920,
        height: 1080,
      });
      expect(cdp.send).not.toHaveBeenCalled();
      yield* Queue.clear(viewer.output);
      Object.assign(context.cssViewport, { width: 1440, height: 900 });
      yield* viewer.input({ type: "dialog", accept: true });
      expect(dialog.accept).toHaveBeenCalledOnce();
      expect(yield* nextViewerViewport(viewer)).toEqual({
        _tag: "viewport",
        width: 1440,
        height: 900,
      });
      // The host can also close its own dialog, outside viewer input.
      context.page.emit("dialog", dialog);
      Object.assign(context.cssViewport, { width: 960, height: 600 });
      cdp.emit("Page.javascriptDialogClosed");
      expect(yield* nextViewerViewport(viewer)).toEqual({
        _tag: "viewport",
        width: 960,
        height: 600,
      });
      expect(yield* status).toMatchObject({ dialog: null, viewport: { width: 960, height: 600 } });
      // An agent can answer it too, and the status it reads next must not hide the new size.
      yield* viewer.input({ type: "releaseControl" });
      context.page.emit("dialog", dialog);
      Object.assign(context.cssViewport, { width: 1280, height: 720 });
      yield* broker.invoke({
        scope,
        operation: "dialog",
        input: { accept: true },
        tabId: PreviewTabId.make(opened.tabId),
      });
      expect(yield* nextViewerViewport(viewer)).toEqual({
        _tag: "viewport",
        width: 1280,
        height: 720,
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a desktop size read that is late, empty or fails keeps the newest size", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const context = desktopConnections[0]!.context;
      const cdp = context.sessions[0]!;
      const send = cdp.send.getMockImplementation()!;
      // Each queued answer replaces one page evaluation; the rest measure cssViewport.
      const evaluations: Array<() => Promise<Record<string, unknown>>> = [];
      cdp.send.mockImplementation((method, input) =>
        method === "Runtime.evaluate" && evaluations.length > 0
          ? evaluations.shift()!()
          : send(method, input),
      );
      const late = Promise.withResolvers<Record<string, unknown>>();
      yield* Effect.addFinalizer(() => Effect.sync(() => late.resolve({})));
      yield* nextViewerViewport(viewer);
      // An older read stalls until after a newer read finishes.
      evaluations.push(() => late.promise);
      const stale = cdp.emitAsync("Page.frameResized");
      Object.assign(context.cssViewport, { width: 1500, height: 900 });
      yield* Effect.promise(() => cdp.emitAsync("Page.frameResized"));
      late.resolve({ result: { value: { width: 100, height: 100 } } });
      yield* Effect.promise(() => stale);
      // A hidden webview measures 0x0.
      Object.assign(context.cssViewport, { width: 0, height: 0 });
      yield* Effect.promise(() => cdp.emitAsync("Page.frameResized"));
      const sizes = (yield* Queue.takeAll(viewer.output)).flatMap((item) =>
        item._tag === "viewport" ? [`${item.width}x${item.height}`] : [],
      );
      expect(new Set(sizes)).toEqual(new Set(["1500x900"]));
      // A navigation can destroy the isolated world mid-read.
      evaluations.push(() => Promise.reject(new Error("Cannot find context with specified id")));
      expect(
        yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
          tabId: PreviewTabId.make(opened.tabId),
        }),
      ).toMatchObject({ viewport: { width: 1500, height: 900 } });
      expect(evaluations).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a late first desktop size still reaches viewers when a newer read fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      desktopHiddenNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const context = desktopConnections[0]!.context;
      const cdp = context.sessions[0]!;
      // The viewer attached while hidden, so no size is known yet.
      while (!cdp.send.mock.calls.some(([method]) => method === "Runtime.evaluate"))
        yield* Effect.yieldNow;
      const send = cdp.send.getMockImplementation()!;
      const late = Promise.withResolvers<Record<string, unknown>>();
      yield* Effect.addFinalizer(() => Effect.sync(() => late.resolve({})));
      // Once shown, an older read stalls and a navigation fails the newer one.
      const evaluations = [
        () => late.promise,
        () => Promise.reject(new Error("Cannot find context with specified id")),
      ];
      cdp.send.mockImplementation((method, input) =>
        method === "Runtime.evaluate" && evaluations.length > 0
          ? evaluations.shift()!()
          : send(method, input),
      );
      const stale = cdp.emitAsync("Page.frameResized");
      yield* Effect.promise(() => cdp.emitAsync("Page.frameResized"));
      late.resolve({ result: { value: { width: 1500, height: 900 } } });
      yield* Effect.promise(() => stale);
      const sizes = (yield* Queue.takeAll(viewer.output)).flatMap((item) =>
        item._tag === "viewport" ? [`${item.width}x${item.height}`] : [],
      );
      expect(sizes).toEqual(["1500x900"]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a queued reconnect survives later viewer state on a stalled viewer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, false));
      yield* nextViewerViewport(viewer);
      const cdp = desktopConnections[0]!.context.sessions[0]!;
      while (desktopDetaches.listenerCount("detach") === 0) yield* Effect.yieldNow;
      stallViewer(viewer, { _tag: "frame", data: Buffer.alloc(0), ack: Effect.void });
      // One free slot: the reconnect lands as the last queued item.
      yield* Queue.take(viewer.output);
      const capacity = (yield* Queue.size(viewer.output)) + 1;
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      while ((yield* Queue.size(viewer.output)) < capacity) yield* Effect.yieldNow;
      yield* Effect.promise(() => cdp.emitAsync("Page.frameResized"));
      expect((yield* Queue.takeAll(viewer.output)).at(-1)).toEqual({ _tag: "reconnect" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a desktop page the desktop takes back reconnects instead of closing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, false));
      // Devtools opened on the desktop, so it withdrew the page's debugger.
      // The server's listener subscribes in its own fiber; detach once it is there.
      while (desktopDetaches.listenerCount("detach") === 0) yield* Effect.yieldNow;
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      let end = yield* Queue.take(viewer.output);
      while (end._tag !== "reconnect" && end._tag !== "gone")
        end = yield* Queue.take(viewer.output);
      expect(end._tag).toBe("reconnect");
      expect(releasedDesktopTabs).toEqual([opened.tabId]);
      // The session survives, and the next viewer reaches the page again.
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId)).toContain(opened.tabId);
      yield* browser.attachViewer(viewerInput(opened.tabId, false));
      expect(desktopConnections).toHaveLength(2);
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
      // The user opened and is looking at the tab; attaching takes control.
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
      // Reads work while the user drives; page script does not, since it can change the page.
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
      // Acting is refused while the user controls the tab.
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
      // Once they let go, the tab is unclaimed and the agent may act on it.
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
      // Taking control back refuses the agent again.
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
        // The chosen profile reaches the headless tab's storage.
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

it.live("an agent tab keeps throwaway storage when no client reported profiles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      expect(contextRequests).toEqual([{ profileId: "default", isolated: true }]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a desktop page that comes back reconnects without waiting for a viewer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* Manager.PreviewManager;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      while (desktopConnections.length === 0) yield* Effect.yieldNow;
      while (desktopDetaches.listenerCount("detach") === 0) yield* Effect.yieldNow;
      // DevTools opened, then closed: the desktop withdraws the page and returns it.
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      while (releasedDesktopTabs.length === 0) yield* Effect.yieldNow;
      desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      // Without a viewer or agent, the server drives the page again, so its URL keeps reaching clients.
      while (desktopConnections.length < 2) yield* Effect.yieldNow;
      expect(desktopConnections).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);
