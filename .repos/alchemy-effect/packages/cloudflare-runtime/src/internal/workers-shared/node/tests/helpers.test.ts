// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, it } from "vitest";
import { createAssetsIgnoreFunction, getContentType } from "../helpers.ts";

describe("assets", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "wrangler-tests"));
  const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  const makeAssetsIgnore = createAssetsIgnoreFunction(tmpDir).pipe(
    Effect.provide(platform),
  );

  describe(".assetsignore", () => {
    it("should ignore metafiles by default", async ({ expect }) => {
      const { assetsIgnoreFunction } =
        await Effect.runPromise(makeAssetsIgnore);

      expect(assetsIgnoreFunction(".assetsignore")).toBeTruthy();
      expect(assetsIgnoreFunction("_redirects")).toBeTruthy();
      expect(assetsIgnoreFunction("_headers")).toBeTruthy();

      // don't ignore metafiles in child directories
      expect(assetsIgnoreFunction(join("child", ".assetsignore"))).toBeFalsy();
      expect(assetsIgnoreFunction(join("child", "_redirects"))).toBeFalsy();
      expect(assetsIgnoreFunction(join("child", "_headers"))).toBeFalsy();
    });

    it("should allow users to force opt-in metafiles", async ({ expect }) => {
      await writeFile(
        join(tmpDir, "./.assetsignore"),
        "!.assetsignore\n!_redirects\n!_headers",
      );
      const { assetsIgnoreFunction } =
        await Effect.runPromise(makeAssetsIgnore);

      expect(assetsIgnoreFunction(".assetsignore")).toBeFalsy();
      expect(assetsIgnoreFunction("_redirects")).toBeFalsy();
      expect(assetsIgnoreFunction("_headers")).toBeFalsy();
    });

    it("should allow users to ignore files", async ({ expect }) => {
      await writeFile(
        join(tmpDir, "./.assetsignore"),
        "logo.png\nchild/**/*.svg\n!child/nope.svg\n/*.js",
      );
      const { assetsIgnoreFunction } =
        await Effect.runPromise(makeAssetsIgnore);

      expect(assetsIgnoreFunction("abc")).toBeFalsy();
      expect(assetsIgnoreFunction("logo.png")).toBeTruthy();
      expect(assetsIgnoreFunction(join("child", "logo.png"))).toBeTruthy();
      expect(assetsIgnoreFunction("foo.js")).toBeTruthy();
      expect(assetsIgnoreFunction(join("child", "foo.js"))).toBeFalsy();
      expect(assetsIgnoreFunction(join("child", "yup.svg"))).toBeTruthy();
      expect(
        assetsIgnoreFunction(join("child", "a", "b", "c", "yup.svg")),
      ).toBeTruthy();
      expect(assetsIgnoreFunction(join("child", "nope.svg"))).toBeFalsy();
    });
  });
});

describe("getContentType", () => {
  it("should return 'text/javascript", ({ expect }) => {
    const contentType = getContentType("/_astro/sponsors.CIiPz7eJ.js");
    expect(contentType).toBe("text/javascript; charset=utf-8");
  });
});
