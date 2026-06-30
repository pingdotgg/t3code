import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
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
  it.effect("rejects http", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* validateWith("http://hooks.slack.com/x", ["140.82.112.3"]))._tag,
        "Failure",
      );
    }),
  );
  it.effect("rejects loopback", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://localhost/x", ["127.0.0.1"]))._tag, "Failure");
    }),
  );
  it.effect("rejects the cloud-metadata address", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* validateWith("https://metadata.internal/x", ["169.254.169.254"]))._tag,
        "Failure",
      );
    }),
  );
  it.effect("rejects private 10/8", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://internal.svc/x", ["10.1.2.3"]))._tag, "Failure");
    }),
  );
  it.effect("rejects 172.16/12 and accepts 172.32 (outside range)", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["172.16.0.1"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["172.31.255.255"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["172.32.0.1"]))._tag, "Success");
    }),
  );
  it.effect("rejects 192.168/16", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["192.168.1.1"]))._tag, "Failure");
    }),
  );
  it.effect("rejects CGNAT 100.64/10 but accepts adjacent public 100.x", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["100.64.0.1"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["100.127.255.255"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["100.63.255.255"]))._tag, "Success");
      assert.equal((yield* validateWith("https://x/y", ["100.128.0.1"]))._tag, "Success");
    }),
  );
  it.effect("rejects benchmarking 198.18/15 but accepts adjacent public 198.x", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["198.18.0.1"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["198.19.255.255"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["198.17.0.1"]))._tag, "Success");
      assert.equal((yield* validateWith("https://x/y", ["198.20.0.1"]))._tag, "Success");
    }),
  );
  it.effect("rejects documentation / protocol / 6to4 special ranges", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["192.0.0.1"]))._tag, "Failure"); // 192.0.0/24
      assert.equal((yield* validateWith("https://x/y", ["192.0.2.5"]))._tag, "Failure"); // TEST-NET-1
      assert.equal((yield* validateWith("https://x/y", ["198.51.100.5"]))._tag, "Failure"); // TEST-NET-2
      assert.equal((yield* validateWith("https://x/y", ["203.0.113.5"]))._tag, "Failure"); // TEST-NET-3
      assert.equal((yield* validateWith("https://x/y", ["192.88.99.1"]))._tag, "Failure"); // 6to4 relay
      // a neighbouring public address in the same first octet still resolves OK
      assert.equal((yield* validateWith("https://x/y", ["192.0.1.1"]))._tag, "Success");
      assert.equal((yield* validateWith("https://x/y", ["203.0.114.1"]))._tag, "Success");
    }),
  );
  it.effect("rejects multicast, reserved/future, and broadcast", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["224.0.0.1"]))._tag, "Failure"); // multicast
      assert.equal((yield* validateWith("https://x/y", ["239.255.255.255"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["240.0.0.1"]))._tag, "Failure"); // reserved
      assert.equal((yield* validateWith("https://x/y", ["255.255.255.255"]))._tag, "Failure"); // broadcast
      assert.equal((yield* validateWith("https://x/y", ["223.255.255.255"]))._tag, "Success"); // last public
    }),
  );
  it.effect("rejects IPv6 loopback + link-local + unique-local", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["::1"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["fe80::1"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["fc00::1"]))._tag, "Failure");
    }),
  );
  it.effect("rejects the full fe80::/10 link-local range (boundaries fe80/fe90/febf)", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["fe80::1"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["fe90::1"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["febf::1"]))._tag, "Failure");
    }),
  );
  it.effect("rejects the full fc00::/7 unique-local range (boundaries fc00/fdff)", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["fc00::1"]))._tag, "Failure");
      assert.equal((yield* validateWith("https://x/y", ["fdff::1"]))._tag, "Failure");
    }),
  );
  it.effect("rejects the ff00::/8 multicast range (link-local + boundaries)", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["ff02::1"]))._tag, "Failure"); // link-local all-nodes
      assert.equal((yield* validateWith("https://x/y", ["ff00::1"]))._tag, "Failure"); // boundary low
      assert.equal((yield* validateWith("https://x/y", ["ffff::1"]))._tag, "Failure"); // boundary high
    }),
  );
  it.effect("rejects IPv4-mapped IPv6 private (::ffff:10.0.0.1)", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["::ffff:10.0.0.1"]))._tag, "Failure");
    }),
  );
  it.effect("rejects IPv4-mapped IPv6 in hex/expanded/compatible form (SSRF bypass)", () =>
    Effect.gen(function* () {
      // ::ffff:7f00:1 === ::ffff:127.0.0.1 in hex-hextet form
      assert.equal((yield* validateWith("https://x/y", ["::ffff:7f00:1"]))._tag, "Failure");
      // fully-expanded IPv4-mapped loopback
      assert.equal((yield* validateWith("https://x/y", ["0:0:0:0:0:ffff:7f00:1"]))._tag, "Failure");
      // IPv4-mapped cloud-metadata (169.254.169.254 === a9fe:a9fe)
      assert.equal((yield* validateWith("https://x/y", ["::ffff:a9fe:a9fe"]))._tag, "Failure");
      // deprecated IPv4-compatible loopback
      assert.equal((yield* validateWith("https://x/y", ["::7f00:1"]))._tag, "Failure");
    }),
  );
  it.effect("rejects NAT64-embedded private/metadata IPv4 (64:ff9b::/96)", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["64:ff9b::7f00:1"]))._tag, "Failure"); // 127.0.0.1
      assert.equal((yield* validateWith("https://x/y", ["64:ff9b::a9fe:a9fe"]))._tag, "Failure"); // 169.254.169.254
    }),
  );
  it.effect("still accepts genuinely public IPv6 and public-embedded IPv4", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", ["2606:4700:4700::1111"]))._tag, "Success"); // Cloudflare
      assert.equal((yield* validateWith("https://x/y", ["::ffff:8.8.8.8"]))._tag, "Success"); // public mapped
      assert.equal((yield* validateWith("https://x/y", ["64:ff9b::808:808"]))._tag, "Success"); // NAT64 of 8.8.8.8
    }),
  );
  it.effect("rejects when ANY resolved address is private (mixed)", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* validateWith("https://x/y", ["140.82.112.3", "10.0.0.1"]))._tag,
        "Failure",
      );
    }),
  );
  it.effect("fails when the host does not resolve (empty)", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("https://x/y", []))._tag, "Failure");
    }),
  );
  it.effect("fails on a malformed URL", () =>
    Effect.gen(function* () {
      assert.equal((yield* validateWith("not a url", ["1.2.3.4"]))._tag, "Failure");
    }),
  );
});
