import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  gatewayPeerHttpBaseUrl,
  normalizeHttpBaseUrl,
  withGatewayTicket,
} from "./endpoint.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("keeps a LAN gateway peer prefix when normalizing base URLs", () => {
    const peer = EnvironmentId.make("env_peer");
    expect(
      normalizeHttpBaseUrl(`https://gateway.example/__t3_gateway/${peer}/api/auth/session?x=1`),
    ).toBe(`https://gateway.example/__t3_gateway/${peer}/`);
    expect(deriveWsBaseUrl(`https://gateway.example/__t3_gateway/${peer}/`)).toBe(
      `wss://gateway.example/__t3_gateway/${peer}/`,
    );
    expect(gatewayPeerHttpBaseUrl("https://gateway.example/path", peer)).toBe(
      `https://gateway.example/__t3_gateway/${peer}/`,
    );
  });

  it("keeps a LAN gateway's peer prefix but never its ticket when rewriting paths", () => {
    const base = withGatewayTicket(
      "https://gateway.example/__t3_gateway/env_peer/",
      Option.some("hop-ticket"),
    );
    expect(base).toContain("gatewayTicket=hop-ticket");
    expect(environmentEndpointUrl(base, "/api/auth/session")).toBe(
      "https://gateway.example/__t3_gateway/env_peer/api/auth/session",
    );
    expect(environmentEndpointUrl("https://example.com/other/", "/api/auth/session")).toBe(
      "https://example.com/api/auth/session",
    );
  });

  it("adds a gateway ticket to server-relative URLs without making them absolute", () => {
    expect(withGatewayTicket("/api/assets/token/a.png?v=1", Option.some("hop"))).toBe(
      "/api/assets/token/a.png?v=1&gatewayTicket=hop",
    );
    expect(withGatewayTicket("/api/assets/token/a.png", Option.none())).toBe(
      "/api/assets/token/a.png",
    );
  });
});
