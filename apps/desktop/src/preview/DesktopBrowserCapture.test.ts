// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent, type DesktopPreviewCaptureRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const key = { threadId: "thread", tabId: "tab" };
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Struct({ message: Schema.String })),
    }),
  ),
);

const makeGuest = (id = 41) => {
  const nativeStarted = Promise.withResolvers<void>();
  const screenshotStarted = Promise.withResolvers<void>();
  const capturePage = vi.fn(async (_rect: unknown, _options: unknown) => {
    nativeStarted.resolve();
    return {};
  });
  const screenshot = vi.fn(async (_parameters: object) => {
    screenshotStarted.resolve();
    return { data: "encoded-by-cdp" };
  });
  const sendCommand = vi.fn(async (method: string, parameters: object, _sessionId?: string) =>
    method === "Page.captureScreenshot" ? screenshot(parameters) : { method },
  );
  return {
    capturePage,
    screenshot,
    sendCommand,
    nativeStarted,
    screenshotStarted,
    tab: {
      withCaptureActivity: <A, E>(capture: Effect.Effect<A, E>) => capture,
      webContents: {
        id,
        capturePage,
        isDestroyed: vi.fn(() => false),
        getURL: () => "http://localhost/",
        getTitle: () => "Fixture",
        getUserAgent: () => "Electron",
      } as unknown as Electron.WebContents,
      debugger: Object.assign(new NodeEvents.EventEmitter(), {
        sendCommand,
      }) as unknown as Electron.Debugger,
    },
  };
};

