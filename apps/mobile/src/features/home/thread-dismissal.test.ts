import { describe, expect, it, vi } from "vite-plus/test";

import { registerThreadDismissal, withThreadDismissal } from "./thread-dismissal";

describe("thread dismissal", () => {
  it("waits for every visible copy before changing thread state", async () => {
    const home = Promise.withResolvers<void>();
    const sidebar = Promise.withResolvers<void>();
    const restore = vi.fn();
    const unregisterHome = registerThreadDismissal("env:thread", () => ({
      finished: home.promise,
      restore,
    }));
    const unregisterSidebar = registerThreadDismissal("env:thread", () => ({
      finished: sidebar.promise,
      restore,
    }));
    const command = vi.fn(async () => true);
    try {
      const result = withThreadDismissal("env:thread", command, Boolean);
      expect(command).not.toHaveBeenCalled();
      home.resolve();
      await home.promise;
      expect(command).not.toHaveBeenCalled();
      sidebar.resolve();
      expect(await result).toBe(true);
      expect(command).toHaveBeenCalledOnce();
      expect(restore).not.toHaveBeenCalled();
    } finally {
      unregisterHome();
      unregisterSidebar();
    }
  });

  it.each([false, "throw"])(
    "restores dismissed rows when the command returns %s",
    async (outcome) => {
      const restore = vi.fn();
      const unregister = registerThreadDismissal("env:thread", () => ({
        finished: Promise.resolve(),
        restore,
      }));
      try {
        const result = withThreadDismissal(
          "env:thread",
          async () => {
            if (outcome === "throw") throw new Error("Disconnected");
            return outcome;
          },
          Boolean,
        );
        if (outcome === "throw") await expect(result).rejects.toThrow("Disconnected");
        else expect(await result).toBe(false);
        expect(restore).toHaveBeenCalledOnce();
      } finally {
        unregister();
      }
    },
  );

  it("does not animate another environment or a recycled row", async () => {
    const dismiss = vi.fn(() => ({ finished: Promise.resolve(), restore: vi.fn() }));
    const unregisterOther = registerThreadDismissal("other:thread", dismiss);
    const unregisterRecycled = registerThreadDismissal("env:thread", dismiss);
    unregisterRecycled();
    try {
      expect(await withThreadDismissal("env:thread", async () => true, Boolean)).toBe(true);
      expect(dismiss).not.toHaveBeenCalled();
    } finally {
      unregisterOther();
    }
  });
});
