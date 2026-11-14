import { describe, expect, it } from "vite-plus/test";

import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
  resolveEnvironmentUrl,
} from "./endpoint.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it.each([
    [
      "a root base",
      "https://host.test/",
      "/api/assets/a.png?s=1",
      "https://host.test/api/assets/a.png?s=1",
    ],
    [
      "a relay channel base",
      "https://relay.test/env/abc/",
      "/api/assets/a.png?s=1",
      "https://relay.test/env/abc/api/assets/a.png?s=1",
    ],
    [
      "an absolute target",
      "https://relay.test/env/abc/",
      "https://cdn.test/x",
      "https://cdn.test/x",
    ],
    [
      "a protocol-relative target",
      "https://relay.test/env/abc/",
      "//cdn.test/x",
      "https://cdn.test/x",
    ],
  ])("resolves environment paths under %s", (_name, base, target, expected) => {
    expect(resolveEnvironmentUrl(base, target).href).toBe(expected);
  });

  it("keeps a relay prefix on endpoint URLs and drops the base query", () => {
    expect(environmentEndpointUrl("https://relay.test/env/abc/?x=1", "/oauth/token")).toBe(
      "https://relay.test/env/abc/oauth/token",
    );
  });
});
