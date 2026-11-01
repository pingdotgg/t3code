import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopAppControlAddress } from "./desktopAppControl.ts";

describe("resolveDesktopAppControlAddress", () => {
  it.each([
    ["linux", "/tmp", "/tmp/t3code-1000", 107],
    ["linux", "/var/tmp/custom", "/var/tmp/custom/t3code-1000", 107],
    ["linux", `/tmp/${"x".repeat(120)}`, "/tmp/t3code-1000", 107],
    ["darwin", `/tmp/${"é".repeat(30)}`, "/tmp/t3code-1000", 103],
    ["darwin", `/tmp/${"x".repeat(56)}`, `/tmp/${"x".repeat(56)}/t3code-1000`, 103],
  ] as const)("keeps %s sockets short under %s", (platform, tempDir, directory, maxBytes) => {
    const first = resolveDesktopAppControlAddress({
      stateDir: `/home/user/${"long/".repeat(40)}userdata`,
      platform,
      tempDir,
      userId: 1000,
      joinPath: (...segments) => segments.join("/"),
    });
    const second = resolveDesktopAppControlAddress({
      stateDir: "/home/user/.t3/other/userdata",
      platform,
      tempDir,
      userId: 1000,
      joinPath: (...segments) => segments.join("/"),
    });

    expect(new TextEncoder().encode(first.address).byteLength).toBeLessThanOrEqual(maxBytes);
    expect(first.directory).toBe(directory);
    expect(first.address).not.toBe(second.address);
  });

  it("uses a Windows named pipe", () => {
    const result = resolveDesktopAppControlAddress({
      stateDir: "C:\\Users\\user\\.t3\\userdata",
      platform: "win32",
      tempDir: "C:\\Temp",
      userId: undefined,
      joinPath: (...segments) => segments.join("\\"),
    });

    expect(result.directory).toBeNull();
    expect(result.address).toMatch(/^\\\\\.\\pipe\\t3code-app-[a-f0-9]{24}$/);
  });
});
