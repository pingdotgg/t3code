import { describe, expect, it } from "vite-plus/test";

import { captureGuestPage } from "./GuestCapture.ts";

const nativePage = () =>
  ({
    capturePage: async () => ({
      toPNG: () => Buffer.from("native png"),
      toJPEG: (quality: number) => Buffer.from(`native jpeg ${quality}`),
    }),
  }) as unknown as Electron.WebContents;

const unavailableDebugger = {
  sendCommand: async () => {
    throw new Error("CDP capture is blocked");
  },
} as unknown as Electron.Debugger;

describe("captureGuestPage", () => {
  it("returns a viewport frame when CDP capture is unavailable", async () => {
    const result = await captureGuestPage(nativePage(), unavailableDebugger, {});
    expect(result).toEqual({ data: Buffer.from("native png").toString("base64") });
  });

  it("retains JPEG quality for remote viewer still frames", async () => {
    const result = await captureGuestPage(nativePage(), unavailableDebugger, {
      format: "jpeg",
      quality: 65,
    });
    expect(result).toEqual({ data: Buffer.from("native jpeg 65").toString("base64") });
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