const setup = Effect.gen(function* () {
  const host = yield* DesktopBrowserHost.make;
  const guest = makeGuest();
  host.attach(key, guest.tab);
  const leases = yield* Queue.unbounded<DesktopPreviewCaptureRequest>();
  const replies = yield* Queue.unbounded<ReturnType<typeof decodeReply>>();
  yield* host.captureRequests.pipe(
    Stream.runForEach((event) => Queue.offer(leases, event)),
    Effect.forkScoped,
  );
  yield* host.events.pipe(
    Stream.runForEach((line) => {
      const event = decodeEvent(new TextDecoder().decode(line));
      return event.type === "cdp" ? Queue.offer(replies, decodeReply(event.message)) : Effect.void;
    }),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  const command = (
    id: number,
    method = "Page.captureScreenshot",
    params: object = {},
    sessionId = "t3-preview-page",
  ) =>
    host.handleCommandLine(
      JSON.stringify({
        type: "cdp",
        ...key,
        message: JSON.stringify({ id, method, params, sessionId }),
      }),
    );
  const acknowledge = Effect.gen(function* () {
    const event = yield* Queue.take(leases);
    expect(event.active).toBe(true);
    host.acknowledgeCapture(event.requestId);
    return event;
  });
  return { host, guest, leases, replies, command, acknowledge };
});

describe("desktop agent screenshot rendering lease", () => {
  it.effect("waits for placement, warms the compositor and preserves CDP parameters", () =>
    Effect.gen(function* () {
      const { host, guest, leases, replies, command } = yield* setup;
      const parameters = {
        format: "jpeg",
        quality: 72,
        clip: { x: 12, y: 340, width: 600, height: 400, scale: 0.5 },
        captureBeyondViewport: false,
      };
      yield* command(1, "Page.captureScreenshot", parameters);
      const active = yield* Queue.take(leases);
      expect(guest.capturePage).not.toHaveBeenCalled();
      expect(guest.sendCommand).not.toHaveBeenCalled();
      host.acknowledgeCapture(active.requestId);
      expect(yield* Queue.take(replies)).toEqual({ id: 1, result: { data: "encoded-by-cdp" } });
      expect(guest.capturePage.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(guest.capturePage.mock.calls.length).toBeLessThanOrEqual(2);
      for (const args of guest.capturePage.mock.calls) {
        expect(args).toEqual([undefined, { stayHidden: true, stayAwake: false }]);
      }
      expect(guest.screenshot).toHaveBeenCalledExactlyOnceWith(parameters);
      expect(yield* Queue.take(leases)).toEqual({ ...active, active: false });
    }).pipe(Effect.scoped),
  );

  it.effect("releases a missing renderer acknowledgement and ignores a late one", () =>
    Effect.gen(function* () {
      const { host, guest, leases, replies, command } = yield* setup;
      yield* command(1);
      const active = yield* Queue.take(leases);
      yield* TestClock.adjust("2 seconds");
      expect((yield* Queue.take(replies)).error?.message).toContain("paintable within 2 seconds");
      expect(yield* Queue.take(leases)).toEqual({ ...active, active: false });
      host.acknowledgeCapture(active.requestId);
      yield* command(2, "DOM.enable");
      expect((yield* Queue.take(replies)).id).toBe(2);
      expect(guest.capturePage).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );

  it.effect("reports a destroyed guest with one capture failure prefix", () =>
    Effect.gen(function* () {
      const { guest, leases, replies, command, acknowledge } = yield* setup;
      yield* command(1);
      vi.mocked(guest.tab.webContents.isDestroyed).mockReturnValue(true);
      const active = yield* acknowledge;
      expect((yield* Queue.take(replies)).error?.message).toBe(
        "Desktop browser screenshot failed: the browser tab changed during capture.",
      );
      expect(yield* Queue.take(leases)).toEqual({ ...active, active: false });
      expect(guest.capturePage).not.toHaveBeenCalled();
      expect(guest.screenshot).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );

  it.effect.each(["reject", "throw"] as const)(
    "returns the CDP screenshot even if native warmup fails with %s",
    (failure) =>
      Effect.gen(function* () {
        const { guest, leases, replies, command, acknowledge } = yield* setup;
        const cause = new Error("native unavailable");
        if (failure === "reject") guest.capturePage.mockRejectedValueOnce(cause);
        else
          guest.capturePage.mockImplementationOnce(() => {
            throw cause;
          });
        yield* command(1);
        const active = yield* acknowledge;
        expect(yield* Queue.take(replies)).toEqual({ id: 1, result: { data: "encoded-by-cdp" } });
        expect(yield* Queue.take(leases)).toEqual({ ...active, active: false });
      }).pipe(Effect.scoped),
  );

  it.effect("preserves the CDP failure cause and allows a retry", () =>
    Effect.gen(function* () {
      const { guest, leases, replies, command, acknowledge } = yield* setup;
      const cause = new Error("internal compositor failure detail");
      const captureFailed = vi.fn<(error: unknown) => void>();
      guest.tab.withCaptureActivity = (capture) =>
        capture.pipe(Effect.tapError((error) => Effect.sync(() => captureFailed(error))));
      guest.screenshot.mockRejectedValueOnce(cause);
      yield* command(1);
      const active = yield* acknowledge;
      expect((yield* Queue.take(replies)).error?.message).toBe(
        "Desktop browser screenshot failed: the compositor could not capture a frame.",
      );
      expect(captureFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cause }));
      expect(yield* Queue.take(leases)).toEqual({ ...active, active: false });
      yield* command(2);
      yield* acknowledge;
      expect(yield* Queue.take(replies)).toEqual({ id: 2, result: { data: "encoded-by-cdp" } });
    }).pipe(Effect.scoped),
  );

  it.effect.each(["success", "failure"] as const)(
    "returns CDP %s while retaining the slot for pending native work",
    (outcome) =>
      Effect.gen(function* () {
        const { guest, leases, replies, command, acknowledge } = yield* setup;
        const pending = Promise.withResolvers<object>();
        guest.capturePage.mockImplementationOnce(() => pending.promise);
        if (outcome === "failure") guest.screenshot.mockRejectedValueOnce(new Error("CDP failed"));
        yield* command(1);
        const active = yield* acknowledge;
        const reply = yield* Queue.take(replies);
        if (outcome === "success")
          expect(reply).toEqual({ id: 1, result: { data: "encoded-by-cdp" } });
        else
          expect(reply.error?.message).toBe(
            "Desktop browser screenshot failed: the compositor could not capture a frame.",
          );
        expect(yield* Queue.take(leases)).toEqual({ ...active, active: false });
        yield* command(2);
        expect((yield* Queue.take(replies)).error?.message).toContain(
          "previous capture is still pending",
        );
        yield* command(3, "DOM.enable");
        expect((yield* Queue.take(replies)).id).toBe(3);
        pending.resolve({});
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        expect(guest.capturePage).toHaveBeenCalledTimes(1);
        yield* command(4);
        yield* acknowledge;
        expect(yield* Queue.take(replies)).toEqual({ id: 4, result: { data: "encoded-by-cdp" } });
      }).pipe(Effect.scoped),
  );

  it.effect("bounds CDP waiting without accumulating captures or blocking DOM commands", () =>
    Effect.gen(function* () {
      const { guest, leases, replies, command, acknowledge } = yield* setup;
      const pending = Promise.withResolvers<{ data: string }>();
      guest.screenshot.mockImplementationOnce(() => {
        guest.screenshotStarted.resolve();
        return pending.promise;
      });
      yield* command(1);
      const active = yield* acknowledge;
      yield* Effect.promise(() => guest.screenshotStarted.promise);
      yield* TestClock.adjust("8 seconds");
      expect((yield* Queue.take(replies)).error?.message).toContain("within 8 seconds");
      expect(yield* Queue.take(leases)).toEqual({ ...active, active: false });
      yield* command(2);
      expect((yield* Queue.take(replies)).error?.message).toContain(
        "previous capture is still pending",
      );
      yield* command(3, "DOM.enable");
      expect((yield* Queue.take(replies)).id).toBe(3);
      expect(guest.capturePage).toHaveBeenCalledTimes(2);
      pending.resolve({ data: "late-image" });
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      expect(guest.screenshot).toHaveBeenCalledTimes(1);
      yield* command(4);
      yield* acknowledge;
      expect(yield* Queue.take(replies)).toEqual({ id: 4, result: { data: "encoded-by-cdp" } });
      expect(guest.capturePage.mock.calls.length).toBeLessThanOrEqual(4);
    }).pipe(Effect.scoped),
  );

  it.effect("retains the pending CDP slot when native capture throws synchronously", () =>
    Effect.gen(function* () {
      const { guest, leases, replies, command, acknowledge } = yield* setup;
      const pending = Promise.withResolvers<{ data: string }>();
      guest.screenshot.mockImplementationOnce(() => {
        guest.screenshotStarted.resolve();
        return pending.promise;
      });
      guest.capturePage.mockImplementationOnce(() => {
        throw new Error("native unavailable");
      });
      yield* command(1);
      yield* acknowledge;
      yield* Effect.promise(() => guest.screenshotStarted.promise);
      yield* TestClock.adjust("8 seconds");
      expect((yield* Queue.take(replies)).error?.message).toContain("within 8 seconds");
      expect((yield* Queue.take(leases)).active).toBe(false);
      yield* command(2);
      expect((yield* Queue.take(replies)).error?.message).toContain(
        "previous capture is still pending",
      );
      expect(guest.screenshot).toHaveBeenCalledTimes(1);
      pending.resolve({ data: "discarded" });
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      yield* command(3);
      yield* acknowledge;
      expect((yield* Queue.take(replies)).result).toEqual({ data: "encoded-by-cdp" });
    }).pipe(Effect.scoped),
  );

  it.effect.each(["release", "detach", "replace"] as const)(
    "releases placement on %s and discards late native work",
    (lifecycle) =>
      Effect.gen(function* () {
        const { host, guest, leases, replies, command, acknowledge } = yield* setup;
        const pending = Promise.withResolvers<{ data: string }>();
        guest.screenshot.mockImplementationOnce(() => pending.promise);
        guest.capturePage.mockImplementationOnce(() => {
          guest.nativeStarted.resolve();
          return pending.promise;
        });
        yield* command(1);
        const active = yield* acknowledge;
        yield* Effect.promise(() => guest.nativeStarted.promise);
        if (lifecycle === "release")
          yield* host.handleCommandLine(JSON.stringify({ type: "release", ...key }));
        else if (lifecycle === "detach") host.detach(key);
        else host.attach(key, makeGuest(42).tab);
        expect(yield* Queue.take(leases)).toEqual({ ...active, active: false });
        if (lifecycle === "detach") host.attach(key, guest.tab);
        pending.resolve({ data: "discarded" });
        yield* command(2, "DOM.enable");
        expect((yield* Queue.take(replies)).id).toBe(2);
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        expect(guest.screenshot).toHaveBeenCalledTimes(1);
      }).pipe(Effect.scoped),
  );

  it.effect("leaves child-session screenshots on their own CDP target", () =>
    Effect.gen(function* () {
      const { guest, replies, command } = yield* setup;
      yield* command(1, "Page.captureScreenshot", { format: "png" }, "child-session");
      expect((yield* Queue.take(replies)).result).toEqual({ data: "encoded-by-cdp" });
      expect(guest.sendCommand).toHaveBeenCalledExactlyOnceWith(
        "Page.captureScreenshot",
        { format: "png" },
        "child-session",
      );
      expect(guest.capturePage).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );
});
