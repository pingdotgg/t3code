import { describe, expect, it } from "vitest";

import { readTailnetInfo } from "./tailnetInfo.ts";

describe("readTailnetInfo", () => {
  it("returns unavailable when the tailscale binary is missing", async () => {
    const info = await readTailnetInfo(() => {
      const error = Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" });
      return Promise.reject(error);
    });

    expect(info).toEqual({
      available: false,
      connected: false,
      hostname: null,
      ipv4: null,
      error: null,
    });
  });

  it("returns an error when tailscale exists but fails for another reason", async () => {
    const info = await readTailnetInfo(() => Promise.reject(new Error("permission denied")));

    expect(info.available).toBe(true);
    expect(info.connected).toBe(false);
    expect(info.error).toMatch(/permission denied/);
  });

  it("parses a connected status with DNS and IPv4", async () => {
    const info = await readTailnetInfo(() =>
      Promise.resolve(
        JSON.stringify({
          BackendState: "Running",
          Self: {
            DNSName: "macbook.tail-scales.ts.net.",
            Online: true,
            TailscaleIPs: ["100.64.1.5", "fd7a:115c:a1e0::1"],
          },
        }),
      ),
    );

    expect(info).toEqual({
      available: true,
      connected: true,
      hostname: "macbook.tail-scales.ts.net",
      ipv4: "100.64.1.5",
      error: null,
    });
  });

  it("reports disconnected when BackendState is stopped and no tailnet IPs exist", async () => {
    const info = await readTailnetInfo(() =>
      Promise.resolve(
        JSON.stringify({
          BackendState: "Stopped",
          Self: {
            DNSName: "offline.ts.net.",
            Online: false,
            TailscaleIPs: [],
          },
        }),
      ),
    );

    expect(info.connected).toBe(false);
    expect(info.hostname).toBe("offline.ts.net");
    expect(info.ipv4).toBeNull();
  });

  it("returns an error for unparseable JSON", async () => {
    const info = await readTailnetInfo(() => Promise.resolve("not-json"));

    expect(info.available).toBe(true);
    expect(info.error).toMatch(/unparseable JSON/);
  });
});
