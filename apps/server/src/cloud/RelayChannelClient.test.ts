import { describe, expect, it } from "@effect/vitest";

import { forwardedRequestHeaders, localTargetUrl } from "./RelayChannelClient.ts";

describe("localTargetUrl", () => {
  it.each([
    ["a path", "/api/state?x=1", "http://127.0.0.1:3773/api/state?x=1"],
    ["an absolute URL", "http://169.254.169.254/latest", null],
    ["a protocol-relative URL", "//evil.test/x", null],
    ["a relative path", "api/state", null],
  ] as const)("maps %s", (_name, path, expected) => {
    expect(localTargetUrl("http://127.0.0.1:3773/", path)).toBe(expected);
  });
});

describe("forwardedRequestHeaders", () => {
  it("presents the public host over HTTPS and drops connection headers", () => {
    expect(
      forwardedRequestHeaders({
        host: "t3-abc.relay.test",
        connection: "upgrade",
        "sec-websocket-key": "k",
        authorization: "DPoP token",
      }),
    ).toEqual({
      host: "t3-abc.relay.test",
      authorization: "DPoP token",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "t3-abc.relay.test",
    });
  });
});
