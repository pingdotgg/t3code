import { FILL_PREVIEW_VIEWPORT, type PreviewViewportSetting } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewResizeTransactionQueue,
  resizePreviewViewportTransaction,
} from "./previewResizeTransaction";

const requestedSetting: PreviewViewportSetting = {
  _tag: "freeform",
  width: 1_920,
  height: 1_200,
};

describe("resizePreviewViewportTransaction", () => {
  it("returns the rendered viewport without rolling back a successful resize", async () => {
    const applySetting = vi.fn(async (setting: PreviewViewportSetting) => ({ viewport: setting }));
    const updateSnapshot = vi.fn();
    const waitForViewport = vi.fn(async () => ({ width: 1_920, height: 1_200 }));

    await expect(
      resizePreviewViewportTransaction({
        setting: requestedSetting,
        previousSetting: FILL_PREVIEW_VIEWPORT,
        timeoutMs: 15_000,
        applySetting,
        updateSnapshot,
        waitForViewport,
      }),
    ).resolves.toEqual({ width: 1_920, height: 1_200 });

    expect(applySetting).toHaveBeenCalledTimes(1);
    expect(updateSnapshot).toHaveBeenCalledTimes(1);
  });

  it("restores the previous setting when the requested viewport times out", async () => {
    const timeout = new Error("viewport timed out");
    const applySetting = vi.fn(async (setting: PreviewViewportSetting) => ({ viewport: setting }));
    const updateSnapshot = vi.fn();
    const waitForViewport = vi
      .fn<
        (
          setting: PreviewViewportSetting,
          timeoutMs: number,
        ) => Promise<{ width: number; height: number }>
      >()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ width: 1_280, height: 800 });

    await expect(
      resizePreviewViewportTransaction({
        setting: requestedSetting,
        previousSetting: FILL_PREVIEW_VIEWPORT,
        timeoutMs: 15_000,
        applySetting,
        updateSnapshot,
        waitForViewport,
      }),
    ).rejects.toBe(timeout);

    expect(applySetting.mock.calls.map(([setting]) => setting)).toEqual([
      requestedSetting,
      FILL_PREVIEW_VIEWPORT,
    ]);
    expect(updateSnapshot.mock.calls.map(([snapshot]) => snapshot.viewport)).toEqual([
      requestedSetting,
      FILL_PREVIEW_VIEWPORT,
    ]);
    expect(waitForViewport).toHaveBeenLastCalledWith(FILL_PREVIEW_VIEWPORT, 2_000);
  });

  it("preserves the original timeout when rollback also fails", async () => {
    const timeout = new Error("viewport timed out");
    const applySetting = vi
      .fn<(setting: PreviewViewportSetting) => Promise<{ viewport: PreviewViewportSetting }>>()
      .mockResolvedValueOnce({ viewport: requestedSetting })
      .mockRejectedValueOnce(new Error("rollback failed"));

    await expect(
      resizePreviewViewportTransaction({
        setting: requestedSetting,
        previousSetting: FILL_PREVIEW_VIEWPORT,
        timeoutMs: 15_000,
        applySetting,
        updateSnapshot: vi.fn(),
        waitForViewport: vi.fn(async () => {
          throw timeout;
        }),
      }),
    ).rejects.toBe(timeout);
  });
});

describe("createPreviewResizeTransactionQueue", () => {
  it("serializes transactions for the same preview tab", async () => {
    const queue = createPreviewResizeTransactionQueue();
    const events: string[] = [];
    let finishFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const first = queue.run("tab-1", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.run("tab-1", async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    finishFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows transactions for different preview tabs to run concurrently", async () => {
    const queue = createPreviewResizeTransactionQueue();
    const events: string[] = [];
    let finishFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const first = queue.run("tab-1", async () => {
      events.push("first:start");
      await firstGate;
    });
    const second = queue.run("tab-2", async () => {
      events.push("second:start");
    });

    await second;
    expect(events).toEqual(["first:start", "second:start"]);

    finishFirst();
    await first;
  });
});
