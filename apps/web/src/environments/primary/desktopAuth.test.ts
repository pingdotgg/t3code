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

  it("shares in-flight reads but asks the main process again after they settle", async () => {
    let resolveToken!: (token: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    const getLocalEnvironmentBearerToken = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce("renewed-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    const first = readDesktopPrimaryBearerToken();
    const second = readDesktopPrimaryBearerToken();
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
    resolveToken("initial-bearer-token");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "initial-bearer-token",
      "initial-bearer-token",
    ]);

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("renewed-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2);
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });
});
