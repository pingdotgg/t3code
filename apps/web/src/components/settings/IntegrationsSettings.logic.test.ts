import { describe, expect, it, vi } from "vite-plus/test";
import { type EnvironmentId, managedPolicyDeniedMessage } from "@t3tools/contracts";

import {
  clearBrowserProfileData,
  importFailureReason,
  importPolicyRefusal,
} from "./IntegrationsSettings";

const environmentId = "environment-a" as EnvironmentId;
const secondEnvironmentId = "environment-b" as EnvironmentId;

describe("clearBrowserProfileData", () => {
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

describe("clearBrowserProfileData with server browsers", () => {
  it("clears server-hosted profiles without a desktop bridge", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    await clearBrowserProfileData(null, [environmentId, secondEnvironmentId], "profile-a", {
      environmentIds: [secondEnvironmentId],
      clear,
    });
    expect(clear).toHaveBeenCalledExactlyOnceWith(secondEnvironmentId, "profile-a");
  });

  it("clears both copies and fails when the server copy fails", async () => {
    const bridge = {
      clearCookies: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
    };
    const failure = new Error("server failed");
    await expect(
      clearBrowserProfileData(bridge, [environmentId], "profile-a", {
        environmentIds: [environmentId],
        clear: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);
    expect(bridge.clearCookies).toHaveBeenCalledWith(environmentId, "profile-a");
  });
});

// Mirrors `BrowserImportFailedError.message`, which IPC flattens to a string
// before the renderer sees it.
const failure = (reason: string) => ({
  message: `Importing cookies from safari failed: ${reason}.`,
});

describe("importFailureReason", () => {
  it("recovers the reason token from the flattened message", () => {
    expect(importFailureReason(failure("needsFullDiskAccess"))).toBe("needsFullDiskAccess");
    expect(importFailureReason(failure("browserRunning"))).toBe("browserRunning");
    expect(importFailureReason(failure("readFailed"))).toBe("readFailed");
    expect(importFailureReason(failure("keychainUnavailable"))).toBe("keychainUnavailable");
    expect(importFailureReason(failure("profileNotSaved"))).toBe("profileNotSaved");
    expect(importFailureReason(failure("profileLimitReached"))).toBe("profileLimitReached");
  });
});

describe("importPolicyRefusal", () => {
  it("recovers a managed policy's refusal from the IPC-wrapped message", () => {
    const denied = managedPolicyDeniedMessage("Example Corp", "importing browser cookies");
    expect(
      importPolicyRefusal({
        message: `Error invoking remote method 'desktop:preview-import-cookies': BrowserImportPolicyError: ${denied}`,
      }),
    ).toBe(denied);
    const unreadable =
      "The managed policy at C:\\Program Files\\T3Code\\policy.json could not be read, so importing browser cookies is not allowed.";
    expect(importPolicyRefusal({ message: `Error: ${unreadable}` })).toBe(unreadable);
  });

  it("leaves other failures to their reason token", () => {
    expect(importPolicyRefusal(failure("readFailed"))).toBeUndefined();
  });
});
