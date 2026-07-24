import { expect, it } from "@effect/vitest";

import {
  isCanonicalLoopbackHostname,
  isValidLocalServerPairingUrl,
  parseCanonicalLoopbackHttpBaseUrl,
} from "./localServerDiscovery.ts";

it("accepts canonical IPv4 and IPv6 loopback hosts", () => {
  expect(isCanonicalLoopbackHostname("127.0.0.1")).toBe(true);
  expect(isCanonicalLoopbackHostname("127.12.34.56")).toBe(true);
  expect(isCanonicalLoopbackHostname("::1")).toBe(true);
  expect(isCanonicalLoopbackHostname("localhost")).toBe(false);
  expect(isCanonicalLoopbackHostname("127.00.0.1")).toBe(false);
  expect(isCanonicalLoopbackHostname("192.168.1.2")).toBe(false);
});

it("accepts only normalized loopback HTTP base URLs", () => {
  expect(parseCanonicalLoopbackHttpBaseUrl("http://127.0.0.1:3773/")?.origin).toBe(
    "http://127.0.0.1:3773",
  );
  expect(parseCanonicalLoopbackHttpBaseUrl("http://[::1]:3773/")?.hostname).toBe("[::1]");
  expect(parseCanonicalLoopbackHttpBaseUrl("http://localhost:3773/")).toBeNull();
  expect(parseCanonicalLoopbackHttpBaseUrl("https://127.0.0.1:3773/")).toBeNull();
  expect(parseCanonicalLoopbackHttpBaseUrl("http://127.0.0.1:3773/path")).toBeNull();
  expect(parseCanonicalLoopbackHttpBaseUrl("http://127.0.0.1/")).toBeNull();
});

it("requires a same-origin pairing URL with a non-empty fragment token", () => {
  const httpBaseUrl = new URL("http://127.0.0.1:3773/");
  expect(
    isValidLocalServerPairingUrl({
      httpBaseUrl,
      pairingUrl: "http://127.0.0.1:3773/pair#token=PAIRCODE",
    }),
  ).toBe(true);
  expect(
    isValidLocalServerPairingUrl({
      httpBaseUrl,
      pairingUrl: "http://127.0.0.1:3774/pair#token=PAIRCODE",
    }),
  ).toBe(false);
  expect(
    isValidLocalServerPairingUrl({
      httpBaseUrl,
      pairingUrl: "http://127.0.0.1:3773/pair",
    }),
  ).toBe(false);
});
