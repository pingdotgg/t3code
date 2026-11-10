import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { channelEndpoint, channelKey, channelPathTarget } from "./RelayChannelEndpoint.ts";

const key = "0123456789abcdef0123456789abcdef";

describe("channelPathTarget", () => {
  it.each([
    [
      "a nested path",
      `/env/${key}/api/state?x=1`,
      { key, prefix: `/env/${key}`, path: "/api/state?x=1" },
    ],
    ["the bare prefix", `/env/${key}`, { key, prefix: `/env/${key}`, path: "/" }],
    [
      "a query on the prefix",
      `/env/${key}?ticket=t`,
      { key, prefix: `/env/${key}`, path: "/?ticket=t" },
    ],
    ["a relay route", "/v1/environments/env-1/connect", null],
    ["a short key", "/env/abc/ws", null],
    ["a longer segment", `/env/${key}0/ws`, null],
  ] as const)("reads %s", (_name, url, expected) => {
    expect(channelPathTarget(url)).toEqual(expected);
  });
});

describe("channelKey", () => {
  it.effect("gives each environment key its own stable path", () =>
    Effect.gen(function* () {
      const first = yield* channelKey("env-a", "key-a");
      expect(first).toMatch(/^[0-9a-f]{32}$/u);
      expect(yield* channelKey("env-a", "key-a")).toBe(first);
      expect(yield* channelKey("env-b", "key-a")).not.toBe(first);
      // Environment ids are public; another key claiming the same id gets another path.
      expect(yield* channelKey("env-a", "key-b")).not.toBe(first);
      expect(channelEndpoint("https://relay.example.test", first)).toEqual({
        httpBaseUrl: `https://relay.example.test/env/${first}/`,
        wsBaseUrl: `wss://relay.example.test/env/${first}/ws`,
        providerKind: "t3_relay",
      });
    }),
  );
});
