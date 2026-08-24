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

  it("reuses the main-process bearer token across renderer requests", async () => {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes the bearer token when an attachment is reconfigured", async () => {
    let bootstrapToken = "attach-one";
    const getLocalEnvironmentBearerToken = vi
      .fn()
      .mockResolvedValueOnce("desktop-bearer-one")
      .mockResolvedValueOnce("desktop-bearer-two");
    window.desktopBridge = {
      getLocalEnvironmentBootstraps: () => [
        {
          id: "primary",
          label: "Local environment",
          httpBaseUrl: "http://127.0.0.1:41773",
          wsBaseUrl: "ws://127.0.0.1:41773",
          bootstrapToken,
        },
      ],
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-one");
    bootstrapToken = "attach-two";
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-two");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2);
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });
});
