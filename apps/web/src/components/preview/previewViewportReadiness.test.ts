import { describe, expect, it, vi } from "vite-plus/test";

import { browserViewportSettingKey } from "~/browser/browserViewportLayout";

import {
  isPreviewViewportReady,
  waitForPreviewViewportReadiness,
} from "./previewViewportReadiness";

describe("isPreviewViewportReady", () => {
  const landscape = {
    _tag: "preset",
    width: 844,
    height: 390,
    presetId: "iphone-12-pro",
  } as const;

  it("rejects a stale same-mode preset while React applies the requested orientation", () => {
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey: "preset:390:844:iphone-12-pro",
        declaredViewport: { width: 390, height: 844 },
        renderedViewport: { width: 390, height: 844 },
      }),
    ).toBe(false);
  });

  it("requires both the declaration and guest viewport to match a fixed request", () => {
    const appliedSettingKey = browserViewportSettingKey(landscape);
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey,
        declaredViewport: { width: 390, height: 844 },
        renderedViewport: { width: 844, height: 390 },
      }),
    ).toBe(false);
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey,
        declaredViewport: { width: 844, height: 390 },
        renderedViewport: { width: 844, height: 390 },
      }),
    ).toBe(true);
  });

  it("allows one pixel of Electron rounding tolerance in every mode", () => {
    expect(
      isPreviewViewportReady({
        setting: { _tag: "fill" },
        appliedSettingKey: "fill",
        declaredViewport: { width: 500, height: 700 },
        renderedViewport: { width: 501, height: 699 },
      }),
    ).toBe(true);
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey: browserViewportSettingKey(landscape),
        declaredViewport: { width: 844, height: 390 },
        renderedViewport: { width: 845, height: 389 },
      }),
    ).toBe(true);
    expect(
      isPreviewViewportReady({
        setting: landscape,
        appliedSettingKey: browserViewportSettingKey(landscape),
        declaredViewport: { width: 844, height: 390 },
        renderedViewport: { width: 846, height: 390 },
      }),
    ).toBe(false);
  });
});

describe("waitForPreviewViewportReadiness", () => {
  const setting = {
    _tag: "preset",
    width: 844,
    height: 390,
    presetId: "iphone-12-pro",
  } as const;
  const readyViewport = {
    appliedSettingKey: browserViewportSettingKey(setting),
    declaredViewport: { width: 844, height: 390 },
    renderedViewport: { width: 844, height: 390 },
  } as const;

  it("clamps polling to the remaining short deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout });
    try {
      const result = waitForPreviewViewportReadiness({
        setting,
        timeoutMs: 40,
        assertCurrent: vi.fn(),
        readViewport: vi.fn().mockResolvedValue(null),
      });

      await vi.advanceTimersByTimeAsync(40);
      await expect(result).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("revalidates runtime identity after an awaited viewport read", async () => {
    let resolveViewport!: (value: typeof readyViewport) => void;
    const readViewport = vi.fn(
      () =>
        new Promise<typeof readyViewport>((resolve) => {
          resolveViewport = resolve;
        }),
    );
    const replaced = new Error("runtime replaced");
    const assertCurrent = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw replaced;
      });
    const result = waitForPreviewViewportReadiness({
      setting,
      timeoutMs: 1_000,
      assertCurrent,
      readViewport,
    });

    resolveViewport(readyViewport);

    await expect(result).rejects.toBe(replaced);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
});
