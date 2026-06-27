import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

const { closeTab, createTab } = vi.hoisted(() => ({
  closeTab: vi.fn(async () => undefined),
  createTab: vi.fn<() => Promise<void>>(),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { closeTab, createTab },
}));

import { acquireDesktopTab } from "./desktopTabLifetime";

describe("desktopTabLifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    });
    closeTab.mockClear();
    createTab.mockClear();
  });

  it("shares tab creation readiness across concurrent leases", async () => {
    let resolveCreation: (() => void) | undefined;
    createTab.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCreation = resolve;
      }),
    );

    const environmentId = "env_test" as EnvironmentId;
    const first = acquireDesktopTab("tab_readiness", environmentId, "https://example.com");
    const second = acquireDesktopTab("tab_readiness", environmentId, "https://example.com");

    expect(createTab).toHaveBeenCalledOnce();
    expect(createTab).toHaveBeenCalledWith("tab_readiness", environmentId, "https://example.com");
    expect(first.ready).toBe(second.ready);

    let ready = false;
    void first.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    resolveCreation?.();
    await first.ready;
    expect(ready).toBe(true);

    first.release();
    second.release();
    await vi.runAllTimersAsync();
    expect(closeTab).toHaveBeenCalledWith("tab_readiness");
  });
});
