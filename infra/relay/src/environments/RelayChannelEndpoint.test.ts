import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { channelHostname, channelKey, channelKeyForHost } from "./RelayChannelEndpoint.ts";

const key = "0123456789abcdef0123456789abcdef";

describe("channelKeyForHost", () => {
  it.each([
    ["the channel host", `t3-${key}.relay.example.test`, key],
    ["a forwarded port and mixed case", `T3-${key.toUpperCase()}.Relay.Example.Test:443`, key],
    ["the relay's own host", "relay.example.test", null],
    ["a short key", "t3-abc.relay.example.test", null],
    ["a nested label", `x.t3-${key}.relay.example.test`, null],
    ["a lookalike domain", `t3-${key}.relay.example.test.evil.test`, null],
  ] as const)("reads %s", (_name, host, expected) => {
    expect(channelKeyForHost("t3-*.relay.example.test", host)).toBe(expected);
  });
});

describe("channelKey", () => {
  it.effect("gives each environment its own stable host label", () =>
    Effect.gen(function* () {
      const first = yield* channelKey("env-a", "key-a");
      expect(first).toMatch(/^[0-9a-f]{32}$/u);
      expect(yield* channelKey("env-a", "key-a")).toBe(first);
      expect(yield* channelKey("env-b", "key-a")).not.toBe(first);
      // Environment ids are public; another key claiming the same id gets another host.
      expect(yield* channelKey("env-a", "key-b")).not.toBe(first);
      expect(
        channelKeyForHost("t3-*.example.test", channelHostname("t3-*.example.test", first)),
      ).toBe(first);
    }),
  );
});
