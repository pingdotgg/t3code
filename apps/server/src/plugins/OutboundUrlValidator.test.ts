import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { OutboundUrlValidator } from "./OutboundUrlValidator.ts";

const validateWith = (url: string, addrs: ReadonlyArray<string>) =>
  Effect.exit(OutboundUrlValidator.validate(url, { lookup: () => Effect.succeed(addrs) }));

describe("OutboundUrlValidator", () => {
  it.effect("accepts a public https host", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* validateWith("https://hooks.slack.com/services/x", ["140.82.112.3"]))._tag,
        "Success",
      );
    }),
  );

  it.effect("rejects non-https by default", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* validateWith("http://hooks.slack.com/x", ["140.82.112.3"]))._tag,
        "Failure",
      );
    }),
  );

  it.effect("blocks private, loopback, link-local, metadata, ULA, and CGNAT addresses", () =>
    Effect.gen(function* () {
      for (const addr of [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "100.127.255.255",
        "::1",
        "fe80::1",
        "fec0::1",
        "feff::1",
        "fc00::1",
        "fdff::1",
      ]) {
        assert.equal((yield* validateWith("https://x.test/y", [addr]))._tag, "Failure", addr);
      }
    }),
  );

  it.effect("blocks special-use IPv4 ranges but accepts neighboring public ranges", () =>
    Effect.gen(function* () {
      for (const addr of [
        "0.0.0.0",
        "192.0.0.1",
        "192.0.2.5",
        "192.88.99.1",
        "198.18.0.1",
        "198.19.255.255",
        "198.51.100.5",
        "203.0.113.5",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
      ]) {
        assert.equal((yield* validateWith("https://x.test/y", [addr]))._tag, "Failure", addr);
      }
      for (const addr of ["100.63.255.255", "100.128.0.1", "172.32.0.1", "198.20.0.1"]) {
        assert.equal((yield* validateWith("https://x.test/y", [addr]))._tag, "Success", addr);
      }
    }),
  );

  it.effect(
    "blocks IPv4-mapped IPv6, NAT64, 6to4, decimal IPv4, octal IPv4, and mixed answers",
    () =>
      Effect.gen(function* () {
        for (const [url, addr] of [
          ["https://x.test/y", "::ffff:10.0.0.1"],
          ["https://x.test/y", "::ffff:7f00:1"],
          ["https://x.test/y", "0:0:0:0:0:ffff:7f00:1"],
          ["https://x.test/y", "::7f00:1"],
          ["https://x.test/y", "64:ff9b::7f00:1"],
          // RFC 8215 local-use NAT64 (64:ff9b:1::/48). The /96-style offset AND a
          // different one: inside a /48 the operator chooses where the IPv4 embeds,
          // so the whole prefix must be blocked, not one embedding. The first of
          // these wraps 10.0.0.1 and passed validation before.
          ["https://x.test/y", "64:ff9b:1::a00:1"],
          ["https://x.test/y", "64:ff9b:1:a00:0:100::"],
          ["https://x.test/y", "2002:7f00:1::"],
          ["https://2130706433/y", "127.0.0.1"],
          ["https://0177.0.0.1/y", "127.0.0.1"],
        ] as const) {
          assert.equal((yield* validateWith(url, [addr]))._tag, "Failure", `${url} -> ${addr}`);
        }
        assert.equal(
          (yield* validateWith("https://x.test/y", ["140.82.112.3", "10.0.0.1"]))._tag,
          "Failure",
        );
      }),
  );

  it.effect("resolves IPv6-literal URLs through the unbracketed lookup host", () =>
    Effect.gen(function* () {
      // URL.hostname keeps the brackets for an IPv6 literal ([2606:...]), but
      // dns.lookup only short-circuits the bare literal — so without stripping
      // them defaultLookup fails closed on every IPv6-literal target.
      const publicLiteral = yield* Effect.exit(
        OutboundUrlValidator.validate("https://[2606:4700:4700::1111]/x"),
      );
      assert.equal(publicLiteral._tag, "Success");

      // The literal still gets validated: a loopback literal is blocked, not merely
      // unreachable — so the failure names a disallowed address, not a DNS error.
      const loopbackError = yield* OutboundUrlValidator.validate("https://[::1]/x").pipe(
        Effect.flip,
      );
      assert.include(loopbackError.reason, "disallowed");
    }),
  );

  it.effect("allows http only for loopback when explicitly enabled for plugin development", () =>
    Effect.gen(function* () {
      const allowed = yield* Effect.exit(
        OutboundUrlValidator.validate("http://localhost:5173/x", {
          lookup: () => Effect.succeed(["127.0.0.1"]),
          allowHttpLoopback: true,
        }),
      );
      const rejected = yield* Effect.exit(
        OutboundUrlValidator.validate("http://example.test/x", {
          lookup: () => Effect.succeed(["140.82.112.3"]),
          allowHttpLoopback: true,
        }),
      );

      assert.equal(allowed._tag, "Success");
      assert.equal(rejected._tag, "Failure");
    }),
  );
});
