// @effect-diagnostics nodeBuiltinImport:off - Checks that every referenced asset exists on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  resolveBrandAssetPaths,
  STANDALONE_ANDROID_ASSETS,
  STANDALONE_DMG_BACKGROUND_SVG,
} from "./brand-assets.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");

describe("resolveBrandAssetPaths", () => {
  it("keeps the upstream artwork unless the build is standalone", () => {
    for (const env of [{}, { T3CODE_STANDALONE: "0" }, { T3CODE_STANDALONE: "" }]) {
      const paths = resolveBrandAssetPaths(env);
      expect(paths.productionMacIconPng).toBe("assets/prod/black-macos-1024.png");
      expect(paths.nightlyIconComposerProject).toBe("assets/nightly/app-icon.icon");
    }
  });

  it("points production and nightly at assets/easydev, leaving development alone", () => {
    for (const flag of ["1", "true", " TRUE "]) {
      const paths = resolveBrandAssetPaths({ T3CODE_STANDALONE: flag });
      for (const [key, value] of Object.entries(paths)) {
        expect(value.startsWith("assets/easydev/"), key).toBe(!key.startsWith("development"));
      }
    }
  });

  it("references only files that exist", () => {
    const paths = [
      ...Object.values(resolveBrandAssetPaths({ T3CODE_STANDALONE: "1" })),
      ...Object.values(STANDALONE_ANDROID_ASSETS).filter((value) => value.startsWith("assets/")),
      STANDALONE_DMG_BACKGROUND_SVG,
    ];
    expect(paths.filter((path) => !NodeFS.existsSync(NodePath.join(REPO_ROOT, path)))).toEqual([]);
  });
});
