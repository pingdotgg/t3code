// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
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
  prepareSurface: () => Promise<unknown> = async () => true,
  restoreSurface: () => Promise<unknown> = async () => true,
) => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<(cause?: Error) => void> = [];
  const sent: Array<unknown> = [];
  const sendWaiters: Array<() => void> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string, params?: { id?: number }) =>
      new Promise((resolve, reject) => {
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        sent.push(params?.id);
        pending.push((cause) => (cause ? reject(cause) : resolve({ method })));
        sendWaiters.shift()?.();
      }),
  });
  const surfaceRequests: string[] = [];
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    id: 42,
    isDestroyed: () => false,
    hostWebContents: {
      isDestroyed: () => false,
      executeJavaScript: (expression: string) => {
        surfaceRequests.push(expression);
        return expression.endsWith(", true)") ? prepareSurface() : restoreSurface();
      },
    },
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
    surfaceRequests,
    nextSend: () => new Promise<void>((resolve) => sendWaiters.push(resolve)),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    releaseFirst: (cause?: Error) => pending.shift()?.(cause),
  };
};

const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

const sendScreenshot = Effect.fn("test.sendScreenshot")(function* (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  debuggee: ReturnType<typeof makeDebuggee>,
  id: number,
) {
  const sent = debuggee.nextSend();
  yield* command(host, id, "Page.captureScreenshot");
  yield* Effect.promise(() => sent);
});

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

describe("DesktopBrowserHost", () => {
  it.effect.each([false, true])(
    "waits for a renderable surface and restores it after capture (failed: %s)",
    (failed) =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const ready = Promise.withResolvers<boolean>();
        const debuggee = makeDebuggee(() => ready.promise);
        host.attach(key, debuggee.tab);
        const replies = yield* watchReplies(host);

        yield* command(host, 1, "Page.captureScreenshot");
        expect(debuggee.sent).toEqual([]);

        const sent = debuggee.nextSend();
        ready.resolve(true);
        yield* Effect.promise(() => sent);
        debuggee.releaseFirst(failed ? new Error("Capture failed") : undefined);
        expect(yield* Queue.take(replies)).toBe(1);
        expect(debuggee.surfaceRequests).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect("does not send a screenshot superseded while its surface was becoming ready", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const ready = Promise.withResolvers<boolean>();
      const debuggee = makeDebuggee(() => ready.promise);
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      debuggee.navigate();
      ready.resolve(true);
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([]);
      expect(debuggee.surfaceRequests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect.each<[string, () => Promise<unknown>]>([
    ["never becomes ready", async () => false],
    ["can't be reached", () => Promise.reject(new Error("Script failed"))],
  ])("still issues a screenshot when its render surface %s", ([, prepareSurface]) =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee(prepareSurface);
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* sendScreenshot(host, debuggee, 1);
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([1]);
      expect(debuggee.surfaceRequests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("sends the screenshot when the renderer never answers readiness", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee(() => new Promise(() => {}));
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      const sent = debuggee.nextSend();
      yield* command(host, 1, "Page.captureScreenshot");
      yield* TestClock.adjust("2 seconds");
      yield* Effect.promise(() => sent);
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("answers and moves on when the renderer never answers restoring the surface", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee(undefined, () => new Promise(() => {}));
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* sendScreenshot(host, debuggee, 1);
      yield* command(host, 2, "Page.captureScreenshot");
      const secondSent = debuggee.nextSend();
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      yield* Effect.promise(() => secondSent);
      expect(debuggee.sent).toEqual([1, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);

      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* sendScreenshot(host, debuggee, 1);
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      debuggee.release();
      const [, reply] = yield* Fiber.join(reader);

      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("sends a page one screenshot at a time", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* sendScreenshot(host, debuggee, 1);
      yield* command(host, 2, "Page.captureScreenshot");
      yield* command(host, 3, "DOM.enable");
      expect(debuggee.sent).toEqual([1, 3]);

      const secondSent = debuggee.nextSend();
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      yield* Effect.promise(() => secondSent);
      expect(debuggee.sent).toEqual([1, 3, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops waiting on a screenshot the page navigated away from", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* sendScreenshot(host, debuggee, 1);
      yield* command(host, 2, "Page.captureScreenshot");
      yield* command(host, 3, "Page.captureScreenshot");
      const secondSent = debuggee.nextSend();
      debuggee.navigate();
      yield* Effect.promise(() => secondSent);
      expect(debuggee.sent).toEqual([1, 2]);

      // The superseded screenshot answering late must not start a third beside the second.
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([1, 2]);

      const thirdSent = debuggee.nextSend();
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(2);
      yield* Effect.promise(() => thirdSent);
      expect(debuggee.sent).toEqual([1, 2, 3]);
    }).pipe(Effect.scoped),
  );

  it.effect("drops screenshots a released relay left waiting", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* sendScreenshot(host, debuggee, 1);
      yield* command(host, 2, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(host, 3, "Page.captureScreenshot");
      expect(debuggee.sent).toEqual([1]);

      const sent = debuggee.nextSend();
      debuggee.release();
      yield* Effect.promise(() => sent);
      expect(debuggee.sent).toEqual([1, 3]);
    }),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;

      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
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
      debuggee.emit("Browser.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/guid-1"]);
    }),
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
});
