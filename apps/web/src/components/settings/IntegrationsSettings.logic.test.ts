import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import { browserProfileRemovalAvailable, clearBrowserProfileData } from "./IntegrationsSettings";

const environmentId = "environment-a" as EnvironmentId;
const secondEnvironmentId = "environment-b" as EnvironmentId;

describe("clearBrowserProfileData", () => {
  it("waits for cookie and cache cleanup", async () => {
    const clearCookies = vi.fn().mockResolvedValue(undefined);
    const clearCache = vi.fn().mockResolvedValue(undefined);

    await clearBrowserProfileData({ clearCookies, clearCache }, [environmentId], "profile-a");

    expect(clearCookies).toHaveBeenCalledWith(environmentId, "profile-a");
    expect(clearCache).toHaveBeenCalledWith(environmentId, "profile-a");
  });

  it("clears every known environment before succeeding", async () => {
    const clearCookies = vi.fn().mockResolvedValue(undefined);
    const clearCache = vi.fn().mockResolvedValue(undefined);

    await clearBrowserProfileData(
      { clearCookies, clearCache },
      [environmentId, secondEnvironmentId],
      "profile-a",
    );

    expect(clearCookies.mock.calls).toEqual([
      [environmentId, "profile-a"],
      [secondEnvironmentId, "profile-a"],
    ]);
    expect(clearCache.mock.calls).toEqual([
      [environmentId, "profile-a"],
      [secondEnvironmentId, "profile-a"],
    ]);
  });

  it("propagates cleanup failures", async () => {
    const failure = new Error("clear failed");
    await expect(
      clearBrowserProfileData(
        {
          clearCookies: vi.fn().mockRejectedValue(failure),
          clearCache: vi.fn().mockResolvedValue(undefined),
        },
        [environmentId],
        "profile-a",
      ),
    ).rejects.toBe(failure);
  });

  it("does not report success without an environment or bridge", async () => {
    const bridge = {
      clearCookies: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
    };

    await expect(clearBrowserProfileData(bridge, [], "profile-a")).rejects.toThrow();
    await expect(clearBrowserProfileData(null, [environmentId], "profile-a")).rejects.toThrow();
    expect(bridge.clearCookies).not.toHaveBeenCalled();
    expect(bridge.clearCache).not.toHaveBeenCalled();
  });
});

describe("browserProfileRemovalAvailable", () => {
  it("requires a ready non-empty catalog and desktop bridge", () => {
    expect(browserProfileRemovalAvailable(true, true, 1)).toBe(true);
    expect(browserProfileRemovalAvailable(true, true, 0)).toBe(false);
    expect(browserProfileRemovalAvailable(true, false, 1)).toBe(false);
    expect(browserProfileRemovalAvailable(false, true, 1)).toBe(false);
  });
});
