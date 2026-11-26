import { describe, expect, it, vi } from "vite-plus/test";

import { captureGuestPage } from "./GuestCapture.ts";

const nativePage = () =>
  ({
    capturePage: async () => ({
      toPNG: () => Buffer.from("native png"),
      toJPEG: (quality: number) => Buffer.from(`native jpeg ${quality}`),
    }),
  }) as unknown as Electron.WebContents;

const unavailableDebugger = {
  sendCommand: async (method: string) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate") return { result: { value: true } };
    throw new Error("CDP capture is blocked");
  },
} as unknown as Electron.Debugger;

describe("captureGuestPage", () => {
  it("returns a viewport frame when CDP capture is unavailable", async () => {
    let painted = "previous frame";
    const page = {
      capturePage: async () => {
        const pixels = painted;
        return { toPNG: () => Buffer.from(pixels) };
      },
    } as unknown as Electron.WebContents;
    const debuggee = {
      sendCommand: async (method: string) => {
        if (method === "Runtime.evaluate") painted = "current frame";
        return unavailableDebugger.sendCommand(method);
      },
    } as unknown as Electron.Debugger;
    const result = await captureGuestPage(page, debuggee, {});
    expect(result).toEqual({ data: Buffer.from("current frame").toString("base64") });
  });

  it("retains JPEG quality for remote viewer still frames", async () => {
    const result = await captureGuestPage(nativePage(), unavailableDebugger, {
      format: "jpeg",
      quality: 65,
    });
    expect(result).toEqual({ data: Buffer.from("native jpeg 65").toString("base64") });
  });

  it.each([false, undefined])("refuses unconfirmed paint (%s)", async (value) => {
    const debuggee = {
      sendCommand: async (method: string) =>
        method === "Runtime.evaluate"
          ? { result: { value } }
          : unavailableDebugger.sendCommand(method),
    } as unknown as Electron.Debugger;
    await expect(captureGuestPage(nativePage(), debuggee, {})).rejects.toThrow(
      "paint boundary was not confirmed",
    );
  });

  it("bounds a suspended renderer without returning stale pixels", async () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const debuggee = {
      sendCommand: () => new Promise(() => {}),
    } as unknown as Electron.Debugger;
    const result = expect(captureGuestPage(nativePage(), debuggee, {})).rejects.toThrow(
      "paint boundary timed out",
    );
    await vi.advanceTimersByTimeAsync(2500);
    await result;
  });

  it("preserves CDP capture options that native viewport capture cannot represent", async () => {
    const params = { format: "png", clip: { x: 10, y: 20, width: 30, height: 40, scale: 2 } };
    const debuggee = {
      sendCommand: async (method: string, received: unknown) => ({ method, received }),
    } as unknown as Electron.Debugger;
    expect(await captureGuestPage(nativePage(), debuggee, params)).toEqual({
      method: "Page.captureScreenshot",
      received: params,
    });
  });
});
