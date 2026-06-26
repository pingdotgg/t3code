import type { PreviewViewportSetting } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  commitViewportAndAspectRatio,
  reconcileLockedAspectRatio,
} from "./browserDeviceToolbarState";

describe("commitViewportAndAspectRatio", () => {
  it("commits the aspect ratio only after the viewport succeeds", async () => {
    let resolveChange: (() => void) | undefined;
    const onChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChange = resolve;
        }),
    );
    const onAspectRatioChange = vi.fn();
    const setting: PreviewViewportSetting = { _tag: "freeform", width: 900, height: 600 };

    const commit = commitViewportAndAspectRatio(setting, 1.5, onChange, onAspectRatioChange);
    expect(onAspectRatioChange).not.toHaveBeenCalled();

    resolveChange?.();
    await commit;
    expect(onAspectRatioChange).toHaveBeenCalledWith(1.5);
  });

  it("keeps the previous aspect ratio when the viewport commit fails", async () => {
    const onAspectRatioChange = vi.fn();
    await expect(
      commitViewportAndAspectRatio(
        { _tag: "fill" },
        null,
        async () => Promise.reject(new Error("resize failed")),
        onAspectRatioChange,
      ),
    ).rejects.toThrow("resize failed");
    expect(onAspectRatioChange).not.toHaveBeenCalled();
  });
});

describe("reconcileLockedAspectRatio", () => {
  it("tracks external viewport ratios only while the lock remains active", () => {
    expect(reconcileLockedAspectRatio(1.5, 16 / 9)).toBe(16 / 9);
    expect(reconcileLockedAspectRatio(null, 16 / 9)).toBeNull();
    expect(reconcileLockedAspectRatio(1.5, null)).toBeNull();
  });
});
