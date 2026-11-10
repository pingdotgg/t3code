import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Headers, HttpServerRequest } from "effect/http";

import { publicRequestUrl } from "./requestUrl.ts";

const relayed = (prefix: string | undefined) =>
  HttpServerRequest.fromWeb(new Request("http://relay.example.test/api/state?x=1")).modify({
    headers: Headers.fromInput({
      host: "relay.example.test",
      "x-forwarded-proto": "https",
      ...(prefix === undefined ? {} : { "x-forwarded-prefix": prefix }),
    }),
  });

describe("publicRequestUrl", () => {
  it.each([
    ["a relay prefix", "/env/abc", "https://relay.example.test/env/abc/api/state?x=1"],
    ["no prefix", undefined, "https://relay.example.test/api/state?x=1"],
    ["a protocol-relative prefix", "//evil.test", "https://relay.example.test/api/state?x=1"],
    ["a trailing slash", "/env/abc/", "https://relay.example.test/api/state?x=1"],
  ] as const)("keeps %s", (_name, prefix, expected) => {
    expect(Option.map(publicRequestUrl(relayed(prefix)), (url) => url.href)).toEqual(
      Option.some(expected),
    );
  });
});
