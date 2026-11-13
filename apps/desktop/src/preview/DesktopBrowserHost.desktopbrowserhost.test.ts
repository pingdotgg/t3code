// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it, vi } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };
/** Sends a page command whose id the fake debugger records as it receives it. */

const command = (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  id: number,
  method: string,
) =>
  host.handleCommandLine(
    encodeJson({
      type: "cdp",
      ...key,
      message: encodeJson({ id, method, params: { id }, sessionId: "t3-preview-page" }),
    }),
  );

const makeDebuggee = (
  options: {
    readonly deferFocus?: boolean;
    readonly refuse?: (method: string, sessionId: string | undefined) => boolean;
  } = {},
) => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const focusChanges: Array<() => void> = [];
  const sent: Array<unknown> = [];
  const sendWaiters: Array<() => void> = [];
  const focusEmulation: Array<boolean> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (
      method: string,
      params?: { id?: number; enabled?: boolean },
      sessionId?: string,
    ) =>
      new Promise((resolve, reject) => {
        if (options.refuse?.(method, sessionId)) {
          reject(new Error("Refused"));
          return;
        }
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        if (method === "Emulation.setFocusEmulationEnabled") {
          focusEmulation.push(params?.enabled === true);
          if (options.deferFocus) focusChanges.push(() => resolve({}));
          else resolve({});
          return;
        }
        sent.push(params?.id);
        pending.push(() => resolve({ method }));
        sendWaiters.shift()?.();
      }),
  });
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  });
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    navigate: () => webContents.emit("did-navigate"),
    /** Ids of the commands the debugger received, in order. */
    sent,
    focusEmulation,
    nextSend: () => new Promise<void>((resolve) => sendWaiters.push(resolve)),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    releaseFirst: () => pending.shift()?.(),
    settleFocus: () => focusChanges.splice(0).forEach((resolve) => resolve()),
  };
};

/** Commands wait behind a focus emulation change; it settles within a macrotask. */

const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

/**
 * Ids of the replies the host sends, in order. A screenshot's reply leaves after its turn
 * has passed on, so by then the next waiting screenshot, if any, has been sent. Subscribe
 * before sending commands: a new subscriber releases the tab's relay.
 */
