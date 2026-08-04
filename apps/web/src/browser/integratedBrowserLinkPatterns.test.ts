import { describe, expect, it } from "vite-plus/test";

import {
  normalizeIntegratedBrowserUrlPattern,
  parseIntegratedBrowserUrlPattern,
  urlMatchesIntegratedBrowserPatterns,
} from "./integratedBrowserLinkPatterns";

describe("parseIntegratedBrowserUrlPattern", () => {
  it("parses host-only patterns, lowercasing and stripping www", () => {
    expect(parseIntegratedBrowserUrlPattern("  GitHub.com ")).toEqual({
      host: "github.com",
      pathPrefix: null,
    });
    expect(parseIntegratedBrowserUrlPattern("www.github.com")).toEqual({
      host: "github.com",
      pathPrefix: null,
    });
  });

  it("parses path prefixes, dropping trailing slashes", () => {
    expect(parseIntegratedBrowserUrlPattern("docs.example.com/api/")).toEqual({
      host: "docs.example.com",
      pathPrefix: "/api",
    });
    expect(parseIntegratedBrowserUrlPattern("example.com/")).toEqual({
      host: "example.com",
      pathPrefix: null,
    });
    expect(parseIntegratedBrowserUrlPattern("example.com/docs/v1:api")).toEqual({
      host: "example.com",
      pathPrefix: "/docs/v1:api",
    });
  });

  it("rejects schemes, ports, whitespace, malformed hosts, and non-leading wildcards", () => {
    for (const raw of [
      "",
      "   ",
      "https://github.com",
      "github.com:8080",
      "git hub.com",
      "/just/a/path",
      "héllo.com",
      "example.com/docs?view=full",
      "example.com/docs#anchor",
      "gist*.github.com",
      "*.gist*.github.com",
      "*",
    ]) {
      expect(parseIntegratedBrowserUrlPattern(raw)).toBeNull();
    }
  });
});

describe("normalizeIntegratedBrowserUrlPattern", () => {
  it("wildcards bare domains and keeps more specific patterns as entered", () => {
    expect(normalizeIntegratedBrowserUrlPattern("github.com")).toBe("*.github.com");
    expect(normalizeIntegratedBrowserUrlPattern("GitHub.com/T3")).toBe("*.github.com/T3");
    expect(normalizeIntegratedBrowserUrlPattern("docs.example.com/api/")).toBe(
      "docs.example.com/api",
    );
    expect(normalizeIntegratedBrowserUrlPattern("*.vercel.app")).toBe("*.vercel.app");
    expect(normalizeIntegratedBrowserUrlPattern("localhost")).toBe("localhost");
    expect(normalizeIntegratedBrowserUrlPattern("https://github.com")).toBeNull();
  });
});

describe("urlMatchesIntegratedBrowserPatterns", () => {
  it("matches exact hosts case-insensitively, ignoring ports and www", () => {
    expect(urlMatchesIntegratedBrowserPatterns("https://GitHub.com/t3", ["github.com"])).toBe(true);
    expect(urlMatchesIntegratedBrowserPatterns("https://www.github.com", ["github.com"])).toBe(
      true,
    );
    expect(urlMatchesIntegratedBrowserPatterns("https://github.com", ["www.github.com"])).toBe(
      true,
    );
    expect(urlMatchesIntegratedBrowserPatterns("http://localhost:5173/x", ["localhost"])).toBe(
      true,
    );
  });

  it("matches the apex and any subdomain depth for leading wildcards", () => {
    const patterns = ["*.github.com"];
    expect(urlMatchesIntegratedBrowserPatterns("https://github.com", patterns)).toBe(true);
    expect(urlMatchesIntegratedBrowserPatterns("https://gist.github.com", patterns)).toBe(true);
    expect(urlMatchesIntegratedBrowserPatterns("https://a.b.github.com", patterns)).toBe(true);
    expect(urlMatchesIntegratedBrowserPatterns("https://notgithub.com", patterns)).toBe(false);
  });

  it("matches plain hosts exactly, without subdomains", () => {
    expect(
      urlMatchesIntegratedBrowserPatterns("https://docs.example.com", ["docs.example.com"]),
    ).toBe(true);
    expect(
      urlMatchesIntegratedBrowserPatterns("https://v2.docs.example.com", ["docs.example.com"]),
    ).toBe(false);
  });

  it("matches path prefixes on segment boundaries only", () => {
    const patterns = ["docs.example.com/api"];
    expect(urlMatchesIntegratedBrowserPatterns("https://docs.example.com/api", patterns)).toBe(
      true,
    );
    expect(urlMatchesIntegratedBrowserPatterns("https://docs.example.com/api/v2", patterns)).toBe(
      true,
    );
    expect(urlMatchesIntegratedBrowserPatterns("https://docs.example.com/api-keys", patterns)).toBe(
      false,
    );
  });

  it("never matches non-http schemes, unparseable hrefs, or invalid patterns", () => {
    expect(urlMatchesIntegratedBrowserPatterns("mailto:hi@github.com", ["github.com"])).toBe(false);
    expect(urlMatchesIntegratedBrowserPatterns("not a url", ["github.com"])).toBe(false);
    expect(
      urlMatchesIntegratedBrowserPatterns("https://github.com", ["https://github.com", "   "]),
    ).toBe(false);
  });
});
