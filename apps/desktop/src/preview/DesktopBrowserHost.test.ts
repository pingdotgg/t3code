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
import { vi } from "vite-plus/test";

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
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
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
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      yield* settle;
      debuggee.release();
      const [, reply] = yield* Fiber.join(reader);

      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps native screenshots serialized beyond the scaled capture deadline", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      Object.assign(debuggee.tab.webContents, {
        id: 42,
        hostWebContents: { isDestroyed: () => false, executeJavaScript: async () => false },
      });
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      expect(debuggee.sent).toEqual([1]);

      yield* TestClock.adjust("6 seconds");
      expect(debuggee.sent).toEqual([1]);

      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([1, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops waiting on a screenshot the page navigated away from", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* command(host, 3, "Page.captureScreenshot");
      yield* settle;
      debuggee.navigate();
      expect(debuggee.sent).toEqual([1, 2]);

      // The superseded screenshot answering late must not start a third beside the second.
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([1, 2]);

      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(2);
      expect(debuggee.sent).toEqual([1, 2, 3]);
    }).pipe(Effect.scoped),
  );

  it.effect("never starts a stale native copy after navigation during the transform probe", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const probeStarted = Promise.withResolvers<void>();
      const probe = Promise.withResolvers<boolean>();
      let probing = true;
      const capturePage = vi.fn(async () => ({ toDataURL: () => "data:image/png;base64,eA==" }));
      Object.assign(debuggee.tab.webContents, {
        id: 42,
        capturePage,
        hostWebContents: {
          isDestroyed: () => false,
          executeJavaScript: async () => {
            if (probing) {
              probing = false;
              probeStarted.resolve();
              return probe.promise;
            }
            return true;
          },
        },
      });
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      yield* command(host, 1, "Page.captureScreenshot");
      yield* Effect.promise(() => probeStarted.promise);
      yield* command(host, 2, "Page.captureScreenshot");
      const sent = debuggee.nextSend();
      debuggee.navigate();
      yield* Effect.promise(() => sent);
      expect(debuggee.sent).toEqual([2]);
      expect(capturePage).toHaveBeenCalledOnce();
      probe.resolve(true);
      yield* settle;
      expect(capturePage).toHaveBeenCalledOnce();
      expect(yield* Queue.take(replies)).toBe(1);
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("drops screenshots a released relay left waiting", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(host, 3, "Page.captureScreenshot");
      expect(debuggee.sent).toEqual([1]);

      const sent = debuggee.nextSend();
      debuggee.release();
      yield* Effect.promise(() => sent);
      expect(debuggee.sent).toEqual([1, 3]);
    }),
  );

  it.effect("emulates focus while the server drives a guest, then lets a hidden one throttle", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* command(host, 1, "DOM.enable");
      yield* settle;
      expect(debuggee.focusEmulation).toEqual([true]);
      expect(debuggee.sent).toEqual([1]);
      debuggee.release();
      yield* settle;

      yield* TestClock.adjust("4 seconds");
      yield* command(host, 2, "Input.dispatchMouseEvent");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("4 seconds");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* TestClock.adjust("10 seconds");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      yield* command(host, 3, "Page.captureScreenshot");
      yield* settle;
      expect(debuggee.focusEmulation).toEqual([true, false, true]);
      expect(debuggee.sent).toEqual([1, 2, 3]);
    }),
  );

  it.effect("keeps a guest focused while a command it is running is still pending", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      // An evaluation awaiting the page's next frame, which a throttled guest never paints.
      yield* command(host, 1, "Runtime.evaluate");
      yield* settle;
      expect(debuggee.sent).toEqual([1]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(1);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a guest throttle once Chromium can no longer answer its pending command", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* command(host, 1, "Runtime.evaluate");
      yield* settle;
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      // A command the old document never answers.
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      expect(debuggee.sent).toEqual([1, 2]);
      debuggee.navigate();
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false, true, false]);
    }),
  );

  it.effect("keeps a guest focused for the screenshot a navigation lets start", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      debuggee.navigate();
      expect(debuggee.sent).toEqual([1, 2]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);
    }),
  );

  it.effect("never sends a screenshot a navigation superseded while focus was changing", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee({ deferFocus: true });
      host.attach(key, debuggee.tab);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      debuggee.navigate();
      debuggee.settleFocus();
      yield* settle;
      // Two captures in flight would undo the one-at-a-time guard.
      expect(debuggee.sent).toEqual([2]);
    }),
  );

  it.effect("keeps a guest focused when its turn starts after the agent's first command", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      yield* command(host, 1, "Input.dispatchKeyEvent");
      yield* settle;
      yield* turn(true);
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* turn(false);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }),
  );

  it.effect("lets a guest throttle through a turn that only sent it housekeeping", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      yield* host.handleCommandLine(
        encodeJson({ type: "turn", threadId: key.threadId, active: true }),
      );

      // Playwright re-enabling a domain after a reload is not the agent using the tab.
      yield* command(host, 1, "Runtime.enable");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      yield* command(host, 2, "Runtime.evaluate");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false, true]);
    }),
  );

  it.effect("keeps a guest the agent used focused through its turn's pauses", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      yield* turn(true);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([]);

      yield* command(host, 1, "Input.dispatchKeyEvent");
      yield* settle;
      debuggee.release();
      yield* settle;
      // The model thinks between steps; a focus-sensitive menu must not blur meanwhile.
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* turn(false);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }),
  );

  it.effect(
    "ends a command's hold with the turn that sent it, even if Chromium never answers",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        yield* host.handleCommandLine(
          encodeJson({ type: "turn", threadId: key.threadId, active: true }),
        );

        // A screenshot of a hidden guest the server already gave up on.
        yield* command(host, 1, "Page.captureScreenshot");
        yield* settle;
        expect(debuggee.sent).toEqual([1]);
        yield* host.handleCommandLine(
          encodeJson({ type: "turn", threadId: key.threadId, active: false }),
        );
        yield* TestClock.adjust("1 minute");
        expect(debuggee.focusEmulation).toEqual([true, false]);
      }),
  );

  it.effect("ends the agent's own session's holds with its turn, but not a viewer's stream", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      // The server's own CDP session, evaluating a promise that never settles.
      yield* turn(true);
      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Runtime.evaluate", sessionId: "t3-preview-page-1" });
      yield* settle;
      yield* turn(false);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      // A viewer streaming the guest keeps it focused through a turn's end.
      yield* turn(true);
      yield* raw({ id: 3, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(3);
      yield* raw({ id: 4, method: "Page.startScreencast", sessionId: "t3-preview-page-2" });
      yield* settle;
      yield* turn(false);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false, true]);
    }).pipe(Effect.scoped),
  );

  it.effect("paints for a screenshot queued behind one its viewer abandoned mid-capture", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const painting = yield* watchPainting(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* settle;
      yield* raw({
        id: 3,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      expect(yield* Queue.take(replies)).toBe(3);
      expect(painting).toEqual([true, false]);

      // The agent's screenshot waits its turn; painting lets the abandoned one finish first.
      yield* command(host, 4, "Page.captureScreenshot");
      yield* settle;
      expect(painting).toEqual([true, false, true]);
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(2);
      yield* settle;
      expect(debuggee.sent).toEqual([undefined, 4]);
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(4);
      yield* settle;
      expect(painting).toEqual([true, false, true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops painting for a queued screenshot once its session detaches", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const painting = yield* watchPainting(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      // The agent's screenshot is abandoned at turn end; a viewer's waits behind it, then leaves.
      yield* turn(true);
      yield* command(host, 1, "Page.captureScreenshot");
      yield* settle;
      yield* turn(false);
      yield* raw({ id: 2, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(2);
      yield* raw({ id: 3, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* settle;
      expect(painting).toEqual([true, false, true]);
      yield* raw({
        id: 4,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      expect(yield* Queue.take(replies)).toBe(4);
      expect(painting).toEqual([true, false, true, false]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("never sends a screenshot whose session detached while focus was changing", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee({ deferFocus: true });
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* raw({
        id: 3,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      expect(yield* Queue.take(replies)).toBe(3);
      debuggee.settleFocus();
      yield* settle;
      expect(debuggee.sent).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops painting for a screenshot still queued when the agent's turn ends", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const painting = yield* watchPainting(host);
      const turn = (active: boolean) =>
        host.handleCommandLine(encodeJson({ type: "turn", threadId: key.threadId, active }));

      yield* turn(true);
      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* settle;
      yield* turn(false);
      yield* settle;
      expect(painting).toEqual([true, false]);

      // The first answers late; the second still goes in turn, but holds nothing.
      debuggee.releaseFirst();
      yield* settle;
      expect(debuggee.sent).toEqual([1, 2]);
      expect(painting).toEqual([true, false]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a guest throttle when Chromium refuses a viewer's screencast", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee({ refuse: (method) => method === "Page.startScreencast" });
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const painting = yield* watchPainting(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      expect(yield* Queue.take(replies)).toBe(2);
      yield* settle;
      expect(painting).toEqual([true, false]);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a guest throttle after a person's input through a viewer that then closed", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* host.handleCommandLine(
        encodeJson({ type: "turn", threadId: key.threadId, active: true }),
      );
      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      yield* raw({ id: 3, method: "Input.dispatchMouseEvent", sessionId: "t3-preview-page-1" });
      yield* settle;
      debuggee.release();
      yield* raw({
        id: 4,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a page's screencast when a child session's screencast is refused", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee({
        refuse: (method, sessionId) => method === "Page.startScreencast" && sessionId !== undefined,
      });
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* command(host, 1, "Page.startScreencast");
      yield* settle;
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.startScreencast", sessionId: "child-frame" });
      expect(yield* Queue.take(replies)).toBe(2);
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a screencast that arrives on a session after it detached", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({
        id: 2,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      expect(yield* Queue.take(replies)).toBe(2);
      yield* raw({ id: 3, method: "Page.startScreencast", sessionId: "t3-preview-page-1" });
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a guest throttle once the session waiting on its command detaches", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      // A viewer's own CDP session, closed while its still of a hidden guest is pending.
      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* raw({ id: 2, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* raw({
        id: 3,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("never sends a screenshot queued by a session that has since detached", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);
      const raw = (message: Record<string, unknown>) =>
        host.handleCommandLine(encodeJson({ type: "cdp", ...key, message: encodeJson(message) }));

      yield* raw({ id: 1, method: "Target.attachToTarget", params: { targetId: "GUEST" } });
      expect(yield* Queue.take(replies)).toBe(1);
      yield* command(host, 2, "Page.captureScreenshot");
      yield* raw({ id: 3, method: "Page.captureScreenshot", sessionId: "t3-preview-page-1" });
      yield* raw({
        id: 4,
        method: "Target.detachFromTarget",
        params: { sessionId: "t3-preview-page-1" },
      });
      yield* settle;
      debuggee.release();
      expect(yield* Queue.take(replies)).toBe(4);
      // The dropped screenshot's error reply leaves as the first frees its turn.
      expect([yield* Queue.take(replies), yield* Queue.take(replies)]).toEqual([3, 2]);
      yield* settle;
      expect(debuggee.sent).toEqual([2]);

      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a streamed guest focused until its screencast ends", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* command(host, 1, "Page.startScreencast");
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true]);

      yield* command(host, 2, "Page.stopScreencast");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false]);

      // A viewer whose connection went away without stopping its screencast.
      yield* command(host, 3, "Page.startScreencast");
      yield* settle;
      debuggee.release();
      yield* settle;
      yield* TestClock.adjust("1 minute");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* TestClock.adjust("1 minute");
      expect(debuggee.focusEmulation).toEqual([true, false, true, false]);
    }),
  );

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
