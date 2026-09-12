import { describe, expect, it } from "vite-plus/test";

import { relayPublicRequestUrl } from "./publicRequestUrl.ts";

describe("relayPublicRequestUrl", () => {
  it("prefers the absolute URL supplied by the trusted edge Worker", () => {
    expect(
      relayPublicRequestUrl({
        url: "/echo?source=canary",
        source: {},
        forwardedUrl: "https://endpoint.example/echo?source=canary",
      }),
    ).toBe("https://endpoint.example/echo?source=canary");
  });

  it("preserves the absolute Web Request URL across the Durable Object boundary", () => {
    expect(
      relayPublicRequestUrl({
        url: "/echo?source=canary",
        source: new Request("https://endpoint.example/echo?source=canary"),
      }),
    ).toBe("https://endpoint.example/echo?source=canary");
  });

  it("falls back to the Effect request URL for non-Web request sources", () => {
    expect(relayPublicRequestUrl({ url: "/health", source: {} })).toBe("/health");
  });
});
