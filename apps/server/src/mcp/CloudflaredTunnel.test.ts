import { expect, it } from "@effect/vitest";

import { makeCloudflaredUrlScanner, parseCloudflaredUrl } from "./CloudflaredTunnel.ts";

it("scrapes the quick-tunnel hostname from cloudflared output", () => {
  const banner = [
    "2026-07-29T00:00:00Z INF +--------------------------------------------------------+",
    "2026-07-29T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at:      |",
    "2026-07-29T00:00:00Z INF |  https://random-words-here-1234.trycloudflare.com      |",
    "2026-07-29T00:00:00Z INF +--------------------------------------------------------+",
  ].join("\n");
  expect(parseCloudflaredUrl(banner)).toBe("https://random-words-here-1234.trycloudflare.com");
});

it("skips the api control-plane host that shares the banner", () => {
  const line =
    "INF Requesting new quick Tunnel on trycloudflare.com... via https://api.trycloudflare.com then https://real-host.trycloudflare.com";
  expect(parseCloudflaredUrl(line)).toBe("https://real-host.trycloudflare.com");
  expect(parseCloudflaredUrl("only https://api.trycloudflare.com here")).toBeUndefined();
});

it("returns undefined for output with no tunnel URL", () => {
  expect(parseCloudflaredUrl("INF Starting tunnel")).toBeUndefined();
  expect(parseCloudflaredUrl("")).toBeUndefined();
});

it("finds a tunnel URL split across output chunks", () => {
  const scan = makeCloudflaredUrlScanner();

  expect(scan("INF Your quick Tunnel is https://split-host.trycloud")).toBeUndefined();
  expect(scan("flare.com\n")).toBe("https://split-host.trycloudflare.com");
});
