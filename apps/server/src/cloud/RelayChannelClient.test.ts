import { describe, expect, it } from "@effect/vitest";

import { localTargetUrl } from "./RelayChannelClient.ts";

describe("localTargetUrl", () => {
  it.each([
    ["an origin-relative path", "/ws?wsTicket=a", "http://127.0.0.1:3773/ws?wsTicket=a"],
    ["a protocol-relative path", "//evil.test/x", null],
    ["a relative path", "ws", null],
    // The WebSocket constructor throws on a fragment, inside the channel's message listener.
    ["a fragment", "/ws?a#b", null],
  ] as const)("maps %s", (_name, path, expected) => {
    expect(localTargetUrl("http://127.0.0.1:3773/", path)).toBe(expected);
  });
});
