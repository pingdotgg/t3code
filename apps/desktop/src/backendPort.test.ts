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

  it("treats wildcard-bound ports as unavailable even when loopback probing succeeds", async () => {
    const canListenOnHost = vi.fn(async (port: number, host: string) => {
      if (port === 3773 && host === "127.0.0.1") return true;
      if (port === 3773 && host === "0.0.0.0") return false;
      return port === 3774;
    });

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        requiredHosts: ["0.0.0.0"],
        startPort: 3773,
        canListenOnHost,
      }),
    ).resolves.toBe(3774);

    expect(canListenOnHost.mock.calls).toEqual([
      [3773, "127.0.0.1"],
      [3773, "0.0.0.0"],
      [3774, "127.0.0.1"],
      [3774, "0.0.0.0"],
    ]);
  });

  it("checks overlapping hosts sequentially to avoid self-interference", async () => {
    let inFlightCount = 0;
    const canListenOnHost = vi.fn(async (_port: number, _host: string) => {
      inFlightCount += 1;
      const overlapped = inFlightCount > 1;
      await Promise.resolve();
      inFlightCount -= 1;
      return !overlapped;
    });

    await expect(
      resolveDesktopBackendPort({
        host: "127.0.0.1",
        requiredHosts: ["0.0.0.0", "::"],
        startPort: 3773,
        maxPort: 3773,
        canListenOnHost,
      }),
    ).resolves.toBe(3773);

    expect(canListenOnHost.mock.calls).toEqual([
      [3773, "127.0.0.1"],
      [3773, "0.0.0.0"],
      [3773, "::"],
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
    ).rejects.toThrow(
      "No desktop backend port is available on hosts 127.0.0.1 between 65534 and 65535",
    );

    expect(canListenOnHost.mock.calls).toEqual([
      [65534, "127.0.0.1"],
      [65535, "127.0.0.1"],
    ]);
  });
});
