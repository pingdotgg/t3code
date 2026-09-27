import * as NodeEvents from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  installPreviewPasskeys,
  PASSKEY_AVAILABLE,
  PASSKEY_CANCEL,
  PASSKEY_REQUEST,
} from "./Passkeys.ts";
import type { NativePasskeys, PasskeyResult } from "./NativePasskeys.ts";

function harness(loadOverride?: () => Promise<NativePasskeys | undefined>) {
  const frame = { url: "https://example.com/login", detached: false };
  const owner = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8) };
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    mainFrame: frame,
    isFocused: (): boolean => true,
    ipc: Object.assign(new NodeEvents.EventEmitter(), { handle: vi.fn() }),
  });
  const started = Promise.withResolvers<AbortSignal>();
  const completed = Promise.withResolvers<PasskeyResult>();
  const native: NativePasskeys = {
    available: () => true,
    start: vi.fn((_options, _window, signal) => {
      started.resolve(signal);
      signal.addEventListener("abort", () => completed.resolve({ error: "AbortError" }), {
        once: true,
      });
      return completed.promise;
    }),
  };
  installPreviewPasskeys(
    contents as unknown as WebContents,
    owner as unknown as BrowserWindow,
    [],
    loadOverride ?? (() => Promise.resolve(native)),
  );
  const handler = (channel: string) =>
    contents.ipc.handle.mock.calls.find(([name]) => name === channel)![1] as (
      event: { senderFrame: unknown },
      ...args: unknown[]
    ) => Promise<unknown>;
  const request = (senderFrame: unknown = frame) =>
    handler(PASSKEY_REQUEST)({ senderFrame }, "request-1", "get", { challenge: "AQID" });
  return { contents, frame, native, started: started.promise, completed, request, handler };
}

describe("preview passkey lifecycle", () => {
  it("does not start a native request during capability checks", async () => {
    const h = harness();
    expect(await h.handler(PASSKEY_AVAILABLE)({ senderFrame: h.frame })).toBe(true);
    expect(h.native.start).not.toHaveBeenCalled();
  });
  it("rejects subframes and unfocused content before touching credentials", async () => {
    const h = harness();
    expect(await h.request({ url: "https://example.com" })).toEqual({ error: "NotAllowedError" });
    h.contents.isFocused = () => false;
    expect(await h.request()).toEqual({ error: "NotAllowedError" });
    expect(h.native.start).not.toHaveBeenCalled();
  });
  it("keeps Chromium available when the native entitlement is absent", async () => {
    const h = harness(() => Promise.resolve(undefined));
    expect(await h.request()).toBeNull();
  });
  it.each(["destroyed", "render-process-gone", "did-start-navigation"])(
    "cancels when the page emits %s",
    async (event) => {
      const h = harness();
      const result = h.request();
      const signal = await h.started;
      h.contents.emit(event, { isMainFrame: true, isSameDocument: false });
      expect(signal.aborted).toBe(true);
      expect(await result).toEqual({ error: "AbortError" });
    },
  );
  it("ignores same-document navigation and other frames' cancellation", async () => {
    const h = harness();
    const result = h.request();
    const signal = await h.started;
    h.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    h.contents.ipc.emit(PASSKEY_CANCEL, { senderFrame: {} }, "request-1");
    expect(signal.aborted).toBe(false);
    h.contents.ipc.emit(PASSKEY_CANCEL, { senderFrame: h.frame }, "request-1");
    expect(await result).toEqual({ error: "AbortError" });
  });
  it("does not present a delayed request after the page closes", async () => {
    const loaded = Promise.withResolvers<NativePasskeys | undefined>();
    const h = harness(() => loaded.promise);
    const result = h.request();
    h.contents.emit("destroyed");
    loaded.resolve(h.native);
    expect(await result).toEqual({ error: "AbortError" });
    expect(h.native.start).not.toHaveBeenCalled();
  });
  it("admits one sheet across profiles and releases it after completion", async () => {
    const first = harness();
    const result = first.request();
    await first.started;
    const second = harness();
    expect(await second.request()).toEqual({ error: "NotAllowedError" });
    first.completed.resolve({ error: "NotAllowedError" });
    await result;
    const next = second.request();
    await second.started;
    second.completed.resolve({ error: "NotAllowedError" });
    expect(await next).toEqual({ error: "NotAllowedError" });
  });
});
