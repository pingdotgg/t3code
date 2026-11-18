import * as NodeEvents from "node:events";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "../preview/DesktopBrowserChannel.ts";
import * as Manager from "../preview/Manager.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import { ServerSettingsService } from "../serverSettings.ts";

// A small fake Chromium: one headless tab that viewers attach to.

const contexts: Array<ReturnType<typeof makeContext>> = [];

vi.mock("../preview/ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeSession() {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, callback: (...args: unknown[]) => void) => events.on(name, callback)),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return { data: "ZnJhbWU=" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        const world = (input as { worldName?: string }).worldName;
        return { executionContextId: world === "t3-preview-viewport" ? 9 : 1 };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 9)
        return { result: { value: { width: 1280, height: 800 } } };
      return { result: { value: [] } };
    }),
  };
}

function makeContext() {
  const events = new NodeEvents.EventEmitter();
  const sessions: Array<ReturnType<typeof makeSession>> = [];
  let url = "about:blank";
  let viewport: ReturnType<Page["viewportSize"]> = { width: 1280, height: 800 };
  let closed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
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
    }),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    exposeFunction: vi.fn(async () => {}),
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (closed) return;
      closed = true;
      events.emit("close");
    }),
  };
  const context = {
    page,
    sessions,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async () => {
      const session = makeSession();
      sessions.push(session);
      return session;
    },
    close: vi.fn(async () => {
      await page.close();
    }),
  };
  return context;
}

const threadId = ThreadId.make("control-lock-thread");
const environmentId = EnvironmentId.make("control-lock-environment");
const layer = ServerBrowser.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Broker.layer,
      Manager.layer,
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused descriptor"),
      }),
      Layer.succeed(PreviewBrowser.PreviewBrowser, {
        executable: Effect.die("mock Chromium does not need an executable"),
        installed: Effect.die("mock Chromium does not need an executable"),
      }),
      Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
        available: false,
        awaitAttached: () => Effect.succeed(false),
        awaitShown: () => Effect.succeed(false),
        detached: Stream.never,
        attached: Stream.never,
        isAttached: () => Effect.succeed(false),
        isShown: () => false,
        loadFailure: () => undefined,
        endpoint: () => Effect.die("no desktop"),
        pointer: () => Effect.void,
        turn: () => Effect.void,
      }),
      PreviewAgentActivity.layer,
      ServerSettingsService.layerTest(),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-control-lock-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);

const viewerInput = (tabId: string, canOperate = true) => ({
  threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

type Control = Extract<ServerBrowser.ServerBrowserViewerOutput, { readonly _tag: "control" }>;
const nextControl = (viewer: ServerBrowser.ServerBrowserViewer, matches: (c: Control) => boolean) =>
  Effect.gen(function* () {
    let item = yield* Queue.take(viewer.output);
    while (item._tag !== "control" || !matches(item)) item = yield* Queue.take(viewer.output);
    return item;
  });

const mouseDown = {
  type: "mouse",
  action: "down",
  x: 10,
  y: 10,
  button: "left",
  buttons: 1,
  clickCount: 1,
  modifiers: 0,
};

/**
 * Opens a tab no agent owns, attaches a viewer that takes control and holds Shift, and
 * leaves a click of that viewer waiting on an `alert()` the way Chromium holds a click.
 */
const clickBehindAlert = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const manager = yield* Manager.PreviewManager;
  yield* Effect.yieldNow;
  const { tabId } = yield* manager.open({ threadId, runtime: "server" });
  const firstScope = yield* Scope.make();
  const first = yield* browser.attachViewer(viewerInput(tabId)).pipe(Scope.provide(firstScope));
  yield* nextControl(first, (control) => control.controller === "you");
  const clickStarted = Promise.withResolvers<void>();
  const clickReturned = Promise.withResolvers<Record<string, unknown>>();
  const session = contexts.at(-1)!.sessions.at(-1)!;
  const send = session.send.getMockImplementation()!;
  session.send.mockImplementation(async (method, input) => {
    if (method !== "Input.dispatchMouseEvent") return send(method, input);
    clickStarted.resolve();
    return clickReturned.promise;
  });
  yield* first.input({ type: "key", action: "down", key: "Shift", code: "ShiftLeft" });
  yield* first.input(mouseDown).pipe(Effect.forkScoped);
  yield* Effect.promise(() => clickStarted.promise);
  const alert = {
    type: () => "alert",
    message: () => "stuck click",
    defaultValue: () => "",
    accept: vi.fn(async () => clickReturned.resolve({})),
    dismiss: vi.fn(async () => clickReturned.resolve({})),
  };
  contexts.at(-1)!.page.emit("dialog", alert);
  /** The first viewer's stream ends, as on a reload; its click still waits on the alert. */
  const leave = Scope.close(firstScope, Exit.void).pipe(
    Effect.forkScoped({ startImmediately: true }),
  );
  // Viewer finalizers drain the click, so a test must end it before its scope closes.
  const unstick = Effect.sync(() => clickReturned.resolve({}));
  return { browser, tabId, alert, leave, unstick, session };
});

