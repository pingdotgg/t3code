import { describe, expect, it } from "vite-plus/test";

import {
  appendGatewayTicket,
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
} from "./endpoint.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("keeps gatewayTicket when rewriting peer paths through a LAN gateway", () => {
    const base = appendGatewayTicket(
      "https://gateway.example/__t3_gateway/env_peer/",
      "hop-ticket",
    );
    expect(base).toContain("gatewayTicket=hop-ticket");
    expect(environmentEndpointUrl(base, "/api/auth/session")).toBe(
      "https://gateway.example/api/auth/session?gatewayTicket=hop-ticket",
    );
  });
});
