import { describe, expect, it } from "@effect/vitest";

import { cookieScope } from "./ChromiumCookies.ts";

describe("cookieScope", () => {
  it("keeps a host-only cookie host-only", () => {
    // Chromium stores a host-only cookie without a leading dot. Passing any
    // `domain` to Electron makes it a domain cookie and re-adds the dot, which
    // would expose the cookie to every subdomain it was never scoped to.
    expect(cookieScope("example.test", "/", true)).toEqual({
      url: "https://example.test/",
      domain: undefined,
    });
  });

  it("preserves a domain cookie's leading dot", () => {
    expect(cookieScope(".example.test", "/app", true)).toEqual({
      url: "https://example.test/app",
      domain: ".example.test",
    });
  });

  it("matches the scheme to the secure flag", () => {
    expect(cookieScope("example.test", "/", false).url).toBe("http://example.test/");
  });
});
