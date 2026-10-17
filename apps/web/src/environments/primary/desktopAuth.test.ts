import type { DesktopBridge } from "@t3tools/contracts";
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

  it("shares one main-process request between concurrent renderer reads", async () => {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(
      Promise.all([readDesktopPrimaryBearerToken(), readDesktopPrimaryBearerToken()]),
    ).resolves.toEqual(["desktop-bearer-token", "desktop-bearer-token"]);
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
  });

  it("picks up a bearer token the main process renewed", async () => {
    const getLocalEnvironmentBearerToken = vi
      .fn()
      .mockResolvedValueOnce("desktop-bearer-token-1")
      .mockResolvedValueOnce("desktop-bearer-token-2");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token-1");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token-2");
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });
});
