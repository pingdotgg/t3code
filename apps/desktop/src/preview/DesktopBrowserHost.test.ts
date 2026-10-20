// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

const makeDebuggee = () => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        pending.push(() => resolve({ method }));
      }),
  });
  const webContents = {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  };
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
};

const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

describe("DesktopBrowserHost", () => {
  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);

      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect(
    "replays a shown tab across backend restarts and reports its hide and detach lifecycle",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        host.setVisible(key, true);
        host.attach(key, makeDebuggee().tab);
        const announcement = [
          { type: "attached", ...key },
          { type: "visibility", ...key, visible: true },
        ];
        expect(yield* takeEvents(host, 2)).toEqual(announcement);

        const events = yield* Queue.unbounded<DesktopBrowserEvent>();
        const reader = yield* host.events.pipe(
          Stream.runForEach((line) =>
            Queue.offer(events, decodeEvent(new TextDecoder().decode(line))),
          ),
          Effect.forkScoped,
        );
        expect(yield* Queue.take(events)).toEqual(announcement[0]);
        expect(yield* Queue.take(events)).toEqual(announcement[1]);

        host.setVisible(key, false);
        host.setVisible(key, false);
        host.setVisible(key, true);
        expect(yield* Queue.take(events)).toEqual({ type: "visibility", ...key, visible: false });
        expect(yield* Queue.take(events)).toEqual({ type: "visibility", ...key, visible: true });

        host.detach(key);
        expect(yield* Queue.take(events)).toEqual({ type: "detached", ...key });
        // Guest replacement retains the panel's presentation until the panel hides.
        host.attach(key, makeDebuggee().tab);
        expect(yield* Queue.take(events)).toEqual(announcement[0]);
        expect(yield* Queue.take(events)).toEqual(announcement[1]);
        host.setVisible(key, false);
        expect(yield* Queue.take(events)).toEqual({ type: "visibility", ...key, visible: false });
        yield* Fiber.interrupt(reader);
        expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      }).pipe(Effect.scoped),
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
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const [, reply] = yield* Fiber.join(reader);

      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
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
