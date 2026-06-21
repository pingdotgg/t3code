import type { DesktopBridge, T3HostBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { __resetDesktopPrimaryAuthForTests, readDesktopPrimaryBearerToken } from "./desktopAuth";

describe("desktop primary auth", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("reuses the main-process bearer token across renderer requests", async () => {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
  });

  it("uses the host bootstrap bearer token before the desktop bridge", async () => {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.t3HostBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "VS Code environment",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
        bearerToken: "host-bearer-token",
      }),
    } as unknown as T3HostBridge;
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("host-bearer-token");
    expect(getLocalEnvironmentBearerToken).not.toHaveBeenCalled();
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });
});
