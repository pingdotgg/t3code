import { describe, expect, it } from "vite-plus/test";

import { deriveWsBaseUrl, environmentEndpointUrl, normalizeHttpBaseUrl } from "./endpoint.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });
});

describe("environmentEndpointUrl", () => {
  it("resolves server paths below an environment's base path", () => {
    expect(
      environmentEndpointUrl(
        "http://host.test:3773/sandbox/worker-1/",
        "/.well-known/t3/environment",
      ),
    ).toBe("http://host.test:3773/sandbox/worker-1/.well-known/t3/environment");
  });

  it.each([
    ["https://example.com", "https://example.com/oauth/token"],
    ["https://example.com/?token=1#x", "https://example.com/oauth/token"],
    // Only a directory counts as a base path, as in relative URL resolution.
    ["https://example.com/pair", "https://example.com/oauth/token"],
  ])("keeps root environments at the root: %s", (base, expected) => {
    expect(environmentEndpointUrl(base, "/oauth/token")).toBe(expected);
  });
});
