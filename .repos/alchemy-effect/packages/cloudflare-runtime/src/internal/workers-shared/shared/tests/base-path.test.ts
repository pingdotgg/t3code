// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { describe, it } from "vitest";
import { normalizeBasePath, normalizeUriEncodedBasePath } from "../base-path.ts";
import fixture from "../testdata/base-path-normalization.json";

describe("normalizeBasePath", () => {
  it("matches the backend normalization contract", ({ expect }) => {
    // Mirrored from pkg/workers-pipelines/assets/testdata/base_path_normalization.json
    // in edgeworker-config-service. Keep both copies synchronized.
    expect(fixture.contractVersion).toBe(1);
    for (const testCase of fixture.cases) {
      const result = normalizeBasePath(testCase.input);
      expect(result.valid, testCase.name).toBe(testCase.valid);
      if (result.valid && testCase.valid) {
        expect(result.value, testCase.name).toBe(testCase.canonical);
      }
    }
  });

  describe("valid values", () => {
    it("accepts the root as-is", ({ expect }) => {
      expect(normalizeBasePath("/")).toEqual({ valid: true, value: "/" });
    });

    it("accepts a single absolute segment", ({ expect }) => {
      expect(normalizeBasePath("/subpath")).toEqual({
        valid: true,
        value: "/subpath/",
      });
    });

    it("accepts nested segments", ({ expect }) => {
      expect(normalizeBasePath("/a/b/c")).toEqual({
        valid: true,
        value: "/a/b/c/",
      });
    });

    it("interprets relative inputs as fixed root-relative prefixes", ({ expect }) => {
      expect(normalizeBasePath("subpath")).toEqual({
        valid: true,
        value: "/subpath/",
      });
      expect(normalizeBasePath("./subpath")).toEqual({
        valid: true,
        value: "/subpath/",
      });
    });

    it("normalizes empty and dot segments", ({ expect }) => {
      expect(normalizeBasePath("/a//b")).toEqual({
        valid: true,
        value: "/a/b/",
      });
      expect(normalizeBasePath("/a/./b/../c")).toEqual({
        valid: true,
        value: "/a/c/",
      });
      expect(normalizeBasePath("../app")).toEqual({
        valid: true,
        value: "/app/",
      });
    });

    it("preserves a single trailing slash in the canonical form", ({ expect }) => {
      expect(normalizeBasePath("/subpath/")).toEqual({
        valid: true,
        value: "/subpath/",
      });
    });

    it("allows Unicode pathname characters", ({ expect }) => {
      expect(normalizeBasePath("/café/naïve")).toEqual({
        valid: true,
        value: "/café/naïve/",
      });
    });

    it("accepts long values", ({ expect }) => {
      const longValue = "/" + "a".repeat(2000);
      expect(normalizeBasePath(longValue)).toEqual({
        valid: true,
        value: `${longValue}/`,
      });
    });

    it("accepts long Unicode values", ({ expect }) => {
      const longValue = "/" + "😀".repeat(2000);
      expect(normalizeBasePath(longValue)).toEqual({
        valid: true,
        value: `${longValue}/`,
      });
    });
  });

  describe("invalid values", () => {
    it("rejects non-string values", ({ expect }) => {
      expect(normalizeBasePath(123)).toMatchObject({ valid: false });
      expect(normalizeBasePath(null)).toMatchObject({ valid: false });
      expect(normalizeBasePath(undefined)).toMatchObject({ valid: false });
      expect(normalizeBasePath({})).toMatchObject({ valid: false });
    });

    it("rejects an empty string", ({ expect }) => {
      expect(normalizeBasePath("")).toMatchObject({ valid: false });
    });

    it("rejects backslashes", ({ expect }) => {
      expect(normalizeBasePath("/sub\\path")).toMatchObject({ valid: false });
    });

    it("rejects control characters", ({ expect }) => {
      expect(normalizeBasePath("/sub\u0000path")).toMatchObject({
        valid: false,
      });
      expect(normalizeBasePath("/sub\u007fpath")).toMatchObject({
        valid: false,
      });
    });

    it("rejects query strings and fragments", ({ expect }) => {
      expect(normalizeBasePath("/subpath?a=1")).toMatchObject({
        valid: false,
      });
      expect(normalizeBasePath("/subpath#frag")).toMatchObject({
        valid: false,
      });
    });

    it("rejects percent-encoded sequences", ({ expect }) => {
      expect(normalizeBasePath("/sub%2Fpath")).toMatchObject({ valid: false });
      expect(normalizeBasePath("/sub%20path")).toMatchObject({ valid: false });
    });

    it("rejects URL-shaped values", ({ expect }) => {
      expect(normalizeBasePath("//a")).toMatchObject({ valid: false });
      expect(normalizeBasePath("https://example.com/subpath")).toMatchObject({
        valid: false,
      });
      expect(normalizeBasePath("data:text/plain,hello")).toMatchObject({
        valid: false,
      });
    });
  });
});

describe("normalizeUriEncodedBasePath", () => {
  it("decodes URI-encoded pathname characters before normalization", ({ expect }) => {
    expect(normalizeUriEncodedBasePath("/caf%C3%A9/na%C3%AFve")).toEqual({
      valid: true,
      value: "/café/naïve/",
    });
  });

  it("rejects encoded path separators", ({ expect }) => {
    expect(normalizeUriEncodedBasePath("/sub%2Fpath")).toMatchObject({
      valid: false,
    });
  });

  it("rejects characters that become invalid after decoding", ({ expect }) => {
    expect(normalizeUriEncodedBasePath("/sub%5Cpath")).toMatchObject({
      valid: false,
    });
    expect(normalizeUriEncodedBasePath("/sub%00path")).toMatchObject({
      valid: false,
    });
  });

  it("rejects malformed URI encoding", ({ expect }) => {
    expect(normalizeUriEncodedBasePath("/sub%ZZpath")).toEqual({
      valid: false,
      error: "The value contains malformed URI encoding.",
    });
  });
});
