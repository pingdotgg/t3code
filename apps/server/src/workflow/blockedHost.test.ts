import { describe, expect, it } from "@effect/vitest";

import { isBlockedHost } from "./blockedHost.ts";

describe("isBlockedHost", () => {
  it("blocks loopback, link-local, metadata, and private hosts", () => {
    const blocked = [
      "localhost",
      "127.0.0.1",
      "169.254.169.254",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "::1",
      "metadata.google.internal",
      // Absolute-FQDN trailing dot (resolves to loopback, must not slip past).
      "localhost.",
      "127.0.0.1.",
      // IPv4-mapped IPv6 — the plain input form…
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      // …and the exact normalized form Node's URL parser emits (with brackets,
      // embedded IPv4 in hex) for `http://[::ffff:169.254.169.254]/`.
      "[::ffff:7f00:1]",
      "[::ffff:a9fe:a9fe]",
      // IPv6 unique-local / link-local LITERALS (contain a colon) stay blocked.
      "fc00::1",
      "fd00::1",
      "fe80::1",
    ];
    for (const host of blocked) {
      expect(isBlockedHost(host), `${host} should be blocked`).toBe(true);
    }
  });

  it("allows ordinary public hosts (including 172.32/8 just outside RFC1918)", () => {
    const allowed = [
      "acme.atlassian.net",
      "jira.mycompany.com",
      "172.32.0.1",
      "8.8.8.8",
      // DNS names that merely START with fc/fd/fe8.. must NOT be blocked — only
      // IPv6 literals (which contain a colon) are. Regression guard for the
      // colon-gate on the IPv6 unique-local / link-local checks.
      "fdic.gov",
      "fd-corp.com",
      "fcgroup.com",
      "february.example.com",
    ];
    for (const host of allowed) {
      expect(isBlockedHost(host), `${host} should be allowed`).toBe(false);
    }
  });
});
