// @effect-diagnostics nodeBuiltinImport:off -- Exercise the native renderer boundary with event-driven fixtures.
import * as NodeEvents from "node:events";
import { expect, it, vi } from "vite-plus/test";

const { createView, decodeOnMain } = vi.hoisted(() => ({
  createView: vi.fn(),
  decodeOnMain: vi.fn(() => ({
    isEmpty: () => false,
    getSize: () => ({ width: 800, height: 600 }),
  })),
}));
vi.mock("electron", () => ({
  WebContentsView: class {
    webContents = createView();
  },
  nativeImage: { createFromBuffer: decodeOnMain },
}));

import { resizeLinuxCapture } from "./linuxCaptureSession.ts";

function setup() {
  decodeOnMain.mockClear();
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    loadURL: vi.fn(async () => undefined),
    send: vi.fn(),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
  });
  createView.mockReset().mockReturnValue(contents);
  return contents;
}

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

it("waits for PNG processing in a renderer without decoding on the main process", async () => {
  const contents = setup();
  const result = resizeLinuxCapture(png);
  expect(result).toBeInstanceOf(Promise);
  await Promise.resolve();
  expect(decodeOnMain).not.toHaveBeenCalled();
  expect(contents.send).toHaveBeenCalledWith("t3:linux-capture", png);
  const resized = new Uint8Array([1, 2, 3]);
  contents.emit("ipc-message", {}, "t3:linux-capture", resized);
  expect(await result).toEqual(Buffer.from(resized));
  expect(contents.close).toHaveBeenCalledOnce();
});

it.each(["The window screenshot is empty.", "Window screenshot processing failed."])(
  "propagates renderer errors and closes it: %s",
  async (message) => {
    const contents = setup();
    const result = resizeLinuxCapture(png);
    contents.emit("ipc-message", {}, "t3:linux-capture", message);
    await expect(result).rejects.toThrow(message);
    expect(contents.close).toHaveBeenCalledOnce();
  },
);

it.each(["render-process-gone", "destroyed"])(
  "rejects if the renderer is lost: %s",
  async (event) => {
    const contents = setup();
    const result = resizeLinuxCapture(png);
    contents.emit(event);
    await expect(result).rejects.toThrow("Window screenshot processing exited.");
  },
);

it("closes the renderer when loading fails", async () => {
  const contents = setup();
  contents.loadURL.mockRejectedValue(new Error("load failed"));
  await expect(resizeLinuxCapture(png)).rejects.toThrow("load failed");
  expect(contents.close).toHaveBeenCalledOnce();
});

it("closes the renderer if the preload fails", async () => {
  const contents = setup();
  const result = resizeLinuxCapture(png);
  contents.emit("preload-error", {}, "preload.cjs", new Error("preload failed"));
  await expect(result).rejects.toThrow("preload failed");
  expect(contents.close).toHaveBeenCalledOnce();
});

it("bounds a stalled renderer's lifetime", async () => {
  const contents = setup();
  vi.useFakeTimers();
  try {
    const result = resizeLinuxCapture(png);
    const rejection = expect(result).rejects.toThrow("Window screenshot processing timed out.");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(contents.close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it.each([Buffer.from("not a PNG"), Buffer.alloc(32 * 1024 * 1024 + 1)])(
  "rejects invalid or oversized PNGs before creating a renderer",
  async (input) => {
    setup();
    await expect(resizeLinuxCapture(input)).rejects.toThrow(
      "Invalid or oversized window screenshot.",
    );
    expect(createView).not.toHaveBeenCalled();
  },
);
