import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Headers, HttpServerRequest } from "effect/http";

import { publicRequestUrl } from "./requestUrl.ts";

const relayed = (prefix: string | undefined, forwardedHost?: string) =>
  HttpServerRequest.fromWeb(new Request("http://relay.example.test/api/state?x=1")).modify({
    headers: Headers.fromInput({
      // A channel's WebSocket reaches the server with its local address as Host.
      host: forwardedHost === undefined ? "relay.example.test" : "127.0.0.1:3773",
      "x-forwarded-proto": "https",
      ...(prefix === undefined ? {} : { "x-forwarded-prefix": prefix }),
      ...(forwardedHost === undefined ? {} : { "x-forwarded-host": forwardedHost }),
    }),
  });

describe("publicRequestUrl", () => {
  it.each([
    ["a relay prefix", "/env/abc", undefined, "https://relay.example.test/env/abc/api/state?x=1"],
    ["no prefix", undefined, undefined, "https://relay.example.test/api/state?x=1"],
    [
      "a protocol-relative prefix",
      "//evil.test",
      undefined,
      "https://relay.example.test/api/state?x=1",
    ],
    ["a trailing slash", "/env/abc/", undefined, "https://relay.example.test/api/state?x=1"],
    [
      "the relay's host",
      "/env/abc",
      "relay.example.test",
      "https://relay.example.test/env/abc/api/state?x=1",
    ],
    [
      "a local host without a prefix",
      undefined,
      "evil.test",
      "https://127.0.0.1:3773/api/state?x=1",
    ],
    [
      "a local host for a malformed host",
      "/env/abc",
      "evil.test/x",
      "https://127.0.0.1:3773/env/abc/api/state?x=1",
    ],
  ] as const)("keeps %s", (_name, prefix, forwardedHost, expected) => {
    expect(Option.map(publicRequestUrl(relayed(prefix, forwardedHost)), (url) => url.href)).toEqual(
      Option.some(expected),
    );
  });
});
