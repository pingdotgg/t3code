import { describe, expect, it, vi } from "vitest";

import { resolveDesktopBackendPort } from "./backendPort";

describe("resolveDesktopBackendPort", () => {
  it("returns the starting port when it is available", async () => {
    const canListenOnHost = vi.fn(async (port: number) => port === 3773);

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        startPort: 3773,
        canListenOnHost,
      }),
    ).resolves.toBe(3773);

    expect(canListenOnHost).toHaveBeenCalledTimes(1);
    expect(canListenOnHost).toHaveBeenCalledWith(3773, "127.0.0.1");
  });

  it("increments sequentially until it finds an available port", async () => {
    const canListenOnHost = vi.fn(async (port: number) => port === 3775);

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        startPort: 3773,
        canListenOnHost,
      }),
    ).resolves.toBe(3775);

    expect(canListenOnHost.mock.calls).toEqual([
      [3773, "127.0.0.1"],
      [3774, "127.0.0.1"],
      [3775, "127.0.0.1"],
    ]);
  });

  it("fails when the scan range is exhausted", async () => {
    const canListenOnHost = vi.fn(async () => false);

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        startPort: 65534,
        maxPort: 65535,
        canListenOnHost,
      }),
    ).rejects.toThrow("No desktop backend port is available on 127.0.0.1 between 65534 and 65535");

    expect(canListenOnHost.mock.calls).toEqual([
      [65534, "127.0.0.1"],
      [65535, "127.0.0.1"],
    ]);
  });
});
