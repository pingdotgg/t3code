import { describe, expect, it } from "vitest";

import {
  resolveServerHttpOriginFromInput,
  resolveServerWsUrlFromInput,
} from "./serverConnection";

const localhostLocation = {
  protocol: "http:",
  hostname: "localhost",
  port: "5733",
  origin: "http://localhost:5733",
} as const;

describe("serverConnection", () => {
  it("prefers the desktop bridge websocket URL", () => {
    expect(
      resolveServerWsUrlFromInput({
        bridgeWsUrl: "ws://127.0.0.1:4444?token=abc",
        envWsUrl: "ws://localhost:3773",
        isDev: true,
        location: localhostLocation,
      }),
    ).toBe("ws://127.0.0.1:4444?token=abc");
  });

  it("uses the configured env websocket URL when available", () => {
    expect(
      resolveServerWsUrlFromInput({
        envWsUrl: "ws://localhost:3773",
        isDev: true,
        location: localhostLocation,
      }),
    ).toBe("ws://localhost:3773");
  });

  it("infers the paired dev server websocket port when env wiring is missing", () => {
    expect(
      resolveServerWsUrlFromInput({
        isDev: true,
        location: localhostLocation,
      }),
    ).toBe("ws://localhost:3773");
  });

  it("falls back to same-origin websocket outside paired localhost dev mode", () => {
    expect(
      resolveServerWsUrlFromInput({
        isDev: false,
        location: {
          protocol: "https:",
          hostname: "example.com",
          port: "443",
          origin: "https://example.com",
        },
      }),
    ).toBe("wss://example.com:443");
  });

  it("converts the resolved websocket URL into the matching http origin", () => {
    expect(
      resolveServerHttpOriginFromInput({
        isDev: true,
        location: localhostLocation,
      }),
    ).toBe("http://localhost:3773");
  });
});