const watchReplies = (host: DesktopBrowserHost.DesktopBrowserHost["Service"]) =>
  Effect.gen(function* () {
    const replies = yield* Queue.unbounded<number>();
    yield* host.events.pipe(
      Stream.map((line) => decodeEvent(new TextDecoder().decode(line))),
      Stream.runForEach((event) =>
        event.type === "cdp" ? Queue.offer(replies, decodeCdpReply(event.message).id) : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return replies;
  });

/** Whether the client should paint the guest, each time that changes. */

const watchPainting = (host: DesktopBrowserHost.DesktopBrowserHost["Service"]) =>
  Effect.gen(function* () {
    const painting: Array<boolean> = [];
    yield* host.painting.pipe(
      Stream.runForEach(({ active }) => Effect.sync(() => painting.push(active))),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return painting;
  });

describe("DesktopBrowserHost", () => {
  it.effect("keeps a guest focused while any of its screencasts runs", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      // Two viewers, or a viewer and a recording, each on its own session.
      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      yield* raw({ id: 2, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect([yield* Queue.take(replies), yield* Queue.take(replies)]).toEqual([1, 2]);
      yield* raw({ id: 3, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      yield* raw({ id: 4, method: "Page.startScreencast", sessionId: "t3-preview-page-2" });
      yield* raw({ id: 5, method: "Page.stopScreencast", sessionId: "t3-preview-page-1" });
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* raw({
        id: 6,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-2" },
      });
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("paints a hidden guest only while the screenshot it is taking is pending", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const painting = yield* watchPainting(host);

      yield* command(host, 1, "DOM.enable");
      yield* settle;
      expect(painting).toEqual([]);

      yield* command(host, 2, "Page.captureScreenshot");
      yield* command(host, 3, "Page.captureScreenshot");
      yield* settle;
      expect(painting).toEqual([true]);

      // The first answers once the guest paints; the queued one then takes its turn.
      debuggee.release();
      yield* settle;
      expect(debuggee.sent).toEqual([1, 2, 3]);
      debuggee.release();
      yield* settle;
      expect(painting).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops painting for a screenshot Chromium never answers", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const painting = yield* watchPainting(host);
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      // The server gave up on it, and the agent's turn ends.
      yield* turn(true);
      yield* command(host, 1, "Page.captureScreenshot");
      yield* settle;
      yield* turn(false);
      yield* settle;
      expect(painting).toEqual([true, false]);

      // The page loads a new document, which also frees the screenshot turn.
      debuggee.navigate();
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      debuggee.navigate();
      yield* settle;
      expect(painting).toEqual([true, false, true, false]);

      // The server releases the relay.
      yield* command(host, 3, "Page.captureScreenshot");
      yield* settle;
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* settle;
      expect(painting).toEqual([true, false, true, false, true, false]);

      // The guest detaches; a replacement starts with no screenshot pending.
      const replacement = makeDebuggee();
      host.attach(key, replacement.tab);
      yield* command(host, 4, "Page.captureScreenshot");
      yield* settle;
      host.detach(key);
      yield* settle;
      expect(painting).toEqual([true, false, true, false, true, false, true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("paints a streamed guest until its last screencast ends", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const painting = yield* watchPainting(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      yield* raw({ id: 2, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect([yield* Queue.take(replies), yield* Queue.take(replies)]).toEqual([1, 2]);
      yield* raw({ id: 3, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      yield* raw({ id: 4, method: "Page.startScreencast", sessionId: "t3-preview-page-2" });
      yield* raw({ id: 5, method: "Page.stopScreencast", sessionId: "t3-preview-page-1" });
      yield* settle;
      debuggee.release();
      yield* settle;
      expect(painting).toEqual([true]);

      yield* raw({
        id: 6,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-2" },
      });
      yield* settle;
      expect(painting).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;

      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      const sent = debuggee.nextSend();
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      yield* Effect.promise(() => sent);
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(1);
      debuggee.emit("Page.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(makeDebuggee().tab.webContents, item)).toBe(false);
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/guid-1"]);
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("tells a download the person clicked from one the agent's input started", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({ id: 1, method: "DOM.getDocument", params: {} }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(true);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 2,
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 1, y: 1 },
          }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(false);
    }),
  );

  it.effect("detaches only the tab whose CDP event is too large to relay", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const tabs = [makeDebuggee({ deferFocus: true }), makeDebuggee()];
      const send = vi.spyOn(tabs[0]!.tab.debugger, "sendCommand");
      const keys = [key, { threadId: "thread-2", tabId: "tab-2" }];
      const events = yield* Queue.unbounded<DesktopBrowserEvent>();
      yield* host.events.pipe(
        Stream.runForEach((line) =>
          Queue.offer(events, decodeEvent(new TextDecoder().decode(line))),
        ),
        Effect.forkScoped,
      );
      for (const [index, tabKey] of keys.entries()) {
        host.attach(tabKey, tabs[index]!.tab);
        expect(yield* Queue.take(events)).toEqual({ type: "attached", ...tabKey });
        yield* host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...tabKey,
            message: encodeJson({ id: 1, method: "Target.setAutoAttach" }),
          }),
        );
        // The command's reply and the page announcement.
        yield* Queue.takeN(events, 2);
      }

      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 2,
            method: "Target.setAutoAttach",
            params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
            sessionId: "t3-preview-page",
          }),
        }),
      );
      yield* command(host, 3, "Page.startScreencast");
      tabs[0]!.emit("Runtime.consoleAPICalled", {
        args: Array(2048).fill("x".repeat(40 * 1024)),
      });
      tabs[1]!.emit("Page.loadEventFired", { timestamp: 1 });
      const [detached, next] = yield* Queue.takeN(events, 2);

      const { type, threadId, tabId } = detached!;
      expect({ type, threadId, tabId }).toEqual({ type: "detached", ...key });
      expect(send).toHaveBeenCalledWith("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      tabs[0]!.settleFocus();
      yield* settle;
      expect(send).not.toHaveBeenCalledWith("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      expect(send).toHaveBeenCalledWith("Page.stopScreencast");
      expect(tabs[0]!.focusEmulation).toEqual([true, false]);
      expect(next).toMatchObject({ type: "cdp", ...keys[1] });
      expect(JSON.parse((next as { message: string }).message)).toMatchObject({
        method: "Page.loadEventFired",
      });
    }).pipe(Effect.scoped),
  );
});
