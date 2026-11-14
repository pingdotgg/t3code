// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { describe, it } from "vitest";
import { addBasePath, stripBasePath } from "../src/utils/base-path.ts";

describe("[Asset Worker] base-path helpers", () => {
  describe("stripBasePath", () => {
    it("is the identity mapping for the root base", ({ expect }) => {
      expect(stripBasePath("/foo/bar", "/")).toEqual({
        inPrefix: true,
        assetPath: "/foo/bar",
      });
    });

    it("strips the prefix and preserves a leading slash", ({ expect }) => {
      expect(stripBasePath("/subpath/foo", "/subpath/")).toEqual({
        inPrefix: true,
        assetPath: "/foo",
      });
    });

    it("maps the base root itself to /", ({ expect }) => {
      expect(stripBasePath("/subpath", "/subpath/")).toEqual({
        inPrefix: true,
        assetPath: "/",
      });
      expect(stripBasePath("/subpath/", "/subpath/")).toEqual({
        inPrefix: true,
        assetPath: "/",
      });
    });

    it("is segment-aware and rejects sibling prefixes", ({ expect }) => {
      expect(stripBasePath("/subpath-other/foo", "/subpath/")).toEqual({
        inPrefix: false,
        assetPath: "/subpath-other/foo",
      });
    });

    it("rejects an off-prefix path", ({ expect }) => {
      expect(stripBasePath("/other", "/subpath/").inPrefix).toBe(false);
    });
  });

  describe("addBasePath", () => {
    it("is the identity mapping for the root base", ({ expect }) => {
      expect(addBasePath("/foo/", "/")).toBe("/foo/");
    });

    it("joins slashes without producing a double slash at the root", ({ expect }) => {
      expect(addBasePath("/", "/subpath/")).toBe("/subpath/");
    });

    it("prefixes an asset-relative location", ({ expect }) => {
      expect(addBasePath("/foo/", "/subpath/")).toBe("/subpath/foo/");
    });
  });
});
