import type { Result as ActiveWindow } from "get-windows";
import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

const { createFromBitmapMock, resizeMock, screenshotMock } = vi.hoisted(() => ({
  createFromBitmapMock: vi.fn(),
  resizeMock: vi.fn(),
  screenshotMock: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeImage: { createFromBitmap: createFromBitmapMock },
}));

vi.mock("@crowecawcaw/xa11y", () => {
  const api = { screenshot: screenshotMock };
  return { ...api, default: api };
});

import { captureRegionWindowSnapshot } from "./RegionSnapShot.ts";

beforeEach(() => {
  vi.clearAllMocks();
  createFromBitmapMock.mockReturnValue({ resize: resizeMock });
});

it("captures a window region without rendering Chromium thumbnails", async () => {
  const png = Buffer.from([1, 2, 3]);
  screenshotMock.mockResolvedValue({
    width: 400,
    height: 300,
    toPng: () => png,
    get pixels() {
      throw new Error("Small captures should not copy their raw pixels");
    },
  });
  const active = {
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 10, y: 20, width: 800, height: 600 },
  } as ActiveWindow;
  const region = { x: 5, y: 10, width: 400, height: 300 };

  const capture = await captureRegionWindowSnapshot(active, region, region);

  assert.deepEqual(screenshotMock.mock.calls, [[{ region }]]);
  assert.strictEqual(capture.png, png);
  assert.deepEqual(capture.source, { name: "Editor" });
});

it.each([
  { width: 600, height: 400, expected: { width: 240, height: 160 } },
  { width: 400, height: 600, expected: { width: 107, height: 160 } },
  { width: 600, height: 1, expected: { width: 256, height: 1 } },
])(
  "bounds $width x $height physical pixels before encoding",
  async ({ width, height, expected }) => {
    const resizedPng = Buffer.from([4, 5, 6]);
    screenshotMock.mockResolvedValue({
      width,
      height,
      scale: 2,
      pixels: Buffer.alloc(width * height * 4),
      toPng: () => {
        throw new Error("Large captures should only encode the resized pixels");
      },
    });
    resizeMock.mockReturnValue({ toPNG: () => resizedPng });
    const active = {
      title: "Editor",
      owner: { name: "Editor", processId: 123 },
      bounds: { x: 0, y: 0, width: width / 2, height: height / 2 },
    } as ActiveWindow;

    const capture = await captureRegionWindowSnapshot(active, active.bounds, {
      width: 256,
      height: 160,
    });

    assert.deepEqual(resizeMock.mock.calls, [[{ ...expected, quality: "best" }]]);
    assert.strictEqual(capture.png, resizedPng);
  },
);

it("preserves screen colors when converting RGBA to an opaque Windows bitmap", async () => {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128, 13, 47, 91, 255]);
  screenshotMock.mockResolvedValue({ width: 4, height: 1, pixels });
  resizeMock.mockReturnValue({ toPNG: () => Buffer.from([1, 2, 3]) });
  const active = {
    title: "Editor",
    owner: { name: "Editor", processId: 123 },
    bounds: { x: 0, y: 0, width: 4, height: 1 },
  } as ActiveWindow;

  await captureRegionWindowSnapshot(active, active.bounds, { width: 2, height: 1 });

  const [bitmap, size] = createFromBitmapMock.mock.calls[0]!;
  assert.deepEqual(
    bitmap,
    Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 91, 47, 13, 255]),
  );
  assert.strictEqual(bitmap, pixels);
  assert.deepEqual(size, { width: 4, height: 1 });
});

it("times out a stalled capture without starting overlapping native work", async () => {
  vi.useFakeTimers();
  const native = Promise.withResolvers<unknown>();
  screenshotMock.mockReturnValueOnce(native.promise);
  const active = { title: "Editor", owner: { name: "Editor" } } as ActiveWindow;
  const region = { x: 0, y: 0, width: 1, height: 1 };
  try {
    let error: unknown;
    const capture = captureRegionWindowSnapshot(active, region, region).catch((cause) => {
      error = cause;
    });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(error).toMatchObject({ message: "Windows window capture timed out. Try again." });
    await capture;
    await expect(captureRegionWindowSnapshot(active, region, region)).rejects.toThrow(
      /still in progress/,
    );
    assert.lengthOf(screenshotMock.mock.calls, 1);
    const image = { width: 1, height: 1, toPng: () => Buffer.from([1]) };
    native.resolve(image);
    await vi.runAllTimersAsync();
    screenshotMock.mockResolvedValue(image);
    await expect(captureRegionWindowSnapshot(active, region, region)).resolves.toMatchObject({
      png: Buffer.from([1]),
    });
  } finally {
    native.resolve({ width: 1, height: 1, toPng: () => Buffer.from([1]) });
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
});