const withClickBehindAlert = <A, E, R>(
  test: (setup: Effect.Success<typeof clickBehindAlert>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* clickBehindAlert;
      return yield* test(setup).pipe(Effect.ensuring(setup.unstick));
    }),
  ).pipe(Effect.provide(layer));

it.effect(
  "a viewer that reconnects behind a click stuck on an alert gets control and answers it",
  () =>
    withClickBehindAlert(({ browser, tabId, alert, leave, session }) =>
      Effect.gen(function* () {
        const left = yield* leave;
        const reloaded = yield* browser.attachViewer(viewerInput(tabId));
        const reloadedSession = contexts.at(-1)!.sessions.at(-1)!;
        const control = yield* nextControl(reloaded, (item) => item.controller === "you");
        expect(control.dialog).toMatchObject({ type: "alert", message: "stuck click" });
        const typed = yield* reloaded
          .input({ type: "text", text: "after" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const sent = (calls: typeof session.send.mock, method: string, type?: string) =>
          calls.calls.findIndex(
            ([called, input]) =>
              called === method &&
              (type === undefined || (input as { type?: string }).type === type),
          );
        expect(sent(session.send.mock, "Input.dispatchKeyEvent", "keyUp")).toBe(-1);
        expect(sent(reloadedSession.send.mock, "Input.insertText")).toBe(-1);
        expect(session.detach).not.toHaveBeenCalled();

        yield* reloaded.input({ type: "dialog", accept: true });
        expect(alert.accept).toHaveBeenCalledTimes(1);
        yield* Fiber.join(left);
        yield* Fiber.join(typed);
        const keyUp =
          session.send.mock.invocationCallOrder[
            sent(session.send.mock, "Input.dispatchKeyEvent", "keyUp")
          ]!;
        // The leaving viewer's held key is released on its own session, before the new input.
        expect(keyUp).toBeLessThan(
          reloadedSession.send.mock.invocationCallOrder[
            sent(reloadedSession.send.mock, "Input.insertText")
          ]!,
        );
        expect(keyUp).toBeLessThan(session.detach.mock.invocationCallOrder[0]!);
      }),
    ),
);

it.effect("other viewers see control freed when its holder leaves behind a stuck click", () =>
  withClickBehindAlert(({ browser, tabId, leave }) =>
    Effect.gen(function* () {
      const watcher = yield* browser.attachViewer(viewerInput(tabId));
      yield* nextControl(watcher, (item) => item.controller === "another-viewer");
      yield* leave;
      yield* nextControl(watcher, (item) => item.controller === "unclaimed");
      yield* watcher.input({ type: "takeControl" }).pipe(Effect.forkScoped);
      yield* nextControl(watcher, (item) => item.controller === "you");
    }),
  ),
);

/** Opens a tab no agent owns, with a read-only viewer so its page exists before the test. */
const openTab = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const manager = yield* Manager.PreviewManager;
  yield* Effect.yieldNow;
  const { tabId } = yield* manager.open({ threadId, runtime: "server" });
  const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
  return { browser, tabId, watcher, context: contexts.at(-1)! };
});

it.effect("a viewer whose connect is stuck in setup does not hold control", () => {
  const setupStarted = Promise.withResolvers<void>();
  const setupReturned = Promise.withResolvers<Record<string, unknown>>();
  return Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId, context } = yield* openTab;
      const newSession = context.newCDPSession;
      context.newCDPSession = async () => {
        context.newCDPSession = newSession;
        const session = await newSession();
        const send = session.send.getMockImplementation()!;
        session.send.mockImplementation(async (method, input) => {
          if (method !== "Page.startScreencast") return send(method, input);
          setupStarted.resolve();
          return setupReturned.promise;
        });
        return session;
      };
      // A client that gave up on this connect, behind a proxy that keeps it open.
      yield* browser.attachViewer(viewerInput(tabId)).pipe(Effect.forkScoped);
      yield* Effect.promise(() => setupStarted.promise);
      const next = yield* browser.attachViewer(viewerInput(tabId));
      yield* nextControl(next, (item) => item.controller === "you");
    }).pipe(Effect.ensuring(Effect.sync(() => setupReturned.resolve({})))),
  ).pipe(Effect.provide(layer));
});

it.effect("a connect that a tab close overtakes does not attach to the closed tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId, watcher, context } = yield* openTab;
      const sessionRequested = Promise.withResolvers<void>();
      const sessionGate = Promise.withResolvers<void>();
      const newSession = context.newCDPSession;
      context.newCDPSession = async () => {
        context.newCDPSession = newSession;
        sessionRequested.resolve();
        await sessionGate.promise;
        return newSession();
      };
      const attaching = yield* browser
        .attachViewer(viewerInput(tabId))
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => sessionRequested.promise);
      yield* Effect.promise(() => context.page.close());
      let ended = yield* Queue.take(watcher.output);
      while (ended._tag !== "gone" && ended._tag !== "reconnect")
        ended = yield* Queue.take(watcher.output);
      sessionGate.resolve();
      expect(ended._tag).toBe("gone");
      // The stream answers this with the closed-tab code, which the client stops on.
      expect((yield* Fiber.join(attaching))._tag).toBe("ServerBrowserTabNotFoundError");
    }),
  ).pipe(Effect.provide(layer)),
);
