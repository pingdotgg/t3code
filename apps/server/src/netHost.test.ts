import { assert, describe, it } from "@effect/vitest";

import { isLoopbackHost, isLoopbackHostHeader, parseHostHeaderHostname } from "./netHost.ts";

describe("parseHostHeaderHostname", () => {
  it("extracts hostnames from host headers with and without ports", () => {
    assert.equal(parseHostHeaderHostname("localhost"), "localhost");
    assert.equal(parseHostHeaderHostname("localhost:13773"), "localhost");
    assert.equal(parseHostHeaderHostname("127.0.0.1:13773"), "127.0.0.1");
    assert.equal(parseHostHeaderHostname("[::1]:13773"), "[::1]");
    assert.equal(parseHostHeaderHostname("example.com:8080"), "example.com");
    assert.equal(parseHostHeaderHostname("  LOCALHOST:13773  "), "localhost");
  });

  it("returns null for missing or malformed host headers", () => {
    assert.equal(parseHostHeaderHostname(undefined), null);
    assert.equal(parseHostHeaderHostname(""), null);
    assert.equal(parseHostHeaderHostname("   "), null);
    assert.equal(parseHostHeaderHostname("exa mple.com"), null);
    assert.equal(parseHostHeaderHostname("http://example.com"), null);
  });
});

describe("isLoopbackHostHeader", () => {
  it("accepts loopback host headers, with ports and brackets", () => {
    assert.isTrue(isLoopbackHostHeader("localhost"));
    assert.isTrue(isLoopbackHostHeader("localhost:13773"));
    assert.isTrue(isLoopbackHostHeader("127.0.0.1:13773"));
    assert.isTrue(isLoopbackHostHeader("127.5.5.5"));
    assert.isTrue(isLoopbackHostHeader("127.5.5.5:8080"));
    assert.isTrue(isLoopbackHostHeader("[::1]:13773"));
    assert.isTrue(isLoopbackHostHeader("[::1]"));
  });

  it("rejects non-loopback and malformed host headers (fails closed)", () => {
    assert.isFalse(isLoopbackHostHeader("evil.example"));
    assert.isFalse(isLoopbackHostHeader("evil.example:13773"));
    assert.isFalse(isLoopbackHostHeader("localhost.evil.example"));
    assert.isFalse(isLoopbackHostHeader("127.attacker.example"));
    assert.isFalse(isLoopbackHostHeader("127.attacker.example:13773"));
    assert.isFalse(isLoopbackHostHeader("10.0.0.5:13773"));
    assert.isFalse(isLoopbackHostHeader("[::2]:13773"));
    assert.isFalse(isLoopbackHostHeader(undefined));
    assert.isFalse(isLoopbackHostHeader(""));
    assert.isFalse(isLoopbackHostHeader("exa mple.com"));
  });
});

describe("isLoopbackHost", () => {
  it("keeps the config-host semantics: undefined means loopback", () => {
    assert.isTrue(isLoopbackHost(undefined));
    assert.isTrue(isLoopbackHost(""));
    assert.isTrue(isLoopbackHost("localhost"));
    assert.isTrue(isLoopbackHost("127.0.0.1"));
    assert.isTrue(isLoopbackHost("127.99.0.1"));
    assert.isTrue(isLoopbackHost("::1"));
    assert.isTrue(isLoopbackHost("[::1]"));
    assert.isFalse(isLoopbackHost("0.0.0.0"));
    assert.isFalse(isLoopbackHost("192.168.1.10"));
  });

  it("only accepts real 127.0.0.0/8 addresses, not 127.* DNS names", () => {
    assert.isFalse(isLoopbackHost("127.attacker.example"));
    assert.isFalse(isLoopbackHost("127.0.0.999"));
    assert.isFalse(isLoopbackHost("127.0.0"));
    assert.isFalse(isLoopbackHost("127.0.0.0.1"));
    assert.isFalse(isLoopbackHost("127.0.0.-1"));
    assert.isTrue(isLoopbackHost("127.0.0.0"));
    assert.isTrue(isLoopbackHost("127.255.255.255"));
  });
});
